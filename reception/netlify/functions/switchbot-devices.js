const crypto = require('crypto');

const TOKEN  = '8a7268b29d32fa5bb10412febd863bf5a58b6131c0090410069601a63cd6167bafa5f98288f1441fd05795a5a4c9760b';
const SECRET = 'b7ece6cff50e3c850265b7739ec7318f';

exports.handler = async () => {
  const t     = Date.now().toString();
  const nonce = Math.random().toString(36).slice(2);
  const sign  = crypto
    .createHmac('sha256', SECRET)
    .update(TOKEN + t + nonce)
    .digest('base64')
    .toUpperCase();

  try {
    const res  = await fetch('https://api.switch-bot.com/v1.1/devices', {
      headers: { Authorization: TOKEN, sign, t, nonce }
    });
    const data = await res.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
