require('dotenv').config();
const axios = require('axios');
const key = process.env.OPENROUTER_API_KEY;
console.log('Key:', key ? key.substring(0,12) + '...' : 'MISSING');

axios.post('https://openrouter.ai/api/v1/chat/completions', {
  model: 'anthropic/claude-sonnet-4',
  messages: [{role:'user', content:'Say ok'}],
  temperature: 0.3,
  max_tokens: 10
}, {
  headers: {
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'Lead Hydration Engine'
  },
  timeout: 30000
}).then(r => {
  console.log('SUCCESS:', r.data.choices[0].message.content);
}).catch(e => {
  console.log('FAIL status:', e.response?.status);
  console.log('FAIL data:', JSON.stringify(e.response?.data));
});
