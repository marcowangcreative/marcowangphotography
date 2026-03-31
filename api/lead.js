module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const VSCO_ENDPOINT = 'https://workspace.vsco.co/webservice/create-lead/455b70a021a180bbaf49631d';
  const SECRET_KEY = process.env.VSCO_SECRET_KEY;

  if (!SECRET_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const body = req.body;

  const params = new URLSearchParams();
  params.append('SecretKey', SECRET_KEY);
  params.append('FirstName', body.FirstName || '');
  params.append('LastName', body.LastName || '');
  params.append('Email', body.Email || '');
  params.append('MobilePhone', body.MobilePhone || '');
  params.append('Date', body.Date || '');
  params.append('JobType', body.JobType || '');
  params.append('JobRole', body.JobRole || '');
  params.append('Source', body.Source || '');
  params.append('Message', body.Message || '');

  try {
    const response = await fetch(VSCO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (response.ok) {
      return res.status(200).json({ success: true });
    } else {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to submit to CRM' });
  }
}
