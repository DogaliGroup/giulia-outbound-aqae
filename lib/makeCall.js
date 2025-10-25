// makeCall.js
const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

/**
 * Helper: serializza un oggetto JS in Base64 URL-safe per metterlo come query param
 */
function encodeMeta(meta){
  try {
    const json = JSON.stringify(meta || {});
    const b64 = Buffer.from(json).toString('base64');
    return encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  } catch (e) {
    return '';
  }
}

/**
 * makeCall
 * - to: numero destinatario in E.164
 * - audioUrl: URL file da riprodurre
 * - meta: oggetto con dati del bot 1.0 (es: { row_id, first_name, phone, campaign, ... })
 */
module.exports = async function makeCall(to, audioUrl, meta = {}) {
  if (!process.env.TWILIO_NUMBER) throw new Error('TWILIO_NUMBER not set');
  if (!process.env.MAKE_WEBHOOK_URL && !process.env.SERVER_BASE_URL) throw new Error('MAKE_WEBHOOK_URL or SERVER_BASE_URL must be set');

  const metaToken = encodeMeta(meta);
  const cbBase = process.env.MAKE_WEBHOOK_URL || process.env.SERVER_BASE_URL.replace(/\/$/, '');
  const statusCb = `${cbBase}/twilio/status?meta=${metaToken}`;
  const recordAction = `${cbBase}/twilio/recording?meta=${metaToken}`;
  const transcribeCb = `${cbBase}/twilio/transcribe?meta=${metaToken}`;

  const twiml = `<Response>
    <Play>${audioUrl}</Play>
    <Record
      action="${recordAction}"
      method="POST"
      maxLength="300"
      timeout="60"
      playBeep="false"
      transcribe="true"
      transcribeCallback="${transcribeCb}"
    />
  </Response>`;

  const call = await twilio.calls.create({
    to,
    from: process.env.TWILIO_NUMBER,
    twiml,
    statusCallback: statusCb,
    statusCallbackEvent: ['initiated','ringing','answered','completed','failed','no-answer'],
    statusCallbackMethod: 'POST'
  });

  return call.sid;
};
