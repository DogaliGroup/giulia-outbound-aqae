# Giulia Outbound AI

Progetto Node.js per chiamate outbound con logica "user speaks first".  
Il bot usa ElevenLabs per TTS, STT (se disponibile) o Whisper, Twilio per chiamate/registrazioni e Make.com per l'orchestrazione.

---

## Panoramica veloce
Flusso:
1. Make legge il Google Sheet e chiama l'endpoint `/start-call` del server (Railway).  
2. Server avvia una chiamata Twilio che riproduce `public/audio/silence.mp3` e registra la risposta del cliente.  
3. Twilio POSTa la registrazione a `/recording-callback`.  
4. Server trascrive, costruisce la risposta seguendo la scaletta Giulia (`lib/promptBuilder.js`), genera audio con ElevenLabs, salva l'audio e avvia una chiamata che riproduce la risposta.  
5. Make aggiorna il Google Sheet con esiti e dati estratti.

Obiettivi principali della conversazione:
- Intuire indirettamente il numero di SIM aziendali.
- Stimare la bolletta come range (min = SIM * 10€, max = SIM * 15€).
- Opzionale: identificare l'operatore tramite indizi indiretti.
- Linguaggio: frasi concise, scandite, senza "dovrebbe".

---

## Struttura repository (percorsi esatti)

giulia-outbound-aqae/ 
├── server.js 
├── .env.example 
├── lib/ 
│ ├── generateAudio.js 
│ ├── uploadAudio.js 
│ ├── makeCall.js 
│ ├── promptBuilder.js 
│ └── transcribeAudio.js 
└── public/ 
└── audio/ 
└── silence.mp3


---

## Variabili ambiente (inserire su Railway → Service Node.js → Variables)
Copia esattamente questi nomi e valori reali:

- `AUTH_TOKEN_MAKE` = token per proteggere `/start-call` (es. `giulia123`)  
- `ELEVEN_API_KEY` = chiave ElevenLabs (es. `sk-...`)  
- `ELEVEN_VOICE_ID` = ID voce ElevenLabs (es. `21mZ4...`)  
- `ELEVEN_MODEL_ID` = `eleven_multilingual_v2`  
- `PORT` = (opzionale) Railway imposta automaticamente  
- `SERVER_BASE_URL` = URL pubblico Railway (es. `https://giulia-outbound-aqae.up.railway.app`)  
- `STORAGE_MODE` = `railway` (dev) | `twilio_assets` | `r2` (prod senza AWS)  
- `TWILIO_NUMBER` = numero Twilio in E.164 (es. `+39...`)  
- `TWILIO_SID` = Twilio Account SID (es. `AC...`)  
- `TWILIO_TOKEN` = Twilio Auth Token

Nota: non mettere chiavi nel codice; usale solo come Variables su Railway.

---

## File principali e ruolo (breve)
- `server.js` — entrypoint Express; espone `/health`, `/start-call`, `/recording-callback`, `/call-status`.  
- `lib/generateAudio.js` — chiama ElevenLabs TTS e restituisce Buffer MP3.  
- `lib/uploadAudio.js` — salva buffer come file in `public/audio/` (o su storage configurato) e restituisce URL pubblico.  
- `lib/makeCall.js` — crea chiamata Twilio: `<Play>audio</Play>` + `<Record action="/recording-callback" />`.  
- `lib/promptBuilder.js` — implementa la scaletta Giulia (templates, IF/ELSE, calcolo range).  
- `lib/transcribeAudio.js` — scarica recording e invia a ElevenLabs STT o a Whisper; restituisce transcript.  
- `public/audio/silence.mp3` — MP3 silenzioso (~1s) usato per "user speaks first".

---

## Step‑by‑step: setup minimo (senza installare nulla localmente)
1. Crea repository su GitHub (es. `giulia-outbound-aqae`).  
2. Aggiungi i file nella struttura sopra: usa `Add file → Create new file` per i .js e `Add file → Upload files` per `silence.mp3`.  
3. Su Railway: New Project → Deploy from GitHub → seleziona il repo.  
4. Su Railway → apri il servizio Node.js → **Variables** → aggiungi tutte le variabili elencate sopra → clicca **Deploy Changes**.  
5. Su Make: crea/aggiorna Scenario:
   - Google Sheets → Search Rows (filtro `stato_chiamata = da_chiamare`)  
   - Iterator → HTTP (Make a Request) → POST `${SERVER_BASE_URL}/start-call`  
     - Headers: `Authorization: Bearer <AUTH_TOKEN_MAKE>`, `Content-Type: application/json`  
     - Body JSON: `{ "first_name": "{{first_name}}", "phone_number": "{{phone_number}}", "row_id": "{{RowID}}" }`  
   - Google Sheets → Update Row (aggiorna `stato_chiamata`, `call_sid`, `audio_url`, `timestamp`)  
6. Test rapido: imposta una riga di prova in Google Sheet e lancia lo scenario. Controlla logs Railway e Twilio.

---

## Come funziona `/start-call` e "user speaks first"
- `/start-call` valida `Authorization: Bearer AUTH_TOKEN_MAKE`.  
- Il server chiama `makeCall(phone_number, silenceUrl)` dove `silenceUrl = ${SERVER_BASE_URL}/audio/silence.mp3`.  
- TwiML utilizzata in `makeCall` deve fare `<Play>silence.mp3</Play>` seguito da `<Record action="/recording-callback" ... />`.  
- Quando Twilio POSTa `/recording-callback` con `RecordingUrl` e `From`:
  1. Server scarica la registrazione.  
  2. `transcribeAudio` converte audio → testo (ElevenLabs STT o Whisper).  
  3. `promptBuilder` costruisce la risposta seguendo la scaletta Giulia.  
  4. `generateAudio` crea MP3; `uploadAudio` lo salva e restituisce URL.  
  5. Server lancia `makeCall(from, responseAudioUrl)` per riprodurre la risposta.

---

## PromptBuilder: regole essenziali (comportamento richiesto)
- Tono: italiano corretto, deciso, frasi concise.  
- Non usare "dovrebbe"; dire "Da sistema risulta/vedo ...".  
- Se sim_count trovato → calcola range: min = sim*10, max = sim*15 (es. `3 SIM → 30–45 €`).  
- Se sim_count mancante → usare wording che afferma il dato "Da sistema vedo 3 schede aziendali, giusto?" per provocare conferma.  
- Gestisci risposte: numeri, “non lo so”, affermativo/negativo, nomi operatori.  
- Massimo 2 tentativi per domanda; poi fallback a "Confermerò con l’amministrazione..." o schedule callback.

---

## Storage audio — opzione Railway Hobby (dev) e opzioni prod senza AWS
- Dev rapido: `STORAGE_MODE=railway` → salva in `public/audio/` (committare solo file statici; runtime scrittura funziona ma non è persistente/robusto per migliaia di file).  
- Test rapido: Twilio Assets (con Twilio Console) — upload manuale di file publici per Play.  
- Produzione non‑AWS consigliata: Cloudflare R2 o DigitalOcean Spaces + CDN; impostare `STORAGE_MODE=r2` e configurare credenziali R2 come Variables.  
- Raccomandazione: per ora usa Railway static per test, poi migra a R2 per volume.

---

## Google Sheet: colonne consigliate (mappatura)
Esempio colonne (come hai elencato):
- RAGIONE SOCIALE, P.IVA, NOME, COGNOME, TELEFONO, FORM. TELEFONO, CHIAMATA FATTA?, SIM, BOLLETTA, OPERATORE, PROBLEMI, RICHIAMATA, SERVIZI DISATTIVATI, NOTE, REG MOT., CHIUSURA CHIAMATA  
Make mapperà `row_id` alla riga per aggiornamenti.

---

## Test e debug (ordine operativo)
1. Verifica `/health` → `OK`.  
2. Test ElevenLabs TTS via curl (esempio in .env.example).  
3. Test `/start-call` da Postman con header Authorization e JSON body.  
4. Controlla logs Railway per errori.  
5. Controlla Twilio Console per dettagli `call_sid` e webhook.  
6. Simula risposta vocale: Twilio registra e invia `RecordingUrl` a `/recording-callback` → verifica trascrizione e risposta.

---

## Troubleshooting rapido
- 403 su `/start-call`: controlla `Authorization` header e `AUTH_TOKEN_MAKE`.  
- No audio in call: l'`audioUrl` deve essere HTTPS diretto; niente redirect.  
- STT vuoto o errore: verifica `ELEVEN_API_KEY` e piano; se non disponibile, usa Whisper e aggiungi la relativa Variable.  
- Storage pieno/errore write: Railway Hobby ha limiti; migra a R2 per produzione.

---

## Note legali e operativa
- Usa voci per cui hai diritti d'uso. Non usare cloni vocali di persone reali senza consenso.  
- Informare l'interlocutore quando richiesto dalla legge regionale (transparenza).
