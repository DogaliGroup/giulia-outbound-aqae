// server.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Carica profilo di chiamata
const { CALL_PROFILE } = require('./config');

// Express app
const app = express();
app.use(express.urlencoded({ extended: false })); // necessario per Twilio callbacks (form data)
app.use(express.json());
app.use(express.static('public')); // serve file statici (es. /public/audio/silence.mp3)

// Simple request logger per endpoint Twilio/Start
app.use((req, res, next) => {
  if ((req.path || '').startsWith('/twilio') || req.path === '/start-call') {
    try {
      console.log('INCOMING HTTP', req.method, req.path, 'Query:', req.query, 'Body:', JSON.stringify(req.body).slice(0,2000));
    } catch (e) {
      console.log('INCOMING HTTP (could not stringify body)', req.method, req.path);
    }
  }
  next();
});

// Import librerie custom (stub se mancanti)
const generateAudio = require('./lib/generateAudio');
const uploadAudio = require('./lib/uploadAudio');
const makeCall = require('./lib/makeCall');
const buildPrompt = require('./lib/promptBuilder');
const transcribeAudio = require('./lib/transcribeAudio');

// Session store in-memory (per test)
const sessions = {};

function makeMetaToken(metaObj = {}) {
  try { return Buffer.from(JSON.stringify(metaObj)).toString('base64'); } catch (e) { return ''; }
}
function cleanupSession(callSid) {
  if (sessions[callSid]) {
    delete sessions[callSid];
    console.log('Cleaned session', callSid);
  }
}

// Health
app.get('/health', (req, res) => res.send('OK'));

// START CALL endpoint (Make -> server)
app.post('/start-call', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.AUTH_TOKEN_MAKE}`) {
      return res.status(403).send('Forbidden');
    }
    const { first_name, phone_number, row_id } = req.body;
    if (!phone_number) return res.status(400).send('Missing phone_number');

    const silenceUrl = `${process.env.SERVER_BASE_URL.replace(/\/$/, '')}/audio/silence.mp3`;
    const metaToken = makeMetaToken({ row_id, first_name });

    const callSid = await makeCall(phone_number, silenceUrl, { row_id, first_name, meta: metaToken }, CALL_PROFILE);

    return res.json({ status: 'queued', call_sid: callSid, audioUrl: silenceUrl });
  } catch (e) {
    console.error('start-call error', e && e.stack ? e.stack : e);
    return res.status(500).send('Errore interno');
  }
});

// Twilio recording callback
app.post('/twilio/recording', async (req, res) => {
  try {
    const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl;
    const from = req.body.From || req.body.from;
    const callSid = req.body.CallSid || req.body.callSid;

    let row_id = null;
    if (req.query.meta) {
      try {
        const decoded = Buffer.from(req.query.meta, 'base64').toString();
        row_id = JSON.parse(decoded).row_id || null;
      } catch (err) { console.warn('Errore decodifica meta:', err); }
    }

    if (!recordingUrl) {
      console.warn('Missing RecordingUrl', req.body);
      return res.status(400).send('Bad Request');
    }

    const transcript = await transcribeAudio(recordingUrl);
    const replyPrompt = buildPrompt(transcript, { from }, CALL_PROFILE);
    const audioBuffer = await generateAudio(replyPrompt, CALL_PROFILE);
    const filename = `response_${Date.now()}.mp3`;
    const audioUrl = await uploadAudio(audioBuffer, filename);

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
    console.error('twilio/recording error', e && e.stack ? e.stack : e);
    return res.status(500).send('Errore interno');
  }
});

// Twilio status callback (AMD/voicemail)
app.post('/twilio/status', async (req, res) => {
  try {
    const callSid = req.body.CallSid || req.body.callSid;
    const callStatus = req.body.CallStatus || req.body.callStatus;
    const answeredBy = (req.body.AnsweredBy || req.body.answeredBy || '').toString();

    console.log('Call status:', callSid, callStatus, 'AnsweredBy:', answeredBy);

    if (answeredBy && answeredBy.toLowerCase().includes('machine')) {
      const action = CALL_PROFILE.machine_detection && CALL_PROFILE.machine_detection.action_on_machine;
      if (process.env.MAKE_WEBHOOK_URL) {
        await fetch(process.env.MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'voicemail', call_sid: callSid, answered_by: answeredBy, action, timestamp: new Date().toISOString() })
        });
      }
    } else {
      if (process.env.MAKE_WEBHOOK_URL) {
        await fetch(process.env.MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'status', call_sid: callSid, stato_chiamata: callStatus, timestamp: new Date().toISOString() })
        });
      }
    }

    res.send('OK');
  } catch (e) {
    console.error('twilio/status error', e && e.stack ? e.stack : e);
    res.status(500).send('Errore interno');
  }
});

// Twilio transcribe callback
app.post('/twilio/transcribe', async (req, res) => {
  try {
    if (process.env.MAKE_WEBHOOK_URL) {
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'transcribe', payload: req.body, timestamp: new Date().toISOString() })
      });
    }
    res.send('OK');
  } catch (e) {
    console.error('twilio/transcribe error', e && e.stack ? e.stack : e);
    res.status(500).send('Errore interno');
  }
});

// HTTP + WebSocket server
const server = http.createServer(app);

// Use explicit path '/twilio' unless your CALL_PROFILE overrides it
const wssPath = (CALL_PROFILE.media && CALL_PROFILE.media.twilio_stream_path) ? CALL_PROFILE.media.twilio_stream_path : '/twilio';
const wss = new WebSocket.Server({ server, path: wssPath });

// WSS: gestione connessioni
wss.on('connection', (ws, req) => {
  const fullUrl = req.url || '';
  const query = fullUrl.split('?')[1] || '';
  const qs = new URLSearchParams(query);
  const callSid = qs.get('callSid') || `cs_${Date.now()}`;

  console.log('WS: incoming connection', { url: req.url, callSid, headers: {
    host: req.headers.host,
    origin: req.headers.origin,
    'user-agent': req.headers['user-agent'],
    'sec-websocket-protocol': req.headers['sec-websocket-protocol']
  }});

  sessions[callSid] = sessions[callSid] || { state: 'OPENING', transcript: [], extracted: {}, speaking: false, sttBuffer: [], lastActivity: Date.now() };
  console.log('WS connected for', callSid);

  // INVIO chunk di test immediato (serve per verificare che Twilio riproduca audio proveniente dall'orchestrator)
  try {
    let testB64 = null;
    const b64Path = path.join(__dirname, 'public', 'audio', 'test16.b64');
    if (fs.existsSync(b64Path)) {
      testB64 = fs.readFileSync(b64Path, 'utf8');
    } else {
      const mp3Path = path.join(__dirname, 'public', 'audio', 'silence.mp3');
      if (fs.existsSync(mp3Path)) {
        const mp3buf = fs.readFileSync(mp3Path);
        testB64 = mp3buf.toString('base64');
      }
    }
    if (testB64) {
      ws.send(JSON.stringify({ event: 'media', media: { payload: testB64 } }));
      console.log('Sent initial test audio chunk to Twilio for', callSid);
    } else {
      console.warn('No test audio file found for immediate push (create public/audio/test16.b64 or use silence.mp3).');
    }
  } catch (e) {
    console.error('Error sending test chunk', e && e.stack ? e.stack : e);
  }

  ws.on('message', async (msg) => {
    try {
      if (typeof msg === 'string') {
        const evt = JSON.parse(msg);
        console.log('WS event', evt.event, 'for', callSid);
        if (evt.event === 'connected') {
          console.log('Media stream connected event for', callSid);
        } else if (evt.event === 'media' && evt.media && evt.media.payload) {
          const audioBase64 = evt.media.payload;
          await forwardAudioChunkToSTT(callSid, audioBase64);
        } else if (evt.event === 'start') {
          // no-op
        } else if (evt.event === 'stop') {
          console.log('WS stop event for', callSid);
          cleanupSession(callSid);
        }
      } else {
        console.log('WS binary message received for', callSid, 'len:', msg.length);
        await forwardAudioChunkToSTT(callSid, msg);
      }
    } catch (err) {
      console.error('WS message error', err && err.stack ? err.stack : err);
    }
  });

  ws.on('close', (code, reason) => {
    console.log('WS closed for', callSid, 'code:', code, 'reason:', reason && reason.toString && reason.toString());
    cleanupSession(callSid);
  });

  ws.on('error', (err) => {
    console.error('WS error for', callSid, err && err.stack ? err.stack : err);
  });

  ws.on('unexpected-response', (req, res) => {
    console.warn('WS unexpected-response for', callSid, 'statusCode:', res && res.statusCode);
  });
});

// forwardAudioChunkToSTT (stub)
async function forwardAudioChunkToSTT(callSid, audioBase64OrBinary) {
  const s = sessions[callSid];
  if (!s) return;
  s.lastActivity = Date.now();

  let b64;
  if (Buffer.isBuffer(audioBase64OrBinary)) {
    b64 = audioBase64OrBinary.toString('base64');
  } else {
    b64 = audioBase64OrBinary;
  }

  s.sttBuffer.push(b64);

  // Simula trascrizione per test: dopo 30 chunk invoca handleSttFinal
  if (s.sttBuffer.length >= 30) {
    const fakeText = 'Simulazione: ho problemi di navigazione da due giorni';
    await handleSttFinal(callSid, fakeText);
    s.sttBuffer = [];
  }
}

// handleSttFinal (flow minimale)
async function handleSttFinal(callSid, text) {
  const s = sessions[callSid];
  if (!s) return;
  s.transcript.push(text);
  s.lastActivity = Date.now();

  const simMatch = text.match(/(\d+)\s*(schede|sim|simcard|scheda)/i);
  if (simMatch) s.extracted.sim_count = parseInt(simMatch[1], 10);

  s.state = s.extracted.sim_count ? 'ASK_BILL' : 'ASK_SIM';

  let promptText;
  try {
    promptText = buildPrompt(s.state, s, CALL_PROFILE);
  } catch (err) {
    promptText = CALL_PROFILE.script && CALL_PROFILE.script.opening ? CALL_PROFILE.script.opening : 'Buongiorno';
  }

  try {
    const audioBuffer = await generateAudio(promptText, CALL_PROFILE);
    const filename = `prompt_${callSid}_${Date.now()}.mp3`;
    const audioUrl = await uploadAudio(audioBuffer, filename);
    console.log('Generated reply audioUrl for', callSid, audioUrl);

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
    console.error('Errore generazione reply audio', err && err.stack ? err.stack : err);
  }
}

// Avvio server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server + WS attivo su porta ${PORT}`);
});
