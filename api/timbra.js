import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CONFIGURAZIONE
const supabase = createClient(
  'https://axlfuzksfpfwdvjawlmf.supabase.co', 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4bGZ1emtzZnBmd2R2amF3bG1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5MzYyMzYsImV4cCI6MjA4NDUxMjIzNn0.Xga9UIWfS8rYxGYZs-Cz446GZkVhPCxeUvV8UUTlXEg'
)

export default async function handler(req) {
  // 1. GESTIONE CORS (Permette all'ESP32 di comunicare)
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    })
  }

  try {
    // 2. LEGGI DATI DAL CODICE C++ DELL'ESP32
    const { tagID, pressioneMS } = await req.json();

    if (!tagID) {
      return new Response(JSON.stringify({ error: 'Manca tagID' }), { status: 400 });
    }

    // 3. IDENTIFICA L'INTENZIONE (Logica Pressione)
    let inputType = 'short'; // Default: Entrata/Presenza

    if (pressioneMS >= 5000) {
        inputType = 'exit'; // Più di 5 secondi -> Uscita
    } else if (pressioneMS >= 2000) {
        inputType = 'bath'; // Tra 2 e 5 secondi -> Bagno
    }
    // Sotto i 2 secondi -> 'short' (Entrata)

    // 4. CERCA LO STUDENTE NEL DATABASE
    const { data: user, error: userError } = await supabase
      .from('registry')
      .select('*')
      .eq('nfc_id', tagID)
      .single();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Badge non trovato', color: 'rosso' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // 5. CALCOLA ORA E DATA ITALIANA
    const now = new Date();
    const italyTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Rome"}));
    const minutes = italyTime.getHours() * 60 + italyTime.getMinutes(); 
    
    // Formato Data: YYYY-MM-DD
    const dateStr = italyTime.toLocaleDateString('it-IT', {year: 'numeric', month: '2-digit', day: '2-digit'}).split('/').reverse().join('-'); 
    // Formato Ora: HH:MM
    const timeStr = italyTime.toLocaleTimeString('it-IT', {hour: '2-digit', minute:'2-digit'});

    // 6. CONTROLLA STATO ATTUALE (Se lo studente è già a scuola oggi)
    const { data: currentRecord } = await supabase
      .from('attendance')
      .select('status')
      .eq('student_name', user.full_name)
      .eq('date', dateStr)
      .single();

    // Variabili di risposta
    let newStatus = 'presente';
    let ledColor = 'verde';
    let msg = 'Operazione OK';
    let updateDb = true; 

    // --- LOGICA DI BUSINESS ---

    // A. POMERIGGIO (> 15:00) -> OPEN DAY / DEMO MODE
    // Qui le regole sono più rilassate per far vedere come funziona
    if (minutes >= 900) {
        if (inputType === 'bath') {
            // Toggle Bagno
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
             ledColor = 'uscita'; // Arancione/Rosso
             msg = 'Uscita Demo';
        }
        else {
            // Tocco veloce -> Entrata
            newStatus = 'presente';
            ledColor = 'verde';
            msg = 'Ingresso Demo';
        }
    }
    // B. SCUOLA CHIUSA (13:35 - 15:00) -> INTERVALLO PRANZO/USCITA
    else if (minutes >= 815 && minutes < 900) {
        updateDb = false; 
        ledColor = 'verde_f'; // Lampeggio veloce (Ignorato)
        msg = 'Scuola Chiusa';
        newStatus = currentRecord ? currentRecord.status : 'assente';
    }
    // C. MATTINA (Orario Scolastico 8:00 - 13:35)
    else {
        if (inputType === 'exit') {
            newStatus = 'uscita_anticipata';
            ledColor = 'uscita';
            msg = 'Uscita Anticipata';
        } 
        else if (inputType === 'bath') {
            // Logica Bagno "Toggle" (Dentro/Fuori)
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
            // ENTRATA (Short Press)
            if (currentRecord && currentRecord.status !== 'assente') {
                 // Se è già presente, non riscriviamo il DB per evitare conflitti
                 updateDb = false;
                 ledColor = 'verde_f'; // Verde Fisso (Già fatto)
                 msg = 'Già Presente';
                 newStatus = currentRecord.status;
            } else {
                // Calcolo Ritardi
                if (minutes < 520) { // < 8:40
                    newStatus = 'presente'; ledColor = 'verde'; msg = 'Entrata Regolare';
                } 
                else if (minutes >= 520 && minutes < 575) { // 8:40 - 9:35
                    newStatus = 'ritardo'; ledColor = 'giallo'; msg = 'Entrata in Ritardo';
                } 
                else { // > 9:35
                    newStatus = 'seconda_ora'; ledColor = 'viola'; msg = 'Entrata 2° Ora';
                }
            }
        }
    }

    // 7. SCRITTURA NEL DATABASE
    if (updateDb) {
        const { error: upsertError } = await supabase
            .from('attendance')
            .upsert({
                student_name: user.full_name,
                date: dateStr,
                status: newStatus,
                time: timeStr
            }, { onConflict: 'student_name, date' });
            
        if (upsertError) throw upsertError;
    }

    // 8. RISPOSTA JSON ALL'ESP32
    return new Response(JSON.stringify({ 
        success: true, 
        message: msg, 
        status: newStatus, 
        color: ledColor 
    }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message, color: 'rosso' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
