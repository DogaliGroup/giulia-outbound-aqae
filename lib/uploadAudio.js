const fs = require('fs');
const path = require('path');

module.exports = async function uploadAudio(buffer, filename) {
  const dir = path.join(__dirname, '..', 'public', 'audio');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, buffer);
  return `${process.env.SERVER_BASE_URL.replace(/\/$/, '')}/audio/${filename}`;
};
