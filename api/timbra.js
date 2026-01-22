import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://axlfuzksfpfwdvjawlmf.supabase.co', 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4bGZ1emtzZnBmd2R2amF3bG1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5MzYyMzYsImV4cCI6MjA4NDUxMjIzNn0.Xga9UIWfS8rYxGYZs-Cz446GZkVhPCxeUvV8UUTlXEg'
)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const body = req.body || req.query;
  const tagID = body.tagID;
  const inputType = body.type || 'short'; // 'short', 'bath', 'exit'

  if (!tagID) return res.status(400).json({ error: 'Manca tagID' });

  try {
    // 1. Identifica Studente
    const { data: user, error: userError } = await supabase
      .from('registry').select('*').eq('nfc_id', tagID).single();

    if (userError || !user) return res.status(404).json({ error: 'Badge sconosciuto', color: 'rosso' });

    // 2. Calcola Orario
    const now = new Date();
    const italyTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Rome"}));
    const minutes = italyTime.getHours() * 60 + italyTime.getMinutes(); 
    const dateStr = italyTime.toLocaleDateString('it-IT', {year: 'numeric', month: '2-digit', day: '2-digit'}).split('/').reverse().join('-'); 
    const timeStr = italyTime.toLocaleTimeString('it-IT', {hour: '2-digit', minute:'2-digit'});

    // 3. Controlla stato attuale
    const { data: currentRecord } = await supabase
      .from('attendance')
      .select('status')
      .eq('student_name', user.full_name)
      .eq('date', dateStr)
      .single();

    let newStatus = 'presente';
    let ledColor = 'verde';
    let msg = 'Operazione Completata';

    // --- LOGICA TEMPORALE PRECISA ---

    if (inputType === 'exit') {
        // --- USCITA ANTICIPATA (Hold > 3 sec) ---
        // Forza sempre l'uscita anticipata
        newStatus = 'uscita_anticipata';
        ledColor = 'uscita';
        msg = 'Uscita Anticipata';
    } 
    else if (inputType === 'bath') {
        // --- BAGNO (Hold 1.5 - 3 sec) ---
        if (currentRecord && currentRecord.status === 'bagno') {
            newStatus = 'presente'; // Rientro
            ledColor = 'verde';
            msg = 'Rientro dal Bagno';
        } else {
            newStatus = 'bagno'; // Vado
            ledColor = 'blu';
            msg = 'Uscita Bagno';
        }
    } 
    else {
        // --- ENTRATA (Short Tap < 1.5 sec) ---
        
        // SICUREZZA: Se è già presente/bagno/uscita, IGNORA il tocco corto.
        // Accetta il tocco corto SOLO se non c'è record o se è assente.
        if (currentRecord && currentRecord.status !== 'assente') {
            return res.status(200).json({ success: true, message: 'Già Presente (Nessuna modifica)', color: 'verde_f', status: currentRecord.status });
        }

        // Se siamo qui, è la PRIMA timbrata (o rientro da assente)
        if (minutes < 520) { 
            newStatus = 'presente'; ledColor = 'verde'; msg = 'Entrata Regolare';
        } 
        else if (minutes >= 520 && minutes < 525) { 
            newStatus = 'ritardo'; ledColor = 'giallo'; msg = 'Entrata in Ritardo';
        } 
        else { 
            newStatus = 'seconda_ora'; ledColor = 'viola'; msg = 'Entrata 2° Ora';
        }
    }

    // 4. Salva su Database
    await supabase.from('attendance').upsert({
        student_name: user.full_name,
        date: dateStr,
        status: newStatus,
        time: timeStr
    }, { onConflict: 'student_name, date' });

    return res.status(200).json({ success: true, message: msg, status: newStatus, color: ledColor });

  } catch (error) {
    return res.status(500).json({ error: error.message, color: 'rosso' });
  }
}
