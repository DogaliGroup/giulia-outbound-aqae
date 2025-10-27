// server.js
// Carica variabili d'ambiente e moduli base
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Carica profilo di chiamata
const { CALL_PROFILE } = require('./config');

// Express app
const app = express();
app.use(express.json());
app.use(express.static('public')); // serve file statici (es. /public/audio/silence.mp3)

// Import librerie custom (mantieni i tuoi percorsi)
const generateAudio = require('./lib/generateAudio');
const uploadAudio = require('./lib/uploadAudio');
const makeCall = require('./lib/makeCall');
const buildPrompt = require('./lib/promptBuilder');
const transcribeAudio = require('./lib/transcribeAudio');

// Session store in-memory (per test). Sostituire con Redis in produzione.
const sessions = {};

// Helper: crea meta token base64 (usa per collegare row_id/first_name alle sessioni)
function makeMetaToken(metaObj = {}) {
  try {
    return Buffer.from(JSON.stringify(metaObj)).toString('base64');
  } catch (e) {
    return '';
  }
}

// Helper: pulizia sessione
function cleanupSession(callSid) {
  if (sessions[callSid]) {
    // eventuale cleanup risorse (connessioni STT/TTS)
    delete sessions[callSid];
    console.log('Cleaned session', callSid);
  }
}

// Health check
app.get('/health', (req, res) => res.send('OK'));

// -----------------------------
// ENDPOINT: avvio chiamata da Make
// -----------------------------
app.post('/start-call', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.AUTH_TOKEN_MAKE}`) {
      return res.status(403).send('Forbidden');
    }

    const { first_name, phone_number, row_id } = req.body;
    if (!phone_number) return res.status(400).send('Missing phone_number');

    const silenceUrl = `${process.env.SERVER_BASE_URL.replace(/\/$/, '')}/audio/silence.mp3`;
    // meta token con row_id e first_name
    const metaToken = makeMetaToken({ row_id, first_name });

    // makeCall deve essere aggiornato per accettare CALL_PROFILE e costruire TwiML
    const callSid = await makeCall(phone_number, silenceUrl, { row_id, first_name, meta: metaToken }, CALL_PROFILE);

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
    const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl;
    const from = req.body.From || req.body.from;
    const callSid = req.body.CallSid || req.body.callSid;

    // Recupera row_id dai meta se presente (se passata come query su Twilio callbacks)
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

    // Trascrivi audio (sync, basato su URL registrazione Twilio)
    const transcript = await transcribeAudio(recordingUrl);

    // Genera risposta audio (non richiamiamo subito il cliente: produciamo solo file)
    const replyPrompt = buildPrompt(transcript, { from }, CALL_PROFILE);
    const audioBuffer = await generateAudio(replyPrompt, CALL_PROFILE);
    const filename = `response_${Date.now()}.mp3`;
    const audioUrl = await uploadAudio(audioBuffer, filename);

    // Inoltra i dati a Make in formato uniforme
    if (process.env.MAKE_WEBHOOK_URL) {
      try {
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
      } catch (err) {
        console.error('Errore inoltro recording a Make:', err);
      }
    }

    return res.send('OK');
  } catch (e) {
    console.error('twilio/recording error', e);
    return res.status(500).send('Errore interno');
  }
});

// -----------------------------
// ENDPOINT: callback Twilio → stato chiamata (con gestione AMD/voicemail)
// -----------------------------
app.post('/twilio/status', async (req, res) => {
  try {
    const callSid = req.body.CallSid || req.body.callSid;
    const callStatus = req.body.CallStatus || req.body.callStatus;
    const answeredBy = (req.body.AnsweredBy || req.body.answeredBy || '').toString();

    console.log('Call status:', callSid, callStatus, 'AnsweredBy:', answeredBy);

    // Se Twilio segnala macchina/voicemail
    if (answeredBy && answeredBy.toLowerCase().includes('machine')) {
      // Azione configurata nel profilo
      const action = CALL_PROFILE.machine_detection && CALL_PROFILE.machine_detection.action_on_machine;
      if (process.env.MAKE_WEBHOOK_URL) {
        await fetch(process.env.MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'voicemail',
            call_sid: callSid,
            answered_by: answeredBy,
            action,
            timestamp: new Date().toISOString()
          })
        });
      }
      // Se preferisci mandare un message o chiudere, fallo lato makeCall / twiml; qui solo segnaliamo.
    } else {
      // Normal human flow: inoltra status a Make
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
// WebSocket server per Twilio Media Streams
// -----------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: CALL_PROFILE.media && CALL_PROFILE.media.twilio_stream_path ? CALL_PROFILE.media.twilio_stream_path : '/stream' });

wss.on('connection', (ws, req) => {
  const fullUrl = req.url || '';
  const query = fullUrl.split('?')[1] || '';
  const qs = new URLSearchParams(query);
  const callSid = qs.get('callSid') || `cs_${Date.now()}`;

  // inizializza sessione
  sessions[callSid] = sessions[callSid] || {
    state: 'OPENING',
    transcript: [],
    extracted: {},
    speaking: false,
    sttBuffer: [],
    lastActivity: Date.now()
  };
  console.log('WS connected for', callSid);

  ws.on('message', async (msg) => {
    try {
      // Twilio invia string JSON con eventi o binary; gestiamo JSON event.media base64
      if (typeof msg === 'string') {
        const evt = JSON.parse(msg);
        if (evt.event === 'connected') {
          console.log('Media stream connected event for', callSid);
        } else if (evt.event === 'media' && evt.media && evt.media.payload) {
          // audio base64
          const audioBase64 = evt.media.payload;
          // forward to STT pipeline (stub/placeholder)
          await forwardAudioChunkToSTT(callSid, audioBase64);
        } else if (evt.event === 'start') {
          // ignora o logga
        } else if (evt.event === 'stop') {
          cleanupSession(callSid);
        }
      } else {
        // binary payload - invio diretto ad STT
        await forwardAudioChunkToSTT(callSid, msg);
      }
    } catch (err) {
      console.error('WS message error', err);
    }
  });

  ws.on('close', () => {
    console.log('WS closed for', callSid);
    cleanupSession(callSid);
  });
});

// -----------------------------
// PLACEHOLDER: forwardAudioChunkToSTT
// - Questo è uno stub che salva chunks in sessione.
// - Implementa qui la connessione persistente al tuo STT realtime (ElevenLabs/Whisper) e la logica di partial/final.
// - Quando ricevi text final, chiama handleSttFinal(callSid, text).
// -----------------------------
async function forwardAudioChunkToSTT(callSid, audioBase64OrBinary) {
  // Attualmente salva chunk in memoria; replace con invio allo STT realtime.
  const s = sessions[callSid];
  if (!s) return;
  s.lastActivity = Date.now();

  // Normalizza input: se è Buffer (binary) convertilo in base64 string per debug
  let b64;
  if (Buffer.isBuffer(audioBase64OrBinary)) {
    b64 = audioBase64OrBinary.toString('base64');
  } else {
    b64 = audioBase64OrBinary; // già base64 string
  }

  // Buffer chunks (per test/inspezione)
  s.sttBuffer.push(b64);

  // TODO: In una pipeline reale, invia chunk allo STT realtime e gestisci partial/final callbacks.
  // Per testing locale, ogni N chunk o dopo tempo puoi simulare una trascrizione finale:
  if (s.sttBuffer.length >= 30) { // soglia di esempio
    // Simula un testo dal contenuto audio
    const fakeText = 'Simulazione: ho problemi di navigazione da due giorni';
    await handleSttFinal(callSid, fakeText);
    s.sttBuffer = [];
  }
}

// -----------------------------
// Gestione STT final: aggiornare session e decidere prossimo stato
// - decideNextState, buildPromptForState e callLLM devono essere implementati nei rispettivi moduli.
// - Qui chiami buildPrompt e generi TTS con elevenTTSstream (stub).
// -----------------------------
async function handleSttFinal(callSid, text) {
  const s = sessions[callSid];
  if (!s) return;
  s.transcript.push(text);
  s.lastActivity = Date.now();

  // semplice extraction numerica (regex)
  const simMatch = text.match(/(\d+)\s*(schede|sim|simcard|scheda)/i);
  if (simMatch) {
    s.extracted.sim_count = parseInt(simMatch[1], 10);
  }

  // Decide next state (semplice rule)
  if (!s.extracted.sim_count) {
    s.state = 'ASK_SIM';
  } else {
    s.state = 'ASK_BILL';
  }

  // Costruisci prompt testuale usando buildPrompt (implementa buildPrompt per usare CALL_PROFILE.script)
  let promptText;
  try {
    promptText = buildPrompt(s.state, s, CALL_PROFILE); // implementa buildPrompt(state, session, CALL_PROFILE)
  } catch (err) {
    // fallback conservativo
    promptText = CALL_PROFILE.script && CALL_PROFILE.script.opening ? CALL_PROFILE.script.opening : 'Buongiorno';
  }

  // Genera audio con generateAudio (sincrono, fallback a file)
  try {
    const audioBuffer = await generateAudio(promptText, CALL_PROFILE);
    // In un flusso reale dobbiamo inviare audioBuffer in streaming a Twilio via Media bridge
    // Per ora upload e log
    const filename = `prompt_${callSid}_${Date.now()}.mp3`;
    const audioUrl = await uploadAudio(audioBuffer, filename);
    console.log('Generated reply audioUrl for', callSid, audioUrl);

    // Segnala a Make la reply testuale e i dati estratti
    if (process.env.MAKE_WEBHOOK_URL) {
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reply_generated',
          call_sid: callSid,
          state: s.state,
          extracted: s.extracted,
          reply_text: promptText,
          reply_audio_url: audioUrl,
          timestamp: new Date().toISOString()
        })
      });
    }
  } catch (err) {
    console.error('Errore generazione reply audio', err);
  }
}

// -----------------------------
// Avvio server HTTP + WS
// -----------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server + WS attivo su porta ${PORT}`);
});
