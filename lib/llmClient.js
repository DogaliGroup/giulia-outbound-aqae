// lib/llmClient.js
const fetch = require('node-fetch');

module.exports = async function callLLM(prompt) {
  const apiKey = process.env.LLM_KEY;
  if (!apiKey) {
    return { text: prompt.slice(0, 300) };
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      messages: [{ role:'system', content:'Sei Giulia, risposte brevi e chiare.'}, { role:'user', content: prompt }],
      max_tokens: 250
    })
  });
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content || '';
  return { text };
};
