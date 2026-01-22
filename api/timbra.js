import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://axlfuzksfpfwdvjawlmf.supabase.co', 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4bGZ1emtzZnBmd2R2amF3bG1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5MzYyMzYsImV4cCI6MjA4NDUxMjIzNn0.Xga9UIWfS8rYxGYZs-Cz446GZkVhPCxeUvV8UUTlXEg'
)

export default async function handler(req, res) {
  // CORS Setup
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const body = req.body || req.query;
  const tagID = body.tagID;
  const inputType = body.type || 'short'; // 'short' (normale) o 'long' (bagno)

  if (!tagID) return res.status(400).json({ error: 'Manca tagID' });

  try {
    // 1. Identifica Studente
    const { data: user, error: userError } = await supabase
      .from('registry').select('*').eq('nfc_id', tagID).single();

    if (userError || !user) return res.status(404).json({ error: 'Badge sconosciuto', color: 'rosso' });

    // 2. Calcola Orario Italiano Corrente
    const now = new Date();
    const italyTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Rome"}));
    const minutes = italyTime.getHours() * 60 + italyTime.getMinutes(); // Minuti totali da mezzanotte
    const dateStr = italyTime.toLocaleDateString('it-IT', {year: 'numeric', month: '2-digit', day: '2-digit'}).split('/').reverse().join('-'); 
    const timeStr = italyTime.toLocaleTimeString('it-IT', {hour: '2-digit', minute:'2-digit'});

    // 3. Controlla lo stato attuale nel Database per oggi
    const { data: currentRecord } = await supabase
      .from('attendance')
      .select('status')
      .eq('student_name', user.full_name)
      .eq('date', dateStr)
      .single();

    let newStatus = 'presente';
    let ledColor = 'verde';
    let msg = 'Benvenuto';

    // --- LOGICA INTELLIGENTE ---

    if (inputType === 'long') {
        // --- LOGICA BAGNO (Pressione Lunga) ---
        // Se era in bagno, torna presente. Se era presente, va in bagno.
        if (currentRecord && currentRecord.status === 'bagno') {
            newStatus = 'presente'; // Rientro dal bagno
            ledColor = 'verde';
            msg = 'Rientrato dal Bagno';
        } else {
            newStatus = 'bagno'; // Vado al bagno
            ledColor = 'blu';
            msg = 'Uscita Bagno';
        }
    } else {
        // --- LOGICA ENTRATA / USCITA (Pressione Corta) ---
        
        if (!currentRecord) {
            // PRIMA TIMBRATA DEL GIORNO (ENTRATA)
            if (minutes < 520) { // Prima delle 8:40
                newStatus = 'presente';
                ledColor = 'verde';
                msg = 'Entrata Regolare';
            } else if (minutes >= 520 && minutes < 585) { // 8:40 - 9:45
                newStatus = 'ritardo';
                ledColor = 'giallo';
                msg = 'Entrata in Ritardo';
            } else { // Dopo le 9:45
                newStatus = 'seconda_ora';
                ledColor = 'viola';
                msg = 'Entrata 2° Ora';
            }
        } else {
            // UTENTE GIÀ DENTRO -> STA USCENTDO PRIMA?
            // Blocchiamo doppi passaggi accidentali (es. ripasso dopo 1 minuto)
            // L'uscita anticipata è valida solo se, per esempio, sono passate le 10:00 (600 min)
            if (minutes > 600 && currentRecord.status !== 'uscita_anticipata') {
                newStatus = 'uscita_anticipata';
                ledColor = 'uscita'; // Giallo/Arancio
                msg = 'Uscita Anticipata';
            } else if (currentRecord.status === 'bagno') {
                newStatus = 'presente'; // Se timbra corto mentre è in bagno, lo facciamo rientrare
                ledColor = 'verde';
                msg = 'Rientro (da Bagno)';
            } else {
                return res.status(200).json({ success: true, message: 'Già presente', color: 'verde_f', status: currentRecord.status });
            }
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
