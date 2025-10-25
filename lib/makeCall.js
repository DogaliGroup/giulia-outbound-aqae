const twilio = require('twilio');
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

module.exports = async function makeCall(to, audioUrl, meta = {}) {
  if (!process.env.TWILIO_NUMBER) throw new Error('TWILIO_NUMBER not set');

  const twiml = `
    <Response>
      <Play>${audioUrl}</Play>
      <Record
        action="${process.env.SERVER_BASE_URL.replace(/\/$/, '')}/recording-callback"
        method="POST"
        maxLength="30"
        timeout="4"
        playBeep="false"
      />
    </Response>
  `;

  return client.calls.create({
    to,
    from: process.env.TWILIO_NUMBER,
    twiml,
    statusCallback: `${process.env.SERVER_BASE_URL.replace(/\/$/, '')}/call-status`,
    statusCallbackEvent: ['completed']
  });
};
