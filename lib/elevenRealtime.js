// lib/elevenRealtime.js
const WebSocket = require('ws');

const sessions = {}; // { callSid: { elevenWs, onPartial, onFinal, onAudioChunk, ttsPlaying } }

function startSession(callSid, callbacks = {}) {
  if (sessions[callSid]) return sessions[callSid];
  const apiKey = process.env.ELEVEN_API_KEY;
  if (!apiKey) throw new Error('ELEVEN_API_KEY missing');
  const model = process.env.ELEVEN_MODEL_ID || 'eleven_monolingual_v1';
  const base = process.env.ELEVEN_REALTIME_URL || 'wss://api.elevenlabs.io/realtime';
  const url = `${base}?model=${model}`;

  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });

  const sess = { elevenWs: ws, onPartial: callbacks.onPartial, onFinal: callbacks.onFinal, onAudioChunk: callbacks.onAudioChunk, ttsPlaying: false };
  sessions[callSid] = sess;

  ws.on('open', () => {
    console.log('elevenRealtime open', callSid);
  });

  ws.on('message', (msg) => {
    // Try parse JSON control messages; otherwise treat as audio binary
    if (Buffer.isBuffer(msg)) {
      // binary audio chunk -> forward base64 via callback
      const b64 = msg.toString('base64');
      if (sess.onAudioChunk) sess.onAudioChunk(b64);
      return;
    }
    try {
      const parsed = JSON.parse(msg.toString());
      // Adapt these branches if ElevenLabs uses different field names
      if (parsed.type === 'stt.partial' || parsed.type === 'transcript.partial') {
        if (sess.onPartial) sess.onPartial(parsed.text || parsed.partial || '');
      } else if (parsed.type === 'stt.final' || parsed.type === 'transcript.final') {
        if (sess.onFinal) sess.onFinal(parsed.text || parsed.final || '');
      } else if (parsed.type === 'output_audio_buffer.delta' && parsed.audio) {
        if (sess.onAudioChunk) sess.onAudioChunk(parsed.audio);
      } else {
        // catch-all debug
        console.log('elevenRealtime msg control', callSid, parsed.type || '(no type)');
      }
    } catch (e) {
      // non-json: ignore or log
      console.warn('elevenRealtime parse error', e && e.message ? e.message : e);
    }
  });

  ws.on('error', (e) => {
    console.error('elevenRealtime error', callSid, e && e.message ? e.message : e);
  });

  ws.on('close', (code) => {
    console.log('elevenRealtime closed', callSid, code);
    delete sessions[callSid];
  });

  return sess;
}

function sendAudioToSTT(callSid, audioBase64) {
  const s = sessions[callSid];
  if (!s || !s.elevenWs || s.elevenWs.readyState !== WebSocket.OPEN) return false;
  // frame according to expected API: input_audio_buffer.append
  try {
    s.elevenWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioBase64 }));
    return true;
  } catch (e) {
    console.error('sendAudioToSTT error', e && e.message ? e.message : e);
    return false;
  }
}

function commitAudio(callSid) {
  const s = sessions[callSid];
  if (!s || !s.elevenWs || s.elevenWs.readyState !== WebSocket.OPEN) return false;
  try {
    s.elevenWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    // ask STT to recognize now
    s.elevenWs.send(JSON.stringify({ type: 'stt.recognize' }));
    return true;
  } catch (e) {
    console.error('commitAudio error', e && e.message ? e.message : e);
    return false;
  }
}

function requestTTS(callSid, text) {
  const s = sessions[callSid];
  if (!s || !s.elevenWs || s.elevenWs.readyState !== WebSocket.OPEN) return false;
  try {
    // request streaming synth; adjust fields to match ElevenLabs realtime API
    s.elevenWs.send(JSON.stringify({ type: 'synthesis.start', text }));
    s.ttsPlaying = true;
    return true;
  } catch (e) {
    console.error('requestTTS error', e && e.message ? e.message : e);
    return false;
  }
}

function cancelTTS(callSid) {
  const s = sessions[callSid];
  if (!s || !s.elevenWs) return false;
  try {
    s.elevenWs.send(JSON.stringify({ type: 'synthesis.cancel' }));
  } catch (e) {}
  s.ttsPlaying = false;
  return true;
}

function closeSession(callSid) {
  const s = sessions[callSid];
  if (!s) return false;
  try { s.elevenWs.close(); } catch(e){}
  delete sessions[callSid];
  return true;
}

module.exports = { startSession, sendAudioToSTT, commitAudio, requestTTS, cancelTTS, closeSession };
