const axios = require('axios');

module.exports = async function generateAudio(text) {
  if (!process.env.ELEVEN_API_KEY || !process.env.ELEVEN_VOICE_ID) {
    throw new Error('ELEVEN_API_KEY or ELEVEN_VOICE_ID not set');
  }

  const body = {
    text,
    model_id: process.env.ELEVEN_MODEL_ID || 'eleven_multilingual_v2',
    voice_settings: {
      stability: parseFloat(process.env.ELEVEN_TTS_STABILITY || '0.35'),
      similarity_boost: parseFloat(process.env.ELEVEN_TTS_SIMILARITY || '0.55'),
      speaking_rate: parseFloat(process.env.ELEVEN_SPEAKING_RATE || '1.02')
    },
    output_format: 'mp3'
  };

  const resp = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}/stream`,
    body,
    {
      headers: {
        'xi-api-key': process.env.ELEVEN_API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    }
  );

  return Buffer.from(resp.data);
};
