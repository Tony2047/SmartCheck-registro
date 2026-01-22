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

  // Leggi tagID e TYPE (tipo di timbrata)
  const body = req.body || req.query;
  const tagID = body.tagID;
  let type = body.type || 'auto'; // 'bagno', 'ingresso', o 'auto'

  if (!tagID) return res.status(400).json({ error: 'Manca tagID' });

  try {
    // 1. Cerca studente
    const { data: user, error: userError } = await supabase
      .from('registry').select('*').eq('nfc_id', tagID).single();

    if (userError || !user) return res.status(404).json({ error: 'Badge sconosciuto' });

    // 2. Calcola Data e Ora Server
    const now = new Date();
    // Aggiusta orario Italia (UTC+1 o +2) approssimativo per il server
    const italyTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Rome"}));
    
    const dateStr = italyTime.toLocaleDateString('it-IT', {year: 'numeric', month: '2-digit', day: '2-digit'}).split('/').reverse().join('-'); 
    const timeStr = italyTime.toLocaleTimeString('it-IT', {hour: '2-digit', minute:'2-digit'});
    
    // Calcola minuti totali per logica ritardi lato server (backup)
    const minutes = italyTime.getHours() * 60 + italyTime.getMinutes(); // es. 8:30 = 510

    // 3. Determina lo status da salvare
    let statusToSave = 'presente'; // default

    if (type === 'bagno') {
        statusToSave = 'bagno';
    } else {
        // Logica oraria automatica se non specificata dall'ESP
        if (minutes >= 585) statusToSave = 'seconda_ora'; // Dopo 9:45
        else if (minutes >= 520) statusToSave = 'ritardo'; // Dopo 8:40
        else statusToSave = 'presente'; // Prima delle 8:40
    }

    // 4. Salva su Database
    const { error: attError } = await supabase
      .from('attendance')
      .upsert({
        student_name: user.full_name,
        date: dateStr,
        status: statusToSave,
        time: timeStr
      }, { onConflict: 'student_name, date' });

    if (attError) throw attError;

    return res.status(200).json({ success: true, message: `Status: ${statusToSave}`, status: statusToSave });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
