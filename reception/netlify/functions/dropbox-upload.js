const DROPBOX_TOKEN = 'sl.u.AGk8vPDCoSnV-QkT4Hf5hp_P7jy76XUmDBdjCU46VGzN2JxaHKoBIJQLCola7wjE9HESWONtf_3nBbptfoAOGpcmp7WIjj5W0x7CqmGCcFuToMKDuaqQlzCe6Mp2gk68xpOAoVHn54iKfuiGWjM7u3dQKNkYtw6I4EH9R8W5UrsjebemYtSWm8PMlBzColYY3YNKcMhzUgr0Aoc_xfiLyiDsy7mS0g6qoE22I_C1mJ-Pgb5PzvYuHIZe2PLijy-udn8XI7qFpg22762WRgBg8wgAIt-i6YUz1cwzeRRHxJWQieutwi2d2I8d39geE5MPRRfJsIBxlhyahpZSEHdFRjR_tipSCNNXjmw44TWHFiwAIWZlxkQohdJjYAguCPSKlgNqubvS_-WqIsldSkbbjaZ9uqP0XVIcr3uHIYUt1Wpkn96TqUcQA_xwHv2ak9aVnQ_HtxUMroO-m4937pZatY0VzMzpbAGUxsYyO4ABNUepTaRTtGhMAdt80IYEsM35sXUbYdZZQyDN2yVqRJg9AwziQILklaogl90ubaXtxzHTMLMayWZ7IWr2KM3DXOHGdujDrbvyThnYvPJ3Emn53s8h9cRfgtM0CNm35TPQYiL2LNuVmc2HBKEYq7Y268GchZgiCHkXl5CXkvCFW5rnf7Ly_G_1QpysdMc6aQE-a14aBMSvf9emH-QpJmdngZFUZIlLuIjekCpSLgyxa-lajh7NAcfzF6dWgn3tQZc7cKuUxhwzmK2z44gTTHgjnX-8TjTBEfKY1aY2o7yUqPj3KG_YMnN-RZkxniMMH76AZ6sMeau1wEBkW3vj-6Wvm1W5X1K-pN9myCjx1Bg1LDitSqbeDf1njvUrOl9oxNtJ3tq4fjGPnpELPnWulREN8Cxnm2wGGvF0C6wCcniIwE9pdB_IZtd8z3I-r8VnYIk1BP_YPywLMLJzoo6wU9glHN9bHLwp0XpvYFdR3Bh0aGGuydAGPtCWM1Fn4yr2ear_qz8gTrPHWwFlsm7ZLRkO0uAh5a5EnaXbSrtMv-SBBzYcqe6nCubmRC217jxAEJ0tRfk6WW7J3WTVvm9_GkSxlc09Smm2Dxt9ZHJ6bcmenK5IQvp5EQQlmIZBchBrNvglZy8dTZvkMQswTSmTWxr5ZydKBJWVFLhRQxPMGM0oUhu-5rv74KTdzDnEyC4g5yO1R-s6zgUojngLwJcPzi3KhnQG1fKCiOPRTM7W2Y-ozT_VQEigjLBEtPG20WevBvubBHhe8amwdh2eD5DkpiHLPj3kkjuY3ZPQWxYGGBdjoCLE-IG17veU_Lcd8Prl_lEH7836LMNY4chrdzYJyz40u6gC5Ar0pwZaLM90MovoVFQakE3m';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const filename = (event.queryStringParameters && event.queryStringParameters.filename)
    ? event.queryStringParameters.filename
    : `reception_${Date.now()}.webm`;

  const path = `/${filename}`;

  if (!event.body) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'No body received' }),
    };
  }

  const buffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary');

  try {
    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true }),
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: text }),
      };
    }

    const data = JSON.parse(text);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ path: data.path_display }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
