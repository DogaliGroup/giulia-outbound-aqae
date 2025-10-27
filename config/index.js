// config/index.js
const fs = require('fs');
const path = require('path');

const PROFILE_FILENAME = 'callProfile.giulia.json';
const profilePath = path.join(__dirname, PROFILE_FILENAME);

function loadProfile() {
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Config file not found: ${profilePath}`);
  }
  const raw = fs.readFileSync(profilePath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    // Minimal validation
    if (!parsed.agent || !parsed.script || !parsed.media) {
      throw new Error('callProfile is missing required keys (agent/script/media)');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Error parsing ${PROFILE_FILENAME}: ${err.message}`);
  }
}

const CALL_PROFILE = loadProfile();

module.exports = { CALL_PROFILE, loadProfile };
