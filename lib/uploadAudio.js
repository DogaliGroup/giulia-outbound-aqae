// lib/uploadAudio.js
const fs = require('fs');
const path = require('path');

module.exports = async function uploadAudio(buffer, filename) {
  const dir = path.join(__dirname, '..', 'public', 'audio');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, buffer);
  const base = (process.env.SERVER_BASE_URL || '').replace(/\/$/, '');
  // assicurati che SERVER_BASE_URL includa https://
  return `${base}/audio/${filename}`;
};
