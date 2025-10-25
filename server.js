require('dotenv').config();
const express = require('express');
const app = express();
const generateAudio = require('./lib/generateAudio');
const uploadAudio = require('./lib/uploadAudio');
const makeCall = require('./lib/makeCall');
const buildPrompt = require('./lib/promptBuilder');
const transcribeAudio = require('./lib/transcribeAudio');

app.use(express.json());
app.use(express.static('public')); // serve /public/audio

app.get('/health', (req, res) => res.send('OK'));

// Avvia chiamata: user speaks first (Play silence.mp3 then Record)
app.post('/start-call', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.AUTH_TOKEN_MAKE}`) {
      return res.status(403).send('Forbidden');
    }
    const { first_name, phone_number, row_id } = req.body;
    if (!phone_number) return res.status(400).send('Missing phone_number');

    const silenceUrl = `${process.env.SERVER_BASE_URL.replace(/\/$/, '')}/audio/silence.mp3`;
    await makeCall(phone_number, silenceUrl, { row_id, first_name });

    return res.json({ status: 'queued' });
  } catch (e) {
    console.error('start-call error', e);
    return res.status(500).send('Errore interno');
  }
});

// Webhook Twilio: riceve recording quando Record termina
app.post('/recording-callback', async (req, res) => {
  try {
    const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl;
    const from = req.body.From || req.body.from;
    if (!recordingUrl || !from) {
      console.warn('Missing recordingUrl or From in callback', req.body);
      return res.status(400).send('Bad Request');
    }

    const transcript = await transcribeAudio(recordingUrl);
    const replyPrompt = buildPrompt(transcript, { from });
    const audioBuffer = await generateAudio(replyPrompt);
    const filename = `response_${Date.now()}.mp3`;
    const audioUrl = await uploadAudio(audioBuffer, filename);

    // Rispondi creando una nuova chiamata che riproduce la risposta
    await makeCall(from, audioUrl, { tag: filename });

    return res.send('OK');
  } catch (e) {
    console.error('recording-callback error', e);
    return res.status(500).send('Errore interno');
  }
});

app.post('/call-status', (req, res) => {
  console.log('Call status:', req.body);
  res.send('OK');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server attivo sulla porta ${port}`);
});
