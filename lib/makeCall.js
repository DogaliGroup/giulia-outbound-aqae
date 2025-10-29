// lib/makeCall.js
const Twilio = require('twilio');

module.exports = async function makeCall(toNumber, silenceUrl, metaObj = {}, CALL_PROFILE = {}) {
  const accountSid = process.env.TWILIO_SID;
  const authToken = process.env.TWILIO_TOKEN;
  const fromNumber = process.env.TWILIO_NUMBER;
  if (!accountSid || !authToken || !fromNumber) throw new Error('Twilio vars missing');

  const client = new Twilio(accountSid, authToken);

  // assicurati che SERVER_BASE_URL non finisca con slash
  const base = (process.env.SERVER_BASE_URL || '').replace(/\/$/, '');
  const streamPath = (CALL_PROFILE.media && CALL_PROFILE.media.twilio_stream_path) ? CALL_PROFILE.media.twilio_stream_path : '/twilio';
  const streamUrl = `wss://${base.replace(/^https?:\/\//, '')}${streamPath}?meta=${Buffer.from(JSON.stringify(metaObj)).toString('base64')}`;

  // TwiML che apre solo lo stream (no Say/Play) — debug-friendly
  const twiml = `<Response><Start><Stream url="${streamUrl}"/></Start></Response>`;

  const call = await client.calls.create({
    to: toNumber,
    from: fromNumber,
    twiml,
    statusCallback: `${base}/twilio/status`,
    statusCallbackEvent: ['initiated','ringing','answered','completed']
  });

  console.log('makeCall created', { toNumber, callSid: call.sid });
  return call.sid;
};
