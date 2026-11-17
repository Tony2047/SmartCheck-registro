const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(cookieParser());

// Connessione a Turso tramite Variabili d'Ambiente protette su Vercel
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

const SECRET = process.env.SESSION_SECRET || process.env.TURSO_AUTH_TOKEN || 'smartcheck-secret-key-2026';

// Funzioni crittografiche per password e cookie firmati (zero dipendenze esterne)
function hashPassword(pwd) {
    return crypto.createHmac('sha256', SECRET).update(String(pwd)).digest('hex');
}

function signToken(userId) {
    const sig = crypto.createHmac('sha256', SECRET).update(String(userId)).digest('hex');
    return `${userId}.${sig}`;
}

function verifyToken(token) {
    if (!token || !token.includes('.')) return null;
    const [id, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SECRET).update(String(id)).digest('hex');
    return sig === expected ? Number(id) : null;
}

// ================= INIZIALIZZAZIONE AUTOMATICA DB TURSO =================
let dbReady = false;

async function ensureDb() {
    if (dbReady) return;

    await db.batch([
        `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            full_name TEXT NOT NULL,
            role TEXT NOT NULL,
            class_name TEXT DEFAULT '5AEE',
            desk_id TEXT,
            workbench_id TEXT DEFAULT 'lab_banco_01'
        )`,
        `CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_name TEXT NOT NULL,
            date TEXT NOT NULL,
            status TEXT NOT NULL,
            time TEXT NOT NULL,
            UNIQUE(student_id, date)
        )`,
        `CREATE TABLE IF NOT EXISTS bathroom_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_name TEXT NOT NULL,
            date TEXT NOT NULL,
            out_time TEXT NOT NULL,
            in_time TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS bathroom_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            student_name TEXT NOT NULL,
            desk_id TEXT,
            class_name TEXT NOT NULL,
            booked_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS signatures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_name TEXT NOT NULL,
            date TEXT NOT NULL,
            hour INTEGER NOT NULL,
            subject TEXT NOT NULL,
            topic TEXT NOT NULL,
            teacher TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS agenda (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_name TEXT NOT NULL,
            date TEXT NOT NULL,
            subject TEXT NOT NULL,
            type TEXT NOT NULL,
            description TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS grades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_name TEXT NOT NULL,
            subject TEXT NOT NULL,
            value TEXT NOT NULL,
            type TEXT NOT NULL,
            date TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_name TEXT NOT NULL,
            text TEXT NOT NULL,
            type TEXT NOT NULL,
            date TEXT NOT NULL,
            teacher TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS lab_workbenches (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            lab_location TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS lab_inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            shelf_position TEXT NOT NULL,
            total_qty INTEGER NOT NULL,
            available_qty INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS lab_loans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL,
            unit_label TEXT NOT NULL,
            workbench_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            class_name TEXT NOT NULL,
            taken_at TEXT NOT NULL,
            returned_at TEXT,
            status TEXT DEFAULT 'out'
        )`,
        `CREATE TABLE IF NOT EXISTS esp_devices (
            device_code TEXT PRIMARY KEY,
            device_name TEXT NOT NULL,
            location TEXT NOT NULL,
            status TEXT DEFAULT 'online',
            battery_level INTEGER DEFAULT 95,
            battery_voltage REAL DEFAULT 4.12,
            rssi INTEGER DEFAULT -58,
            is_tampered INTEGER DEFAULT 0
        )`
    ], 'write');

    const check = await db.execute('SELECT COUNT(*) as c FROM users');
    if (Number(check.rows[0].c) === 0) {
        const defaultPass = hashPassword('1234');
        const adminPass = hashPassword('admin');

        const students5AEE = [
            ['agnitti.filippo', 'Agnitti Filippo'],
            ['calo.emiliano', 'Calò Emiliano'],
            ['camassa.stefano', 'Camassa Stefano'],
            ['carosa.pierpaolo', 'Carosa Pierpaolo'],
            ['chackari.abdula', 'Chackari Abdula'],
            ['cupi.ernest', 'Cupi Ernest'],
            ['dimichele.matteo', 'Di Michele Matteo'],
            ['esposito.lorenzo', 'Esposito Lorenzo'],
            ['galli.mattia', 'Galli Mattia'],
            ['garofalo.ivan', 'Garofalo Ivan'],
            ['iarossi.luca', 'Iarossi Luca'],
            ['methasa.kristian', 'Methasa Kristian'],
            ['mirandola.luigi', 'Mirandola Luigi'],
            ['navarroli.antonio', 'Navarroli Antonio'],
            ['pacchione.leonardo', 'Pacchione Leonardo'],
            ['palombizio.giuseppe', 'Palombizio Giuseppe'],
            ['pasqualone.federico', 'Pasqualone Federico'],
            ['pisone.lorenzo', 'Pisone Lorenzo'],
            ['raulli.mattia', 'Raulli Mattia'],
            ['recchione.biagio', 'Recchione Biagio'],
            ['spaczil.stefano', 'Spaczil Stefano'],
            ['tofano.alessio', 'Tofano Alessio'],
            ['tsikhanskyi.oleksandr', 'Tsikhanskyi Oleksandr']
        ];

        const seedQueries = [
            {
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: ['admin', adminPass, 'Amministratore Sistema', 'admin', '5AEE', null, null]
            },
            {
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: ['petrilli.antonio', defaultPass, 'Prof. Antonio Petrilli', 'docente', '5AEE', null, null]
            },
            {
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: ['mascio.fabio', defaultPass, 'Prof. Fabio Mascio', 'docente', '5AEE', null, null]
            },
            {
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: ['roselli.michele', defaultPass, 'Prof. Michele Roselli', 'docente', '5AEE', null, null]
            }
        ];

        students5AEE.forEach(([uname, fname], idx) => {
            const deskId = `banco_${String(idx + 1).padStart(2, '0')}`;
            const benchId = `lab_banco_${String((idx % 8) + 1).padStart(2, '0')}`;
            seedQueries.push({
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: [uname, defaultPass, fname, 'studente', '5AEE', deskId, benchId]
            });
        });

        for (let i = 1; i <= 8; i++) {
            const num = String(i).padStart(2, '0');
            seedQueries.push({
                sql: 'INSERT INTO lab_workbenches (id, name, lab_location) VALUES (?, ?, ?)',
                args: [`lab_banco_${num}`, `Banco Lab #${num}`, 'Lab. Elettronica e Sistemi']
            });
        }

        const invItems = [
            ['DMM-01', 'Multimetro Digitale', 'Ripiano A1', 8, 8],
            ['OSC-PROBE', 'Sonda Oscilloscopio 100MHz', 'Ripiano A2', 12, 12],
            ['ESP32-KIT', 'Kit Sviluppo ESP32-WROOM', 'Cassetto B1', 10, 10],
            ['BREAD-830', 'Breadboard 830 Punti', 'Cassetto B2', 15, 15],
            ['PSU-CAV', 'Coppia Cavi Alimentatore DC', 'Ripiano C1', 16, 16]
        ];
        invItems.forEach(item => {
            seedQueries.push({
                sql: 'INSERT INTO lab_inventory (item_code, name, shelf_position, total_qty, available_qty) VALUES (?, ?, ?, ?, ?)',
                args: item
            });
        });

        const devices = [
            ['ESP32-5AEE-DOOR', 'Terminale NFC Aula 5AEE', 'Ingresso 5AEE', 'online', 96, 4.14, -52, 0],
            ['ESP32-LAB-CAB', 'Gateway Armadio Componenti', 'Lab. Elettronica', 'online', 100, 4.20, -47, 0],
            ['ESP32-WC-P1', 'Sensore Presenza Bagno', 'Corridoio Piano 1', 'online', 84, 3.99, -65, 0]
        ];
        devices.forEach(d => {
            seedQueries.push({
                sql: 'INSERT INTO esp_devices (device_code, device_name, location, status, battery_level, battery_voltage, rssi, is_tampered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                args: d
            });
        });

        await db.batch(seedQueries, 'write');
    }

    dbReady = true;
}

app.use(async (req, res, next) => {
    try {
        await ensureDb();
        next();
    } catch (err) {
        console.error('Errore DB Turso:', err);
        res.status(500).json({ error: 'Errore di connessione al database' });
    }
});

async function getSessionUser(req) {
    const uid = verifyToken(req.cookies?.sc_session);
    if (!uid) return null;
    const r = await db.execute({
        sql: 'SELECT id, username, full_name as name, role, class_name, desk_id, workbench_id FROM users WHERE id = ?',
        args: [uid]
    });
    return r.rows[0] || null;
}

// ================= ROTTE AUTENTICAZIONE =================
app.post('/api/auth/verify', async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const r = await db.execute({
        sql: 'SELECT username, full_name FROM users WHERE username = ?',
        args: [username]
    });
    if (r.rows.length === 0) return res.status(404).json({ error: 'Utente non trovato' });
    res.json(r.rows[0]);
});

app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const passHash = hashPassword(req.body.password || '');
    const r = await db.execute({
        sql: 'SELECT id, username, full_name as name, role, class_name, desk_id, workbench_id FROM users WHERE username = ? AND password_hash = ?',
        args: [username, passHash]
    });
    if (r.rows.length === 0) return res.status(401).json({ error: 'Password non corretta' });

    const user = r.rows[0];
    res.cookie('sc_session', signToken(user.id), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 3600 * 1000
    });
    res.json({ user });
});

app.get('/api/auth/me', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sessione non attiva' });
    res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('sc_session');
    res.json({ ok: true });
});

// ================= ROTTE AULA E PRESENZE =================
app.get('/api/class-bundle/:cls', async (req, res) => {
    const cls = req.params.cls;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const [students, allUsers, attendance, bathroomHistory, bathroomQueue, signatures, agenda, grades, notes] = await Promise.all([
        db.execute({ sql: "SELECT id, full_name, desk_id FROM users WHERE role = 'studente' AND class_name = ?", args: [cls] }),
        db.execute("SELECT id, full_name FROM users"),
        db.execute({ sql: "SELECT student_id, status, time FROM attendance WHERE class_name = ? AND date = ?", args: [cls, date] }),
        db.execute({ sql: "SELECT student_id, out_time, in_time FROM bathroom_history WHERE class_name = ? AND date = ?", args: [cls, date] }),
        db.execute({ sql: "SELECT * FROM bathroom_queue WHERE class_name = ? ORDER BY id ASC", args: [cls] }),
        db.execute({ sql: "SELECT * FROM signatures WHERE class_name = ? AND date = ? ORDER BY hour ASC", args: [cls, date] }),
        db.execute({ sql: "SELECT * FROM agenda WHERE class_name = ? ORDER BY id DESC", args: [cls] }),
        db.execute({ sql: "SELECT * FROM grades WHERE class_name = ?", args: [cls] }),
        db.execute({ sql: "SELECT * FROM notes WHERE class_name = ?", args: [cls] })
    ]);

    res.json({
        classId: cls,
        students: students.rows,
        allUsers: allUsers.rows,
        attendance: attendance.rows,
        bathroomHistory: bathroomHistory.rows,
        bathroomQueue: bathroomQueue.rows,
        signatures: signatures.rows,
        agenda: agenda.rows,
        grades: grades.rows,
        notes: notes.rows
    });
});

app.post('/api/attendance', async (req, res) => {
    const { student_id, class_id, date, status, time } = req.body;
    const prev = await db.execute({
        sql: "SELECT status FROM attendance WHERE student_id = ? AND date = ?",
        args: [student_id, date]
    });
    const prevStatus = prev.rows[0]?.status;

    await db.execute({
        sql: `INSERT INTO attendance (student_id, class_name, date, status, time)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, time = excluded.time`,
        args: [student_id, class_id, date, status, time]
    });

    if (status === 'bagno' && prevStatus !== 'bagno') {
        await db.execute({
            sql: "INSERT INTO bathroom_history (student_id, class_name, date, out_time, in_time) VALUES (?, ?, ?, ?, NULL)",
            args: [student_id, class_id, date, time]
        });
        await db.execute({
            sql: "DELETE FROM bathroom_queue WHERE student_id = ? AND class_name = ?",
            args: [student_id, class_id]
        });
    } else if (prevStatus === 'bagno' && status !== 'bagno') {
        const openTrip = await db.execute({
            sql: "SELECT id FROM bathroom_history WHERE student_id = ? AND date = ? AND in_time IS NULL ORDER BY id DESC LIMIT 1",
            args: [student_id, date]
        });
        if (openTrip.rows[0]) {
            await db.execute({
                sql: "UPDATE bathroom_history SET in_time = ? WHERE id = ?",
                args: [time, openTrip.rows[0].id]
            });
        }
    }

    res.json({ ok: true });
});

// ================= ROTTE CODA BAGNO =================
app.post('/api/bathroom-queue/join', async (req, res) => {
    const { student_id, student_name, desk_id, class_name, booked_at } = req.body;
    const exists = await db.execute({
        sql: "SELECT id FROM bathroom_queue WHERE student_id = ? AND class_name = ?",
        args: [student_id, class_name]
    });
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Sei già in coda' });

    await db.execute({
        sql: "INSERT INTO bathroom_queue (student_id, student_name, desk_id, class_name, booked_at) VALUES (?, ?, ?, ?, ?)",
        args: [student_id, student_name, desk_id, class_name, booked_at]
    });
    res.json({ ok: true });
});

app.post('/api/bathroom-queue/remove', async (req, res) => {
    const { identifier, class_name } = req.body;
    await db.execute({
        sql: "DELETE FROM bathroom_queue WHERE (id = ? OR student_id = ?) AND class_name = ?",
        args: [identifier, identifier, class_name]
    });
    res.json({ ok: true });
});

app.post('/api/bathroom-queue/clear', async (req, res) => {
    await db.execute({
        sql: "DELETE FROM bathroom_queue WHERE class_name = ?",
        args: [req.body.class_name]
    });
    res.json({ ok: true });
});

// ================= ROTTE LABORATORIO & ARMADIO =================
app.get('/api/lab/state/:cls', async (req, res) => {
    const cls = req.params.cls;
    const [workbenches, students, inventory, activeLoans, historyLoans] = await Promise.all([
        db.execute("SELECT * FROM lab_workbenches ORDER BY id ASC"),
        db.execute({ sql: "SELECT id, full_name, workbench_id FROM users WHERE role = 'studente' AND class_name = ?", args: [cls] }),
        db.execute("SELECT * FROM lab_inventory ORDER BY id ASC"),
        db.execute({
            sql: `SELECT l.*, i.name as item_name 
                  FROM lab_loans l JOIN lab_inventory i ON l.item_id = i.id 
                  WHERE l.status = 'out' AND l.class_name = ? ORDER BY l.id DESC`,
            args: [cls]
        }),
        db.execute({ sql: "SELECT * FROM lab_loans WHERE class_name = ? ORDER BY id DESC LIMIT 30", args: [cls] })
    ]);

    res.json({
        workbenches: workbenches.rows,
        students: students.rows,
        inventory: inventory.rows,
        activeLoans: activeLoans.rows,
        historyLoans: historyLoans.rows
    });
});

app.post('/api/lab/assign-bench', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Non autenticato' });
    await db.execute({
        sql: "UPDATE users SET workbench_id = ? WHERE id = ?",
        args: [req.body.workbench_id, user.id]
    });
    res.json({ ok: true });
});

app.post('/api/lab/checkout', async (req, res) => {
    const user = await getSessionUser(req);
    const { item_id, workbench_id, class_name } = req.body;
    const r = await db.execute({ sql: "SELECT * FROM lab_inventory WHERE id = ?", args: [item_id] });
    const item = r.rows[0];
    if (!item || Number(item.available_qty) <= 0) {
        return res.status(400).json({ error: 'Componente esaurito nell\'armadio' });
    }

    const unitNum = Number(item.total_qty) - Number(item.available_qty) + 1;
    const unitLabel = `${item.name} (#${unitNum})`;
    const nowTime = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const studentName = user ? user.name : 'Operatore';

    await db.batch([
        { sql: "UPDATE lab_inventory SET available_qty = available_qty - 1 WHERE id = ?", args: [item_id] },
        {
            sql: "INSERT INTO lab_loans (item_id, unit_label, workbench_id, student_name, class_name, taken_at, status) VALUES (?, ?, ?, ?, ?, ?, 'out')",
            args: [item_id, unitLabel, workbench_id, studentName, class_name || '5AEE', nowTime]
        }
    ], 'write');

    res.json({ ok: true, unitLabel, benchId: workbench_id });
});

app.post('/api/lab/checkin', async (req, res) => {
    const { loan_id } = req.body;
    const r = await db.execute({ sql: "SELECT * FROM lab_loans WHERE id = ? AND status = 'out'", args: [loan_id] });
    const loan = r.rows[0];
    if (!loan) return res.status(404).json({ error: 'Prestito già rientrato' });

    const nowTime = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    await db.batch([
        { sql: "UPDATE lab_loans SET status = 'returned', returned_at = ? WHERE id = ?", args: [nowTime, loan_id] },
        { sql: "UPDATE lab_inventory SET available_qty = MIN(total_qty, available_qty + 1) WHERE id = ?", args: [loan.item_id] }
    ], 'write');

    res.json({ ok: true, unitLabel: loan.unit_label });
});

// ================= ROTTE FIRME, AGENDA, VOTI, NOTE & ESP32 =================
app.post('/api/signatures', async (req, res) => {
    const user = await getSessionUser(req);
    const { date, hour, subject, topic, class_name } = req.body;
    await db.execute({
        sql: "INSERT INTO signatures (class_name, date, hour, subject, topic, teacher) VALUES (?, ?, ?, ?, ?, ?)",
        args: [class_name, date, hour, subject, topic, user ? user.name : 'Docente']
    });
    res.json({ ok: true });
});

app.delete('/api/signatures/:id', async (req, res) => {
    await db.execute({ sql: "DELETE FROM signatures WHERE id = ?", args: [req.params.id] });
    res.json({ ok: true });
});

app.post('/api/agenda', async (req, res) => {
    const { date, subject, type, description, class_name } = req.body;
    await db.execute({
        sql: "INSERT INTO agenda (class_name, date, subject, type, description) VALUES (?, ?, ?, ?, ?)",
        args: [class_name, date, subject, type, description]
    });
    res.json({ ok: true });
});

app.delete('/api/agenda/:id', async (req, res) => {
    await db.execute({ sql: "DELETE FROM agenda WHERE id = ?", args: [req.params.id] });
    res.json({ ok: true });
});

app.post('/api/grades', async (req, res) => {
    const { student_id, subject, value, type, date, class_id } = req.body;
    await db.execute({
        sql: "INSERT INTO grades (student_id, class_name, subject, value, type, date) VALUES (?, ?, ?, ?, ?, ?)",
        args: [student_id, class_id, subject, value, type, date]
    });
    res.json({ ok: true });
});

app.delete('/api/grades/:id', async (req, res) => {
    await db.execute({ sql: "DELETE FROM grades WHERE id = ?", args: [req.params.id] });
    res.json({ ok: true });
});

app.post('/api/notes', async (req, res) => {
    const user = await getSessionUser(req);
    const { student_id, text, type, date, class_id } = req.body;
    await db.execute({
        sql: "INSERT INTO notes (student_id, class_name, text, type, date, teacher) VALUES (?, ?, ?, ?, ?, ?)",
        args: [student_id, class_id, text, type, date, user ? user.name : 'Docente']
    });
    res.json({ ok: true });
});

app.delete('/api/notes/:id', async (req, res) => {
    await db.execute({ sql: "DELETE FROM notes WHERE id = ?", args: [req.params.id] });
    res.json({ ok: true });
});

app.get('/api/devices', async (req, res) => {
    const r = await db.execute("SELECT * FROM esp_devices");
    res.json({ devices: r.rows });
});

app.post('/api/devices/tamper', async (req, res) => {
    const r = await db.execute({ sql: "SELECT is_tampered FROM esp_devices WHERE device_code = ?", args: [req.body.device_code] });
    if (r.rows[0]) {
        const next = Number(r.rows[0].is_tampered) ? 0 : 1;
        await db.execute({
            sql: "UPDATE esp_devices SET is_tampered = ?, status = ? WHERE device_code = ?",
            args: [next, next ? 'tamper' : 'online', req.body.device_code]
        });
    }
    res.json({ ok: true });
});

module.exports = app;
