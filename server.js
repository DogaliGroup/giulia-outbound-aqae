require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // serve per chiamare Make
const app = express();

const generateAudio = require('./lib/generateAudio');
const uploadAudio = require('./lib/uploadAudio');
const makeCall = require('./lib/makeCall');
const buildPrompt = require('./lib/promptBuilder');
const transcribeAudio = require('./lib/transcribeAudio');

app.use(express.json());
app.use(express.static('public')); // serve /public/audio

// Health check
app.get('/health', (req, res) => res.send('OK'));

// Avvia chiamata da Make
app.post('/start-call', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.AUTH_TOKEN_MAKE}`) {
      return res.status(403).send('Forbidden');
    }
    const { first_name, phone_number, row_id } = req.body;
    if (!phone_number) return res.status(400).send('Missing phone_number');

    const silenceUrl = `${process.env.SERVER_BASE_URL.replace(/\/$/, '')}/audio/silence.mp3`;
    const call = await makeCall(phone_number, silenceUrl, { row_id, first_name });

    // Rispondi a Make con info utili
    return res.json({
      status: 'queued',
      call_sid: call.sid,
      audioUrl: silenceUrl
    });
  } catch (e) {
    console.error('start-call error', e);
    return res.status(500).send('Errore interno');
  }
});

// Callback Twilio: riceve recording
app.post('/recording-callback', async (req, res) => {
  try {
    const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl;
    const from = req.body.From || req.body.from;
    const callSid = req.body.CallSid || req.body.callSid;
    const row_id = req.body.row_id || null;

    if (!recordingUrl || !from) {
      console.warn('Missing recordingUrl or From in callback', req.body);
      return res.status(400).send('Bad Request');
    }

    // Trascrivi audio
    const transcript = await transcribeAudio(recordingUrl);

    // Genera risposta audio
    const replyPrompt = buildPrompt(transcript, { from });
    const audioBuffer = await generateAudio(replyPrompt);
    const filename = `response_${Date.now()}.mp3`;
    const audioUrl = await uploadAudio(audioBuffer, filename);

    // Inoltra i dati a Make
    if (process.env.MAKE_WEBHOOK_URL) {
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_id,
          call_sid: callSid,
          transcript,
          audio_url: audioUrl,
          stato_chiamata: 'chiamata_effettuata',
          timestamp: new Date().toISOString()
        })
      });
    }

    // (Opzionale) fai una nuova chiamata con la risposta
    await makeCall(from, audioUrl, { tag: filename });

    return res.send('OK');
  } catch (e) {
    console.error('recording-callback error', e);
    return res.status(500).send('Errore interno');
  }
});

// Callback Twilio: stato chiamata
app.post('/call-status', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;

    console.log('Call status:', callSid, callStatus);

    // Inoltra a Make
    if (process.env.MAKE_WEBHOOK_URL) {
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          call_sid: callSid,
          stato_chiamata: callStatus,
          timestamp: new Date().toISOString()
        })
      });
    }

    res.send('OK');
  } catch (e) {
    console.error('call-status error', e);
    res.status(500).send('Errore interno');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server attivo sulla porta ${port}`);
});
