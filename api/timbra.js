mport { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://axlfuzksfpfwdvjawlmf.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4bGZ1emtzZnBmd2R2amF3bG1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5MzYyMzYsImV4cCI6MjA4NDUxMjIzNn0.Xga9UIWfS8rYxGYZs-Cz446GZkVhPCxeUvV8UUTlXEg'
)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = req.body;
  const tagID = body.tagID;
  const type = body.type; // Usiamo direttamente il type mandato dall'ESP
  const pressioneMS = body.pressioneMS || 0;

  if (!tagID) return res.status(400).json({ error: 'Manca tagID' });

  try {
    const { data: user } = await supabase.from('registry').select('*').eq('nfc_id', tagID).single();
    if (!user) return res.status(404).json({ error: 'Badge sconosciuto' });

    const italyTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Rome"}));
    const minutes = italyTime.getHours() * 60 + italyTime.getMinutes();
    const dateStr = italyTime.toISOString().split('T')[0];
    const timeStr = italyTime.toLocaleTimeString('it-IT', {hour: '2-digit', minute:'2-digit'});

    const { data: currentRecord } = await supabase.from('attendance')
      .select('status').eq('student_name', user.full_name).eq('date', dateStr).single();

    let newStatus = 'presente';
    let updateDb = true;

    // --- LOGICA CORRETTA ---
    // 1. Se il comando è BAGNO o USCITA, deve funzionare SEMPRE se lo studente non è assente
    if (currentRecord && currentRecord.status !== 'assente') {
        if (type === 'bath' || pressioneMS >= 2000 && pressioneMS < 5000) {
            newStatus = (currentRecord.status === 'bagno') ? 'presente' : 'bagno';
        } else if (type === 'exit' || pressioneMS >= 5000) {
            newStatus = 'uscita_anticipata';
        } else {
            // Tocco corto ma già presente: non fare nulla
            updateDb = false;
            newStatus = currentRecord.status;
        }
    }
    // 2. Se è assente, registra l'entrata (Ritardo, 2° ora o normale)
    else {
        if (minutes < 520) newStatus = 'presente';
        else if (minutes < 575) newStatus = 'ritardo';
        else newStatus = 'seconda_ora';
    }

    if (updateDb) {
      await supabase.from('attendance').upsert({
        student_name: user.full_name,
        date: dateStr,
        status: newStatus,
        time: timeStr
      });
    }

    return res.status(200).json({ success: true, status: newStatus });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
