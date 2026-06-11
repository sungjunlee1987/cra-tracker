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

    const values = rows.map(r => [
      r.site_number || '', r.trainee_name || '', r.role || '',
      r.training_material || '', r.version || '', r.training_date || '',
      r.trainer || '', r.status || ''
    ]);

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:H:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values }),
      }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Sheets API error');

    return res.status(200).json({ success: true });

  } catch (e) {
    console.error('Sheets error:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}

async function getAccessToken(serviceAccount) {
  const { createSign } = await import('crypto');
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
