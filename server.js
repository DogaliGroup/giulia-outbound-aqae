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

// Import lib
const generateAudio = require('./lib/generateAudio');
const uploadAudio = require('./lib/uploadAudio');
const makeCall = require('./lib/makeCall');
const buildPrompt = require('./lib/promptBuilder');
const transcribeAudio = require('./lib/transcribeAudio');
const elevenRealtime = require('./lib/elevenRealtime');
const callLLM = require('./lib/llmClient');

// Express app
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

// Permetti connessioni websocket dal browser verso il tuo dominio (modifica per produzione)
app.use((req, res, next) => {
  const domain = (process.env.SERVER_BASE_URL || 'https://giulia-outbound-aqae.up.railway.app').replace(/^https?:\/\//, '');
  const csp = [
    "default-src 'self' 'unsafe-inline' https: data:",
    `connect-src 'self' wss://${domain} https:`,
    "img-src 'self' data: https:",
    "font-src 'self' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "script-src 'self' 'unsafe-inline' https:"
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  next();
});

// Request logger (Twilio relevant)
app.use((req, res, next) => {
  if ((req.path || '').startsWith('/twilio') || req.path === '/start-call') {
    try { console.log('INCOMING HTTP', req.method, req.path, 'Query:', req.query, 'Body:', JSON.stringify(req.body).slice(0,2000)); } catch(e){ console.log('INCOMING HTTP (no stringify)', req.method, req.path); }
  }
  next();
});

// Session store in-memory
const sessions = {};
function makeMetaToken(metaObj = {}) { try { return Buffer.from(JSON.stringify(metaObj)).toString('base64'); } catch(e){ return ''; } }
function cleanupSession(callSid) { if (sessions[callSid]) { try { elevenRealtime.closeSession(callSid); } catch(e){} delete sessions[callSid]; console.log('Cleaned session', callSid); } }

// Health
app.get('/health', (_, res) => res.send('OK'));

// START CALL
app.post('/start-call', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.AUTH_TOKEN_MAKE}`) return res.status(403).send('Forbidden');
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

// Twilio recording
app.post('/twilio/recording', async (req, res) => {
  try {
    const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl;
    const from = req.body.From || req.body.from;
    const callSid = req.body.CallSid || req.body.callSid;

    let row_id = null;
    if (req.query.meta) {
      try { const decoded = Buffer.from(req.query.meta, 'base64').toString(); row_id = JSON.parse(decoded).row_id || null; } catch(e){ console.warn('meta decode err', e); }
    }

    if (!recordingUrl) { console.warn('Missing RecordingUrl', req.body); return res.status(400).send('Bad Request'); }

    const transcript = await transcribeAudio(recordingUrl);
    const replyPrompt = buildPrompt(transcript, { from }, CALL_PROFILE);
    const audioBuffer = await generateAudio(replyPrompt, CALL_PROFILE);
    const filename = `response_${Date.now()}.mp3`;
    const audioUrl = await uploadAudio(audioBuffer, filename);

    if (process.env.MAKE_WEBHOOK_URL) {
      try {
        await fetch(process.env.MAKE_WEBHOOK_URL, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({
          type: 'recording', row_id, call_sid: callSid, transcript, audio_url: audioUrl, stato_chiamata: 'chiamata_effettuata', timestamp: new Date().toISOString()
        })});
      } catch(err){ console.error('Errore inoltro recording a Make:', err); }
    }

    return res.send('OK');
  } catch (e) {
    console.error('twilio/recording error', e && e.stack ? e.stack : e);
    return res.status(500).send('Errore interno');
  }
});

// Twilio status (voicemail/AMD)
app.post('/twilio/status', async (req, res) => {
  try {
    const callSid = req.body.CallSid || req.body.callSid;
    const callStatus = req.body.CallStatus || req.body.callStatus;
    const answeredBy = (req.body.AnsweredBy || req.body.answeredBy || '').toString();

    console.log('Call status:', callSid, callStatus, 'AnsweredBy:', answeredBy);

    if (answeredBy && answeredBy.toLowerCase().includes('machine')) {
      const action = CALL_PROFILE.machine_detection && CALL_PROFILE.machine_detection.action_on_machine;
      if (process.env.MAKE_WEBHOOK_URL) {
        await fetch(process.env.MAKE_WEBHOOK_URL, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({
          type:'voicemail', call_sid: callSid, answered_by: answeredBy, action, timestamp: new Date().toISOString()
        })}).catch(()=>{});
      }
    } else {
      if (process.env.MAKE_WEBHOOK_URL) {
        await fetch(process.env.MAKE_WEBHOOK_URL, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({
          type:'status', call_sid: callSid, stato_chiamata: callStatus, timestamp: new Date().toISOString()
        })}).catch(()=>{});
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
    if (process.env.MAKE_WEBHOOK_URL) await fetch(process.env.MAKE_WEBHOOK_URL, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ type:'transcribe', payload: req.body, timestamp: new Date().toISOString() })});
    res.send('OK');
  } catch (e) { console.error('twilio/transcribe error', e && e.stack ? e.stack : e); res.status(500).send('Errore interno'); }
});

// HTTP + WSS server
const server = http.createServer(app);
const wssPath = (CALL_PROFILE.media && CALL_PROFILE.media.twilio_stream_path) ? CALL_PROFILE.media.twilio_stream_path : '/twilio';

// Debug upgrade: logga ogni richiesta di upgrade (handshake WS) per capire perché viene rifiutata
server.on('upgrade', (req, socket, head) => {
  try {
    console.log('--- UPGRADE REQUEST ---');
    console.log('url:', req.url);
    console.log('method:', req.method);
    console.log('headers:', JSON.stringify(req.headers, Object.keys(req.headers).sort(), 2));
    console.log('-----------------------');
  } catch (e) {
    console.error('upgrade log error', e && e.message ? e.message : e);
  }
  // Non chiudere la socket qui: lascia che WebSocket.Server la gestisca
});

const wss = new WebSocket.Server({ server, path: wssPath });

// WSS connection handler
wss.on('connection', (ws, req) => {
  const fullUrl = req.url || '';
  const query = fullUrl.split('?')[1] || '';
  const qs = new URLSearchParams(query);
  const callSid = qs.get('callSid') || `cs_${Date.now()}`;

  console.log('WS: incoming connection', { url: req.url, callSid, headers: req.headers });

  // init session
  sessions[callSid] = sessions[callSid] || { state: 'OPENING', transcript: [], extracted: {}, speaking: false, sttBuffer: [], lastActivity: Date.now() };
  console.log('WS connected for', callSid);

  // start eleven realtime session for this call
  const sessionCallbacks = {
    onPartial: (text) => {
      console.log('STT partial', callSid, text);
      if (process.env.MAKE_WEBHOOK_URL) fetch(process.env.MAKE_WEBHOOK_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ type:'stt_partial', call_sid:callSid, text, timestamp:new Date().toISOString() }) }).catch(()=>{});
    },
    onFinal: async (text) => {
      console.log('STT final', callSid, text);
      await handleSttFinal(callSid, text);
    },
    onAudioChunk: (chunkB64) => {
      try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event:'media', media:{ payload: chunkB64 } })); } catch (e) { console.error('forward eleven->twilio error', e && e.message ? e.message : e); }
    }
  };
  try { elevenRealtime.startSession(callSid, sessionCallbacks); } catch (e) { console.error('elevenRealtime start failed', e && e.message ? e.message : e); }

  // send initial test chunk (silence.mp3) to verify pipeline
  try {
    const mp3Path = path.join(__dirname, 'public', 'audio', 'silence.mp3');
    if (fs.existsSync(mp3Path)) {
      const mp3buf = fs.readFileSync(mp3Path);
      const testB64 = mp3buf.toString('base64');
      ws.send(JSON.stringify({ event: 'media', media: { payload: testB64 } }));
      console.log('Sent initial test audio chunk to Twilio for', callSid);
    } else {
      console.warn('No silence.mp3 for initial push');
    }
  } catch (e) { console.error('Error sending test chunk', e && e.stack ? e.stack : e); }

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

  ws.on('close', (code, reason) => { console.log('WS closed for', callSid, 'code:', code, 'reason:', reason && reason.toString && reason.toString()); cleanupSession(callSid); });
  ws.on('error', (err) => { console.error('WS error for', callSid, err && err.stack ? err.stack : err); });
  ws.on('unexpected-response', (req, res) => { console.warn('WS unexpected-response for', callSid, 'statusCode:', res && res.statusCode); });
});

// forwardAudioChunkToSTT using ElevenRealtime + barge-in
async function forwardAudioChunkToSTT(callSid, audioBase64OrBinary) {
  const s = sessions[callSid];
  if (!s) return;
  s.lastActivity = Date.now();

  let b64;
  if (Buffer.isBuffer(audioBase64OrBinary)) b64 = audioBase64OrBinary.toString('base64');
  else b64 = audioBase64OrBinary;

  function pcmBase64ToRms(b64str){
    try {
      const buf = Buffer.from(b64str,'base64');
      let sum=0, cnt=0;
      for(let i=0;i+1<buf.length;i+=2){ const sample = buf.readInt16LE(i); sum += sample*sample; cnt++; }
      return cnt?Math.sqrt(sum/cnt)/32768:0;
    } catch (e) { return 0; }
  }
  const rms = pcmBase64ToRms(b64);

  if (s.speaking && rms > 0.02) {
    console.log('BARGE-IN detected, cancelling TTS for', callSid, 'rms', rms);
    try { elevenRealtime.cancelTTS(callSid); } catch(e){}
    s.speaking = false;
  }

  const forwarded = elevenRealtime.sendAudioToSTT(callSid, b64);
  if (!forwarded) s.sttBuffer.push(b64); else s.sttBuffer.push(b64);

  if (s.sttBuffer.length >= 25) {
    elevenRealtime.commitAudio(callSid);
    s.sttBuffer = [];
  }
}

// handleSttFinal -> decide state -> callLLM -> request TTS
async function handleSttFinal(callSid, text) {
  const s = sessions[callSid];
  if (!s) return;
  s.transcript.push(text);
  s.lastActivity = Date.now();

  const simMatch = text.match(/(\d{1,3})\s*(schede|sim|simcard|scheda)/i);
  if (simMatch) s.extracted.sim_count = parseInt(simMatch[1], 10);
  s.state = s.extracted.sim_count ? 'ASK_BILL' : 'ASK_SIM';

  let promptText;
  try {
    const shortPrompt = (buildPrompt(s.state, s, CALL_PROFILE) || '') + '\nUser: ' + text;
    const llmResp = await callLLM(shortPrompt);
    promptText = (llmResp && llmResp.text) ? llmResp.text.trim() : (CALL_PROFILE.script && CALL_PROFILE.script.opening ? CALL_PROFILE.script.opening : 'Buongiorno');
  } catch (err) {
    promptText = CALL_PROFILE.script && CALL_PROFILE.script.opening ? CALL_PROFILE.script.opening : 'Buongiorno';
  }

  try {
    const audioBuffer = await generateAudio(promptText, CALL_PROFILE);
    const filename = `prompt_${callSid}_${Date.now()}.mp3`;
    const audioUrl = await uploadAudio(audioBuffer, filename);
    console.log('Generated reply audioUrl for', callSid, audioUrl);

    if (process.env.MAKE_WEBHOOK_URL) {
      await fetch(process.env.MAKE_WEBHOOK_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
        type:'reply_generated', call_sid: callSid, state: s.state, extracted: s.extracted, reply_text: promptText, reply_audio_url: audioUrl, timestamp: new Date().toISOString()
      })}).catch(()=>{});
    }

    try {
      sessions[callSid].speaking = true;
      const ok = elevenRealtime.requestTTS(callSid, promptText);
      if (!ok) console.warn('elevenRealtime.requestTTS failed, fallback to audioUrl', callSid);
      else console.log('Requested realtime TTS for', callSid);
    } catch(err) { console.error('request TTS error', err && err.message ? err.message : err); }

  } catch (err) {
    console.error('Errore generazione reply audio', err && err.stack ? err.stack : err);
  }
}

// Start HTTP + WS
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server + WS attivo su porta ${PORT}`));
