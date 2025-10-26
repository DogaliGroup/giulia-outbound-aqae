// Carica variabili d'ambiente
require('dotenv').config();

// Import librerie
const express = require('express');
const fetch = require('node-fetch');
const app = express();

// Import librerie custom
const generateAudio = require('./lib/generateAudio');
const uploadAudio = require('./lib/uploadAudio');
const makeCall = require('./lib/makeCall');
const buildPrompt = require('./lib/promptBuilder');
const transcribeAudio = require('./lib/transcribeAudio');

// Middleware
app.use(express.json());
app.use(express.static('public')); // serve file statici (es. /public/audio/silence.mp3)

// Health check
app.get('/health', (req, res) => res.send('OK'));

// -----------------------------
// ENDPOINT: avvio chiamata da Make
// -----------------------------
app.post('/start-call', async (req, res) => {
  try {
    // Autenticazione semplice
    if (req.headers.authorization !== `Bearer ${process.env.AUTH_TOKEN_MAKE}`) {
      return res.status(403).send('Forbidden');
    }

    const { first_name, phone_number, row_id } = req.body;
    if (!phone_number) return res.status(400).send('Missing phone_number');

    // URL di un file audio iniziale (silenzio)
    const silenceUrl = `${process.env.SERVER_BASE_URL.replace(/\/$/, '')}/audio/silence.mp3`;

    // Avvia chiamata con Twilio
    const callSid = await makeCall(phone_number, silenceUrl, { row_id, first_name });

    // Risposta a Make
    return res.json({
      status: 'queued',
      call_sid: callSid,
      audioUrl: silenceUrl
    });
  } catch (e) {
    console.error('start-call error', e);
    return res.status(500).send('Errore interno');
  }
});

// -----------------------------
// ENDPOINT: callback Twilio → registrazione completata
// -----------------------------
app.post('/twilio/recording', async (req, res) => {
  try {
    const recordingUrl = req.body.RecordingUrl;
    const from = req.body.From;
    const callSid = req.body.CallSid;

    // Recupera row_id dai meta se presente
    let row_id = null;
    if (req.query.meta) {
      try {
        const decoded = Buffer.from(req.query.meta, 'base64').toString();
        row_id = JSON.parse(decoded).row_id || null;
      } catch (err) {
        console.warn('Errore decodifica meta:', err);
      }
    }

    if (!recordingUrl) {
      console.warn('Missing RecordingUrl', req.body);
      return res.status(400).send('Bad Request');
    }

    // Trascrivi audio
    const transcript = await transcribeAudio(recordingUrl);

    // Genera risposta audio (ma NON richiami subito il cliente)
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
          type: 'recording',
          row_id,
          call_sid: callSid,
          transcript,
          audio_url: audioUrl,
          stato_chiamata: 'chiamata_effettuata',
          timestamp: new Date().toISOString()
        })
      });
    }

    return res.send('OK');
  } catch (e) {
    console.error('twilio/recording error', e);
    return res.status(500).send('Errore interno');
  }
});

// -----------------------------
// ENDPOINT: callback Twilio → stato chiamata
// -----------------------------
app.post('/twilio/status', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;

    console.log('Call status:', callSid, callStatus);

    if (process.env.MAKE_WEBHOOK_URL) {
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'status',
          call_sid: callSid,
          stato_chiamata: callStatus,
          timestamp: new Date().toISOString()
        })
      });
    }

    res.send('OK');
  } catch (e) {
    console.error('twilio/status error', e);
    res.status(500).send('Errore interno');
  }
});

// -----------------------------
// ENDPOINT: callback Twilio → trascrizione (se attiva transcribe="true")
// -----------------------------
app.post('/twilio/transcribe', async (req, res) => {
  try {
    if (process.env.MAKE_WEBHOOK_URL) {
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'transcribe',
          payload: req.body,
          timestamp: new Date().toISOString()
        })
      });
    }
    res.send('OK');
  } catch (e) {
    console.error('twilio/transcribe error', e);
    res.status(500).send('Errore interno');
  }
});

// -----------------------------
// Avvio server
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server attivo su porta ${PORT}`);
});
