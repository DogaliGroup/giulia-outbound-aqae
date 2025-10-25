const axios = require('axios');

module.exports = async function transcribeAudio(recordingUrl) {
  try {
    const url = recordingUrl.endsWith('.mp3') ? recordingUrl : `${recordingUrl}.mp3`;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = resp.data;

    if (!process.env.ELEVEN_API_KEY) {
      console.warn('ELEVEN_API_KEY not set, returning empty transcript');
      return '';
    }

    const r = await axios.post(
      'https://api.elevenlabs.io/v1/speech-to-text',
      buffer,
      {
        headers: {
          'xi-api-key': process.env.ELEVEN_API_KEY,
          'Content-Type': 'audio/mpeg'
        },
        params: { model: process.env.ELEVEN_MODEL_ID || 'whisper-1' }
      }
    );

    return r.data.transcript || r.data.text || '';
  } catch (e) {
    console.error('transcribeAudio error', e.message || e);
    return '';
  }
};
