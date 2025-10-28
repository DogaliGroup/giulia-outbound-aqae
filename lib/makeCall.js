// lib/makeCall.js
const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

/**
 * Helper: serializza un oggetto JS in Base64 URL-safe per metterlo come query param
 */
function encodeMeta(meta){
  try {
    const json = JSON.stringify(meta || {});
    const b64 = Buffer.from(json).toString('base64');
    // URL-safe base64
    return encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  } catch (e) {
    return '';
  }
}

/**
 * buildTwiml: costruisce TwiML con Start->Stream e un primo speak/opening
 * - serverBase: SERVER_BASE_URL senza slash finale
 * - streamPath: percorso preso da CALL_PROFILE.media.twilio_stream_path (es. /stream)
 */
function buildTwiml(metaToken, CALL_PROFILE, first_name) {
  const serverBase = (process.env.SERVER_BASE_URL || '').replace(/\/$/, '');
  const streamPath = (CALL_PROFILE && CALL_PROFILE.media && CALL_PROFILE.media.twilio_stream_path) ? CALL_PROFILE.media.twilio_stream_path : '/stream';
  // Assicuriamoci che ci sia la slash tra serverBase e streamPath
  const normalizedStreamPath = streamPath.startsWith('/') ? streamPath : '/' + streamPath;
  const streamUrl = `${serverBase}${normalizedStreamPath}?callSid={{CallSid}}&meta=${metaToken}`;

  const opening = (CALL_PROFILE && CALL_PROFILE.script && CALL_PROFILE.script.opening)
    ? CALL_PROFILE.script.opening.replace(/\{\{first_name\}\}/g, first_name || '')
    : (first_name ? `Buongiorno ${first_name}` : 'Buongiorno');

  const language = (CALL_PROFILE && CALL_PROFILE.language) || 'it-IT';

  // TwiML: Start Stream then short message (Twilio <Say> used as fallback if you don't stream TTS immediately)
  return `
<Response>
  <Start>
    <Stream url="${streamUrl}" />
  </Start>
  <Say voice="alice" language="${language}">Un attimo, ti metto in collegamento con il servizio.</Say>
  <Pause length="0.2"/>
  <Say voice="alice" language="${language}">${opening}</Say>
</Response>`;
}

/**
 * makeCall
 * - to: numero destinatario in E.164
 * - audioUrl: (legacy) non più necessario per stream flows but kept for compatibility
 * - meta: oggetto con dati (es: { row_id, first_name, phone, campaign, ... })
 * - CALL_PROFILE: oggetto di configurazione caricato da config/index.js
 */
module.exports = async function makeCall(to, audioUrl, meta = {}, CALL_PROFILE = {}) {
  // Validazioni iniziali
  if (!process.env.TWILIO_NUMBER) throw new Error('TWILIO_NUMBER not set');
  if (!process.env.TWILIO_SID || !process.env.TWILIO_TOKEN) throw new Error('TWILIO credentials missing');
  if (!process.env.SERVER_BASE_URL && !process.env.MAKE_WEBHOOK_URL) throw new Error('SERVER_BASE_URL or MAKE_WEBHOOK_URL must be set');

  // Meta token url-safe
  const metaToken = encodeMeta(meta);

  // Callback base: preferiamo MAKE_WEBHOOK_URL se presente (per testing), altrimenti SERVER_BASE_URL
  const cbBase = process.env.MAKE_WEBHOOK_URL || (process.env.SERVER_BASE_URL || '').replace(/\/$/, '');
  const statusCb = `${cbBase}/twilio/status?meta=${metaToken}`;
  const recordAction = `${cbBase}/twilio/recording?meta=${metaToken}`;
  const transcribeCb = `${cbBase}/twilio/transcribe?meta=${metaToken}`;

  // Costruzione TwiML con Start->Stream
  const first_name = meta.first_name || '';
  const twiml = buildTwiml(metaToken, CALL_PROFILE, first_name);

  // Opzioni create call
  const createOpts = {
    to,
    from: process.env.TWILIO_NUMBER,
    twiml,
    statusCallback: statusCb,
    statusCallbackEvent: ['initiated','ringing','answered','completed','failed','no-answer'],
    statusCallbackMethod: 'POST'
  };

  // Timeout di connessione chiamata dal profilo
  if (CALL_PROFILE && CALL_PROFILE.timeouts && Number.isFinite(CALL_PROFILE.timeouts.call_connect_timeout_seconds)) {
    createOpts.timeout = CALL_PROFILE.timeouts.call_connect_timeout_seconds;
  }

  // Machine detection dal profilo
  if (CALL_PROFILE && CALL_PROFILE.machine_detection && CALL_PROFILE.machine_detection.enabled) {
    createOpts.machineDetection = 'Enable';
    if (Number.isFinite(CALL_PROFILE.machine_detection.timeout_seconds)) {
      createOpts.machineDetectionTimeout = CALL_PROFILE.machine_detection.timeout_seconds;
    }
  }

  // Record/Play fallback opzionale (non sovrascrive il TwiML principale)
  if (CALL_PROFILE && CALL_PROFILE.media && CALL_PROFILE.media.use_record_play_fallback) {
    // Qui potresti applicare un comportamento di fallback, ma lasciamo il flusso stream come default.
    // Manteniamo lo spazio per future modifiche.
  }

  // DEBUG: log TwiML e create call con output utile per diagnosi
  console.log('DEBUG: TwiML =>', twiml);
  try {
    const call = await twilio.calls.create(createOpts);
    console.log('DEBUG: Twilio call created', { to, callSid: call.sid, status: call.status });
    return call.sid;
  } catch (err) {
    console.error('DEBUG: Twilio create call error', err && err.message, err && err.code);
    throw err;
  }
};
