import { createSign } from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { rows } = req.body;
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

    if (!sheetId || !rawKey) {
      throw new Error('Missing env vars');
    }

    const serviceAccount = JSON.parse(rawKey);
    const token = await getAccessToken(serviceAccount);

    // 1. Read existing sheet data
    const readRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:ZZ`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const readData = await readRes.json();
    const existingRows = readData.values || [];

    // 2. Parse existing data into pivot structure
    // Header row: [Site, Name, Role, Material1, Material2, ...]
    // Data rows: [site, name, role, date1, date2, ...]
    let headerRow = existingRows[0] || ['Site', 'Name', 'Role'];
    const fixedCols = 3; // Site, Name, Role

    // Build map: "site||name" -> { rowIndex, trainings: { "material ver": date } }
    const peopleMap = {};
    for (let i = 1; i < existingRows.length; i++) {
      const r = existingRows[i];
      if (!r || !r[1]) continue;
      const key = `${r[0]}||${r[1]}`;
      const trainings = {};
      for (let c = fixedCols; c < headerRow.length; c++) {
        if (r[c]) trainings[headerRow[c]] = r[c];
      }
      peopleMap[key] = { rowIndex: i, site: r[0], name: r[1], role: r[2], trainings };
    }

    // 3. Merge new rows into pivot
    for (const row of rows) {
      const key = `${row.site_number}||${row.trainee_name}`;
      const matCol = `${row.training_material}${row.version && row.version !== 'N/A' ? ' ' + row.version : ''}`;
      const dateVal = row.training_date || '';

      if (!peopleMap[key]) {
        peopleMap[key] = {
          rowIndex: null,
          site: row.site_number,
          name: row.trainee_name,
          role: row.role,
          trainings: {}
        };
      }
      peopleMap[key].trainings[matCol] = dateVal;

      // Add column to header if new material
      if (!headerRow.includes(matCol)) {
        headerRow.push(matCol);
      }
    }

    // 4. Rebuild full sheet data
    const newData = [headerRow];
    for (const person of Object.values(peopleMap)) {
      const dataRow = [person.site, person.name, person.role];
      for (let c = fixedCols; c < headerRow.length; c++) {
        dataRow.push(person.trainings[headerRow[c]] || '');
      }
      newData.push(dataRow);
    }

    // 5. Clear and rewrite sheet
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:ZZ:clear`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      }
    );

    const writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: newData }),
      }
    );

    const writeData = await writeRes.json();
    if (!writeRes.ok) throw new Error(writeData.error?.message || 'Write error');

    return res.status(200).json({ success: true, people: Object.keys(peopleMap).length, materials: headerRow.length - fixedCols });

  } catch (e) {
    console.error('Sheets error:', e.message);
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
