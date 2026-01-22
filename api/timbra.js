import { createClient } from '@supabase/supabase-js'

// I TUOI DATI SUPABASE
const supabase = createClient(
  'https://axlfuzksfpfwdvjawlmf.supabase.co', 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4bGZ1emtzZnBmd2R2amF3bG1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5MzYyMzYsImV4cCI6MjA4NDUxMjIzNn0.Xga9UIWfS8rYxGYZs-Cz446GZkVhPCxeUvV8UUTlXEg'
)

export default async function handler(req, res) {
  // ABILITA CORS (Fondamentale per ESP32 e test)
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  // Leggi il tagID (supporta sia POST JSON che GET url per test rapidi)
  let tagID = null;
  if (req.body && req.body.tagID) tagID = req.body.tagID;
  else if (req.query && req.query.tagID) tagID = req.query.tagID;

  if (!tagID) return res.status(400).json({ error: 'Manca il parametro tagID' });

  try {
    // 1. Cerca lo studente con questo NFC
    const { data: user, error: userError } = await supabase
      .from('registry')
      .select('*')
      .eq('nfc_id', tagID)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'Badge non riconosciuto' });
    }

    // 2. Prepara Data e Ora
    const now = new Date();
    // Formato Data YYYY-MM-DD
    const dateStr = now.toLocaleDateString('it-IT', {year: 'numeric', month: '2-digit', day: '2-digit'}).split('/').reverse().join('-'); 
    // Formato Ora HH:MM
    const timeStr = now.toLocaleTimeString('it-IT', {hour: '2-digit', minute:'2-digit'});

    // 3. Scrivi la presenza
    const { error: attError } = await supabase
      .from('attendance')
      .upsert({
        student_name: user.full_name,
        date: dateStr,
        status: 'presente',
        time: timeStr
      }, { onConflict: 'student_name, date' });

    if (attError) throw attError;

    return res.status(200).json({ 
      success: true, 
      message: `Benvenuto ${user.full_name}`, 
      time: timeStr 
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
