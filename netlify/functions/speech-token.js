// Azure Speech token function (no node-fetch needed)
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  const endpointId = process.env.AZURE_SPEECH_ENDPOINT_ID || '';

  if (!key || !region) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION' })
    };
  }

  try {
    const url = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key }
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'Azure token request failed', status: res.status, body: text })
      };
    }

    const token = await res.text();
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', ...CORS },
      body: JSON.stringify({ ok: true, token, region, endpointId, expiresIn: 540 })
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
