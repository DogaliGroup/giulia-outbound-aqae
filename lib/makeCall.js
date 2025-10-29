// lib/makeCall.js
const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

function encodeMeta(meta){
  try {
    const json = JSON.stringify(meta || {});
    const b64 = Buffer.from(json).toString('base64');
    return encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  } catch (e) {
    return '';
  }
}

function buildTwiml(metaToken, CALL_PROFILE, first_name) {
  const serverBase = (process.env.SERVER_BASE_URL || '').replace(/\/$/, '');
  const streamPath = (CALL_PROFILE && CALL_PROFILE.media && CALL_PROFILE.media.twilio_stream_path) ? CALL_PROFILE.media.twilio_stream_path : '/stream';
  const normalizedStreamPath = streamPath.startsWith('/') ? streamPath : '/' + streamPath;

  const rawStreamUrl = `${serverBase}${normalizedStreamPath}?callSid={{CallSid}}&meta=${metaToken}`;
  const streamUrl = rawStreamUrl.replace(/&/g, '&amp;');

  const opening = (CALL_PROFILE && CALL_PROFILE.script && CALL_PROFILE.script.opening)
    ? CALL_PROFILE.script.opening.replace(/\{\{first_name\}\}/g, first_name || '')
    : (first_name ? `Buongiorno ${first_name}` : 'Buongiorno');

  const language = (CALL_PROFILE && CALL_PROFILE.language) || 'it-IT';

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

module.exports = async function makeCall(to, audioUrl, meta = {}, CALL_PROFILE = {}) {
  if (!process.env.TWILIO_NUMBER) throw new Error('TWILIO_NUMBER not set');
  if (!process.env.TWILIO_SID || !process.env.TWILIO_TOKEN) throw new Error('TWILIO credentials missing');
  if (!process.env.SERVER_BASE_URL && !process.env.MAKE_WEBHOOK_URL) throw new Error('SERVER_BASE_URL or MAKE_WEBHOOK_URL must be set');

  const metaToken = encodeMeta(meta);
  const cbBase = process.env.MAKE_WEBHOOK_URL || (process.env.SERVER_BASE_URL || '').replace(/\/$/, '');
  const statusCb = `${cbBase}/twilio/status?meta=${metaToken}`;
  const recordAction = `${cbBase}/twilio/recording?meta=${metaToken}`;
  const transcribeCb = `${cbBase}/twilio/transcribe?meta=${metaToken}`;

  const first_name = meta.first_name || '';
  const twiml = buildTwiml(metaToken, CALL_PROFILE, first_name);

  // NOTE: removed statusCallbackEvent to avoid 21626
  const createOpts = {
    to,
    from: process.env.TWILIO_NUMBER,
    twiml,
    statusCallback: statusCb,
    statusCallbackMethod: 'POST'
  };

  if (CALL_PROFILE && CALL_PROFILE.timeouts && Number.isFinite(CALL_PROFILE.timeouts.call_connect_timeout_seconds)) {
    createOpts.timeout = CALL_PROFILE.timeouts.call_connect_timeout_seconds;
  }
  if (CALL_PROFILE && CALL_PROFILE.machine_detection && CALL_PROFILE.machine_detection.enabled) {
    createOpts.machineDetection = 'Enable';
    if (Number.isFinite(CALL_PROFILE.machine_detection.timeout_seconds)) {
      createOpts.machineDetectionTimeout = CALL_PROFILE.machine_detection.timeout_seconds;
    }
  }

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
