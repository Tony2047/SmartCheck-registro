import { createClient } from '@supabase/supabase-js'

// Collegamento al Database
const supabase = createClient(
  'https://axlfuzksfpfwdvjawlmf.supabase.co', 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4bGZ1emtzZnBmd2R2amF3bG1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5MzYyMzYsImV4cCI6MjA4NDUxMjIzNn0.Xga9UIWfS8rYxGYZs-Cz446GZkVhPCxeUvV8UUTlXEg'
)

export default async function handler(req, res) {
  // Configurazione CORS
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const body = req.body || req.query;
  const tagID = body.tagID;
  const inputType = body.type || 'short'; 

  if (!tagID) return res.status(400).json({ error: 'Manca tagID' });

  try {
    // 1. Identifica Studente
    const { data: user, error: userError } = await supabase
      .from('registry').select('*').eq('nfc_id', tagID).single();

    if (userError || !user) return res.status(404).json({ error: 'Badge sconosciuto', color: 'rosso' });

    // 2. Calcola Ora Italiana
    const now = new Date();
    const italyTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Rome"}));
    const minutes = italyTime.getHours() * 60 + italyTime.getMinutes(); 
    
    const dateStr = italyTime.toLocaleDateString('it-IT', {year: 'numeric', month: '2-digit', day: '2-digit'}).split('/').reverse().join('-'); 
    const timeStr = italyTime.toLocaleTimeString('it-IT', {hour: '2-digit', minute:'2-digit'});

    // 3. Controlla lo stato attuale nel DB
    const { data: currentRecord } = await supabase
      .from('attendance')
      .select('status')
      .eq('student_name', user.full_name)
      .eq('date', dateStr)
      .single();

    let newStatus = 'presente';
    let ledColor = 'verde';
    let msg = 'Operazione Completata';
    let updateDb = true; 

    // --- LOGICA ORARIA E STATI ---

    // A. POMERIGGIO (> 15:00) -> Riapertura (900 minuti)
    if (minutes >= 900) {
        newStatus = 'presente';
        ledColor = 'verde';
        msg = 'Ingresso Pomeridiano';
    }
    // B. SCUOLA CHIUSA (13:35 - 15:00) -> STATO CONGELATO
    // 13:35 = 815 minuti
    else if (minutes >= 815 && minutes < 900) {
        updateDb = false; // NON aggiorniamo il DB
        ledColor = 'verde_f'; // Feedback "Letto OK"
        msg = 'Scuola Chiusa - Stato Salvato';
        newStatus = currentRecord ? currentRecord.status : 'assente';
    }
    // C. MATTINA (Fino alle 13:35)
    else {
        if (inputType === 'exit') {
            newStatus = 'uscita_anticipata';
            ledColor = 'uscita';
            msg = 'Uscita Anticipata';
        } 
        else if (inputType === 'bath') {
            if (currentRecord && currentRecord.status === 'bagno') {
                newStatus = 'presente'; 
                ledColor = 'verde';
                msg = 'Rientro dal Bagno';
            } else {
                newStatus = 'bagno'; 
                ledColor = 'blu';
                msg = 'Uscita Bagno';
            }
        } 
        else {
            // ENTRATA (Tocco Corto)
            if (currentRecord && currentRecord.status !== 'assente') {
                 // Già presente -> Ignora
                 updateDb = false;
                 ledColor = 'verde_f'; 
                 msg = 'Già Presente';
                 newStatus = currentRecord.status;
            } else {
                // PRIMA TIMBRATA
                // < 08:40 (520 min)
                if (minutes < 520) { 
                    newStatus = 'presente'; ledColor = 'verde'; msg = 'Entrata Regolare';
                } 
                // 08:40 - 09:35 (520 - 575 min)
                else if (minutes >= 520 && minutes < 575) { 
                    newStatus = 'ritardo'; ledColor = 'giallo'; msg = 'Entrata in Ritardo';
                } 
                // 09:35 - 13:35 (575 - 815 min)
                else { 
                    newStatus = 'seconda_ora'; ledColor = 'viola'; msg = 'Entrata 2° Ora';
                }
            }
        }
    }

    // 4. Salva su Database
    if (updateDb) {
        await supabase.from('attendance').upsert({
            student_name: user.full_name,
            date: dateStr,
            status: newStatus,
            time: timeStr
        }, { onConflict: 'student_name, date' });
    }

    return res.status(200).json({ success: true, message: msg, status: newStatus, color: ledColor });

  } catch (error) {
    return res.status(500).json({ error: error.message, color: 'rosso' });
  }
}
