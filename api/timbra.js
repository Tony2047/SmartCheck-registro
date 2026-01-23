import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://axlfuzksfpfwdvjawlmf.supabase.co', 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4bGZ1emtzZnBmd2R2amF3bG1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5MzYyMzYsImV4cCI6MjA4NDUxMjIzNn0.Xga9UIWfS8rYxGYZs-Cz446GZkVhPCxeUvV8UUTlXEg'
)

export default async function handler(req, res) {
  // Configurazione CORS standard
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const body = req.body || req.query;
  const tagID = body.tagID;
  const pressioneMS = body.pressioneMS || 0; // Leggiamo i millisecondi dal lettore

  if (!tagID) return res.status(400).json({ error: 'Manca tagID' });

  // --- 0. LOGICA DI CONVERSIONE PRESSIONE -> TIPO AZIONE ---
  // Qui trasformiamo il tempo di pressione nel tipo di input che il tuo vecchio codice si aspetta
  let inputType = 'short'; // Default: Entrata/Tocco veloce

  if (pressioneMS >= 5000) {
      inputType = 'exit'; // Pressione lunga (> 5 sec) -> Uscita
  } else if (pressioneMS >= 2000) {
      inputType = 'bath'; // Pressione media (> 2 sec) -> Bagno
  } else {
      inputType = 'short'; // Pressione breve -> Entrata
  }

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

    // --- LOGICA GESTIONE STATI (DEMO / ORARI) ---

    // A. POMERIGGIO (> 15:00) -> MODALITÀ DEMO SBLOCCATA
    if (minutes >= 900) {
        if (inputType === 'bath') {
            // Toggle Bagno Pomeriggio
            if (currentRecord && currentRecord.status === 'bagno') {
                newStatus = 'presente';
                ledColor = 'verde';
                msg = 'Rientro Demo';
            } else {
                newStatus = 'bagno';
                ledColor = 'blu';
                msg = 'Uscita Bagno Demo';
            }
        } 
        else if (inputType === 'exit') {
             newStatus = 'uscita_anticipata';
             ledColor = 'uscita'; // Assicurati che l'ESP gestisca questo colore (es. rosso lampeggiante o arancione)
             msg = 'Uscita Demo';
        }
        else {
            // Tocco corto (Entrata/Presente)
            newStatus = 'presente';
            ledColor = 'verde';
            msg = 'Ingresso Demo';
        }
    }
    // B. SCUOLA CHIUSA (13:35 - 15:00) -> STATO CONGELATO
    else if (minutes >= 815 && minutes < 900) {
        updateDb = false; 
        ledColor = 'verde_f'; 
        msg = 'Scuola Chiusa - Stato Salvato';
        newStatus = currentRecord ? currentRecord.status : 'assente';
    }
    // C. MATTINA (Normale)
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
                 // Se fa un tocco corto ma è già a scuola, non facciamo nulla (evitiamo doppi ingressi)
                 updateDb = false;
                 ledColor = 'verde_f'; // Verde fisso o lampeggio veloce per dire "OK, lo so"
                 msg = 'Già Presente';
                 newStatus = currentRecord.status;
            } else {
                // Prima entrata della giornata
                if (minutes < 520) { 
                    newStatus = 'presente'; ledColor = 'verde'; msg = 'Entrata Regolare';
                } 
                else if (minutes >= 520 && minutes < 575) { 
                    newStatus = 'ritardo'; ledColor = 'giallo'; msg = 'Entrata in Ritardo';
                } 
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

    return res.status(200).json({ success: true, message: msg, status: newStatus, color: ledColor, debug_input: inputType });

  } catch (error) {
    return res.status(500).json({ error: error.message, color: 'rosso' });
  }
}
