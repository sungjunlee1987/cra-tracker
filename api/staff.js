import { createSign } from 'crypto';

function normalizeRole(role) {
  if (!role) return 'Other';
  const r = role.toLowerCase();
  if (r.includes('principal') || r === 'pi') return 'PI';
  if (r.includes('sub-inv') || r.includes('sub inv') || r === 'si' || r === 'sub-i') return 'Sub-I';
  if (r.includes('study coord') || r.includes('coord') || r === 'sc') return 'SC';
  if (r.includes('pharm')) return 'Pharmacist';
  if (r.includes('lab')) return 'Lab technician';
  if (r.includes('nurs') || r.includes('infus')) return 'Infusion nurse';
  if (r.includes('crc')) return 'CRC';
  return role;
}

function normalizeName(name) {
  return name?.toLowerCase().replace(/\s+/g, ' ').trim() || '';
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) => Array.from({length: n+1}, (_, j) => i===0?j:j===0?i:0));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++) dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function isSamePerson(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (na === nb) return true;
  return levenshtein(na, nb) <= 2;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { rows, mergeDecisions = {} } = req.body;
    // mergeDecisions: { "New Name||Existing Name": true/false }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!sheetId || !rawKey) throw new Error('Missing env vars');

    const serviceAccount = JSON.parse(rawKey);
    const token = await getAccessToken(serviceAccount);

    // 1. Get or create "Site Staff" sheet
    const spreadsheet = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    ).then(r => r.json());

    const sheets = spreadsheet.sheets || [];
    let staffSheet = sheets.find(s => s.properties.title === 'Site Staff');

    if (!staffSheet) {
      // Create the sheet
      const addRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{ addSheet: { properties: { title: 'Site Staff' } } }]
          })
        }
      ).then(r => r.json());
      staffSheet = addRes.replies?.[0]?.addSheet;
    }

    // 2. Read existing Site Staff data
    const readRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Site Staff!A:G`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    ).then(r => r.json());

    const existingRows = readRes.values || [];
    const HEADER = ['Site', 'Name', 'Role', 'Start Date', 'End Date', 'Signed', 'Tasks'];

    // Parse existing staff
    // staffList: [{site, name, role, start, end, signed, tasks}]
    const staffList = [];
    for (let i = 1; i < existingRows.length; i++) {
      const r = existingRows[i];
      if (!r || !r[1]) continue;
      staffList.push({
        site: r[0] || '',
        name: r[1] || '',
        role: r[2] || '',
        start: r[3] || '',
        end: r[4] || '',
        signed: r[5] || '',
        tasks: r[6] || '',
      });
    }

    // 3. Check for duplicates to flag back to client
    if (Object.keys(mergeDecisions).length === 0) {
      const duplicates = [];
      for (const newRow of rows) {
        const existing = staffList.find(s =>
          !isSamePerson(s.name, newRow.name_english) && // not exact
          levenshtein(normalizeName(s.name), normalizeName(newRow.name_english)) <= 3
        );
        if (existing) {
          duplicates.push({ newName: newRow.name_english, existingName: existing.name });
        }
      }
      if (duplicates.length > 0) {
        return res.status(200).json({ needsReview: true, duplicates });
      }
    }

    // 4. Merge new rows into staffList
    for (const newRow of rows) {
      const newName = newRow.name_english || newRow.name_korean || '';
      const role = normalizeRole(newRow.role);
      const signed = newRow.status === 'Completed' || newRow.signed ? '✓' : '';

      // Check merge decisions
      let canonicalName = newName;
      for (const [key, shouldMerge] of Object.entries(mergeDecisions)) {
        const [nName, eName] = key.split('||');
        if (isSamePerson(nName, newName) && shouldMerge) {
          canonicalName = eName; // use existing name
          break;
        }
      }

      // Find existing person (exact or merged)
      const existingIdx = staffList.findIndex(s =>
        isSamePerson(s.name, canonicalName)
      );

      if (existingIdx >= 0) {
        // Update existing
        staffList[existingIdx] = {
          ...staffList[existingIdx],
          role: role || staffList[existingIdx].role,
          start: newRow.start_date || staffList[existingIdx].start,
          end: newRow.end_date || staffList[existingIdx].end,
          signed: signed || staffList[existingIdx].signed,
          tasks: newRow.tasks || staffList[existingIdx].tasks,
        };
      } else {
        // Add new
        staffList.push({
          site: newRow.site_number || '',
          name: canonicalName,
          role,
          start: newRow.start_date || '',
          end: newRow.end_date || 'Ongoing',
          signed,
          tasks: newRow.tasks || '',
        });
      }
    }

    // 5. Sort by role order
    const ROLE_ORDER = ['PI', 'Sub-I', 'SC', 'CRC', 'Pharmacist', 'Lab technician', 'Infusion nurse', 'Other'];
    staffList.sort((a, b) => {
      const ai = ROLE_ORDER.indexOf(a.role), bi = ROLE_ORDER.indexOf(b.role);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    // 6. Rewrite Site Staff sheet
    const newData = [HEADER, ...staffList.map(s => [s.site, s.name, s.role, s.start, s.end, s.signed, s.tasks])];

    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Site Staff!A:G:clear`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    const writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Site Staff!A1?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: newData }),
      }
    ).then(r => r.json());

    return res.status(200).json({ success: true, count: staffList.length });

  } catch (e) {
    console.error('Staff error:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const unsigned = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Token error: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}
