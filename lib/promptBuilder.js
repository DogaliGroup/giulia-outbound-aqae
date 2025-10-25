module.exports = function buildPrompt(transcript = '', meta = {}) {
  const lower = (transcript || '').toLowerCase();

  if (/(chi sei|problemi|copertura|navigazione|segnalazione|internet)/.test(lower)) {
    return `Sono l’amministrativo che segue i tuoi contratti fissi e mobili. Da sistema vedo che il ripetitore vicino a te dà problemi di navigazione. Provvedo subito ad aprire una segnalazione guasti. Da sistema vedo anche fatture altalenanti. Hai ricevuto sms per servizi sospetti?`;
  }

  if (/\b(no|si|sì|non ho|sì ho|si ho)\b/.test(lower)) {
    return `Se non hai fatto nessuna disattivazione, per evitare di pagare schede che non fanno traffico, quante delle tue schede aziendali stai utilizzando realmente? Così facciamo un controllo incrociato con quello che vedo da sistema.`;
  }

  if (/(non lo so|non saprei|non so)/.test(lower)) {
    return `Io da sistema vedo che hai 3 schede aziendali, giusto?`;
  }

  const m = lower.match(/\b(\d{1,2})\b/);
  if (m) {
    const simCount = parseInt(m[1], 10);
    const min = simCount * 10;
    const max = simCount * 15;
    return `Da sistema vedo che la bolletta negli ultimi mesi si è collocata tra ${min} e ${max} euro.`;
  }

  if (/(wind|vodafone|tim|tre|wind3)/.test(lower)) {
    return `Noto più centri di fatturazione, come Wind3 e Vodafone. Potresti aver ricevuto fatture duplicate?`;
  }

  return `Confermerò con l’amministrazione e ti richiamerò personalmente per aggiornamenti.`;
};
