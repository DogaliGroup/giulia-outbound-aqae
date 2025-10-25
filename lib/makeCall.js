const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function makeCall(to, audioUrl, row_id){
  const twiml = `<Response>
    <Play>${audioUrl}</Play>
    <Record action="${process.env.MAKE_WEBHOOK_URL}" method="POST" maxLength="30" timeout="4" playBeep="false"/>
  </Response>`;

  const call = await twilio.calls.create({
    to,
    from: process.env.TWILIO_NUMBER,
    twiml,
    statusCallback: process.env.MAKE_WEBHOOK_URL,
    statusCallbackEvent: ['initiated','ringing','answered','completed'],
    statusCallbackMethod: 'POST'
  });

  return call.sid;
}
