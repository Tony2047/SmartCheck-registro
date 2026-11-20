const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(cookieParser());

// Dati iniziali della configurazione (classi, materie, disposizione banchi): vengono copiati nel database
// al primo avvio e da quel momento si leggono/modificano solo da Turso (tabella app_config), mai dall'HTML.
const SEED_CONFIG = {
    'classes': [{"dept": "ELETTRONICA", "icon": "fa-microchip", "badge": "Tecnologico", "accent": "blue", "classes": ["1AEE", "2AEE", "3AEE", "4AEE", "5AEE"]}, {"dept": "MECCANICA", "icon": "fa-gears", "badge": "Meccatronica", "accent": "amber", "classes": ["1AMM", "2AMM", "3AMM", "4AMM", "5AMM", "4 MAUT", "4 MROB", "5 MA/R", "1 MA/R", "2 MA/R", "3 MA/R"]}, {"dept": "CHIMICA", "icon": "fa-flask-vial", "badge": "Biotecnologie", "accent": "emerald", "classes": ["1ACM", "2ACM", "3ACM", "4ACM", "5ACM"]}],
    'subjects': ["Chimica analitica","Chimica organica","Complementi di matematica","Diritto","DPOI","Elettrotecnica","Fisica","Geografia","Inglese","Italiano","Matematica","Religione","Scienze","Scienze motorie","Sistemi Automatici","Sistemi e automazione","STA","Storia","Supplenza","Tecnologie chimiche","Tecnologie informatiche","Tecnologie meccaniche","TPSEE","TTRG"],
    'layout:5AEE': {"wings": [{"name": "ALA SINISTRA", "rows": [[7], [15, 23], [10, 1], [12, 21]]}, {"name": "FILA CENTRALE", "rows": [[9, 8], [2, 14], [22, 4], [3, 18]]}, {"name": "ALA DESTRA", "rows": [[5, 6], [20, 11], [17, 13], [19, 16]]}]}
};

// Chiave condivisa con gli ESP32 (header x-device-key). Impostala nelle variabili d'ambiente di Vercel.
const DEVICE_KEY = process.env.DEVICE_KEY || '';
// Vercel gira in UTC: data e ora vanno sempre calcolate sul fuso di Roma
const romeDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const romeTime = () => new Date().toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
const romeDateTime = () => `${romeDate()} ${romeTime()}`;
const isDevice = req => Boolean(DEVICE_KEY) && req.get('x-device-key') === DEVICE_KEY;

// Connessione a Turso tramite Variabili d'Ambiente protette su Vercel
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

// Chiave per firma cookie di sessione (e retrocompatibilità hash legacy)
const SECRET = process.env.SESSION_SECRET || process.env.TURSO_AUTH_TOKEN || 'smartcheck-secret-key-2026';

// ================= CRITTOGRAFIA PASSWORD (SCRYPT + SALT UNIVOCO) & SESSIONI =================
function legacyHashPassword(pwd) {
    return crypto.createHmac('sha256', SECRET).update(String(pwd)).digest('hex');
}

function hashPassword(pwd) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(String(pwd), salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
}

function verifyPassword(pwd, storedHash) {
    if (!storedHash || typeof storedHash !== 'string') return false;
    try {
        if (storedHash.startsWith('scrypt$')) {
            const parts = storedHash.split('$');
            if (parts.length !== 3) return false;
            const [, salt, keyHex] = parts;
            const derived = crypto.scryptSync(String(pwd), salt, 64);
            const keyBuf = Buffer.from(keyHex, 'hex');
            if (derived.length !== keyBuf.length) return false;
            return crypto.timingSafeEqual(derived, keyBuf);
        }
        // Retrocompatibilità con hash HMAC-SHA256 esistenti prima del cambio password obbligatorio
        const legacyBuf = Buffer.from(legacyHashPassword(pwd), 'hex');
        const storedBuf = Buffer.from(storedHash, 'hex');
        if (legacyBuf.length !== storedBuf.length) return false;
        return crypto.timingSafeEqual(legacyBuf, storedBuf);
    } catch (e) {
        return false;
    }
}

function validateNewPassword(pwd, username = '') {
    const p = String(pwd || '');
    if (p.length < 8) return 'La password deve contenere almeno 8 caratteri';
    if (p.length > 72) return 'La password è troppo lunga (massimo 72 caratteri)';
    if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'La password deve includere almeno una lettera e un numero';
    const low = p.toLowerCase();
    const blocked = ['1234', '12345678', '123456789', 'password', 'password1', 'password123', 'admin', 'admin123', 'admin1234', 'smartcheck', 'qwerty12', 'scuola123'];
    if (blocked.includes(low)) return 'Scegli una password personale meno prevedibile';
    if (username && low === String(username).toLowerCase()) return 'La password non può coincidere con il nome utente';
    return null;
}

function generateTempPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += alphabet[bytes[i] % alphabet.length];
    }
    return `SC-${code}`;
}

function signToken(userId) {
    const sig = crypto.createHmac('sha256', SECRET).update(String(userId)).digest('hex');
    return `${userId}.${sig}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [id, sig] = token.split('.');
    if (!id || !sig || !/^\d+$/.test(id)) return null;
    try {
        const expectedHex = crypto.createHmac('sha256', SECRET).update(String(id)).digest('hex');
        const sigBuf = Buffer.from(sig, 'hex');
        const expBuf = Buffer.from(expectedHex, 'hex');
        if (sigBuf.length !== expBuf.length) return null;
        return crypto.timingSafeEqual(sigBuf, expBuf) ? Number(id) : null;
    } catch (e) {
        return null;
    }
}

function setSessionCookie(res, userId) {
    res.cookie('sc_session', signToken(userId), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 3600 * 1000
    });
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
            workbench_id TEXT DEFAULT 'lab_banco_01',
            must_change_password INTEGER NOT NULL DEFAULT 1,
            email TEXT,
            password_updated_at TEXT
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

    await db.batch([
        `CREATE TABLE IF NOT EXISTS phone_slots (
            class_name TEXT NOT NULL, date TEXT NOT NULL, slot INTEGER NOT NULL,
            present INTEGER NOT NULL DEFAULT 0, time TEXT,
            PRIMARY KEY (class_name, date, slot)
        )`,
        `CREATE TABLE IF NOT EXISTS scan_log (student_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL)`
    ], 'write');

    // Migrazioni incrementali sicure su tabelle già esistenti
    try {
        await db.execute("ALTER TABLE attendance ADD COLUMN first_in TEXT");
        await db.execute("UPDATE attendance SET first_in = time WHERE first_in IS NULL AND status IN ('presente', 'ritardo', 'seconda_ora')");
    } catch (e) { /* colonna gia' presente */ }

    try { await db.execute("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1"); } catch (e) {}
    try { await db.execute("ALTER TABLE users ADD COLUMN email TEXT"); } catch (e) {}
    try { await db.execute("ALTER TABLE users ADD COLUMN password_updated_at TEXT"); } catch (e) {}

    await db.execute("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const [k, v] of Object.entries(SEED_CONFIG)) {
        await db.execute({ sql: "INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)", args: [k, JSON.stringify(v)] });
    }

    const check = await db.execute('SELECT COUNT(*) as c FROM users');
    if (Number(check.rows[0].c) === 0) {
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
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
                args: ['admin', hashPassword('admin'), 'Amministratore Sistema', 'admin', '5AEE', null, null]
            },
            {
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
                args: ['petrilli.antonio', hashPassword('1234'), 'Prof. Antonio Petrilli', 'docente', '5AEE', null, null]
            },
            {
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
                args: ['mascio.fabio', hashPassword('1234'), 'Prof. Fabio Mascio', 'docente', '5AEE', null, null]
            },
            {
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
                args: ['roselli.michele', hashPassword('1234'), 'Prof. Michele Roselli', 'docente', '5AEE', null, null]
            }
        ];

        students5AEE.forEach(([uname, fname], idx) => {
            const deskId = `banco_${String(idx + 1).padStart(2, '0')}`;
            const benchId = `lab_banco_${String((idx % 8) + 1).padStart(2, '0')}`;
            seedQueries.push({
                sql: 'INSERT INTO users (username, password_hash, full_name, role, class_name, desk_id, workbench_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
                args: [uname, hashPassword('1234'), fname, 'studente', '5AEE', deskId, benchId]
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

// 1) Inizializzazione DB sempre per prima (prima di qualsiasi controllo sessione)
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
        sql: 'SELECT id, username, full_name as name, role, class_name, desk_id, workbench_id, must_change_password, email FROM users WHERE id = ?',
        args: [uid]
    });
    const row = r.rows[0];
    if (!row) return null;
    return {
        id: Number(row.id),
        username: row.username,
        name: row.name,
        role: row.role,
        class_name: row.class_name,
        desk_id: row.desk_id,
        workbench_id: row.workbench_id,
        email: row.email || null,
        must_change_password: Number(row.must_change_password) === 1
    };
}

async function requireStaff(req, res, next) {
    if (isDevice(req)) return next();
    const u = req.user || await getSessionUser(req);
    if (u && !u.must_change_password && u.role !== 'studente') return next();
    res.status(403).json({ error: 'Permessi docenti/admin richiesti' });
}

async function requireAdmin(req, res, next) {
    const u = req.user || await getSessionUser(req);
    if (u && !u.must_change_password && u.role === 'admin') return next();
    res.status(403).json({ error: 'Permessi amministratore richiesti' });
}

// 2) Protezione globale delle API: sessione obbligatoria + blocco totale finché must_change_password = 1
app.use('/api', async (req, res, next) => {
    try {
        if (/^\/auth\//.test(req.path) || req.path === '/reader/scan' || isDevice(req)) return next();
        const u = await getSessionUser(req);
        if (!u) return res.status(401).json({ error: 'Sessione non attiva' });
        if (u.must_change_password) {
            return res.status(403).json({
                error: 'Devi impostare la tua password personale al primo accesso',
                must_change_password: true
            });
        }
        req.user = u;
        next();
    } catch (e) { next(e); }
});

// ================= ROTTE AUTENTICAZIONE & GESTIONE PASSWORD =================
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
    const password = String(req.body.password || '');
    const r = await db.execute({
        sql: 'SELECT id, username, password_hash, full_name as name, role, class_name, desk_id, workbench_id, must_change_password, email FROM users WHERE username = ?',
        args: [username]
    });
    const row = r.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) {
        return res.status(401).json({ error: 'Password non corretta' });
    }

    const mustChange = Number(row.must_change_password) === 1;

    // Se l'account aveva già una password definitiva ma ancora in formato legacy, aggiorna silenziosamente a scrypt
    if (!mustChange && !String(row.password_hash).startsWith('scrypt$')) {
        await db.execute({
            sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
            args: [hashPassword(password), row.id]
        });
    }

    const user = {
        id: Number(row.id),
        username: row.username,
        name: row.name,
        role: row.role,
        class_name: row.class_name,
        desk_id: row.desk_id,
        workbench_id: row.workbench_id,
        email: row.email || null,
        must_change_password: mustChange
    };

    setSessionCookie(res, user.id);
    res.json({ user });
});

app.get('/api/auth/me', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sessione non attiva' });
    res.json({ user });
});

// Impostazione password obbligatoria al primo accesso (o dopo reset amministratore)
app.post('/api/auth/first-password', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sessione scaduta, rifai il login' });
    if (!user.must_change_password) {
        return res.status(400).json({ error: 'La password personale è già stata configurata' });
    }

    const newPass = String(req.body.new_password || '');
    const confirmPass = String(req.body.confirm_password || '');
    const email = String(req.body.email || '').trim().toLowerCase();

    if (newPass !== confirmPass) {
        return res.status(400).json({ error: 'Le due password non coincidono' });
    }
    const validationErr = validateNewPassword(newPass, user.username);
    if (validationErr) return res.status(400).json({ error: validationErr });

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Indirizzo email non valido' });
    }

    const newHash = hashPassword(newPass);
    await db.execute({
        sql: `UPDATE users
              SET password_hash = ?,
                  must_change_password = 0,
                  email = COALESCE(NULLIF(?, ''), email),
                  password_updated_at = ?
              WHERE id = ?`,
        args: [newHash, email, romeDateTime(), user.id]
    });

    const updated = await getSessionUser(req);
    res.json({ ok: true, user: updated });
});

// Cambio password volontario da utente autenticato
app.post('/api/auth/change-password', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sessione non attiva' });

    const currentPass = String(req.body.current_password || '');
    const newPass = String(req.body.new_password || '');
    const confirmPass = String(req.body.confirm_password || '');
    const email = String(req.body.email || '').trim().toLowerCase();

    const r = await db.execute({
        sql: 'SELECT password_hash FROM users WHERE id = ?',
        args: [user.id]
    });
    if (!r.rows[0] || !verifyPassword(currentPass, r.rows[0].password_hash)) {
        return res.status(401).json({ error: 'La password attuale non è corretta' });
    }

    if (newPass !== confirmPass) {
        return res.status(400).json({ error: 'Le nuove password non coincidono' });
    }
    if (newPass === currentPass) {
        return res.status(400).json({ error: 'La nuova password deve essere diversa da quella attuale' });
    }
    const validationErr = validateNewPassword(newPass, user.username);
    if (validationErr) return res.status(400).json({ error: validationErr });

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Indirizzo email non valido' });
    }

    await db.execute({
        sql: `UPDATE users
              SET password_hash = ?,
                  must_change_password = 0,
                  email = COALESCE(NULLIF(?, ''), email),
                  password_updated_at = ?
              WHERE id = ?`,
        args: [hashPassword(newPass), email, romeDateTime(), user.id]
    });

    res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('sc_session');
    res.json({ ok: true });
});

// ================= GESTIONE UTENTI & RESET PASSWORD (SOLO ADMIN) =================
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    const r = await db.execute(`
        SELECT id, username, full_name, role, class_name, desk_id, must_change_password, email, password_updated_at
        FROM users
        ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'docente' THEN 2 ELSE 3 END, full_name ASC
    `);
    res.json({
        users: r.rows.map(u => ({
            ...u,
            id: Number(u.id),
            must_change_password: Number(u.must_change_password) === 1
        }))
    });
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    const targetId = Number(req.params.id);
    if (!targetId) return res.status(400).json({ error: 'ID utente non valido' });

    const r = await db.execute({
        sql: 'SELECT id, username, full_name FROM users WHERE id = ?',
        args: [targetId]
    });
    const target = r.rows[0];
    if (!target) return res.status(404).json({ error: 'Utente non trovato' });

    const tempPassword = generateTempPassword();
    await db.execute({
        sql: 'UPDATE users SET password_hash = ?, must_change_password = 1, password_updated_at = NULL WHERE id = ?',
        args: [hashPassword(tempPassword), targetId]
    });

    res.json({
        ok: true,
        id: Number(target.id),
        username: target.username,
        full_name: target.full_name,
        temp_password: tempPassword
    });
});

// ================= ROTTE AULA E PRESENZE =================
app.get('/api/class-bundle/:cls', async (req, res) => {
    const cls = req.params.cls;
    if (req.user && req.user.role === 'studente' && req.user.class_name !== cls) return res.status(403).json({ error: 'Accesso negato' });
    const date = req.query.date || romeDate();

    const [students, allUsers, attendance, bathroomHistory, bathroomQueue, signatures, agenda, grades, notes] = await Promise.all([
        db.execute({ sql: "SELECT id, full_name, desk_id FROM users WHERE role = 'studente' AND class_name = ?", args: [cls] }),
        db.execute("SELECT id, full_name FROM users"),
        db.execute({ sql: "SELECT student_id, status, time, first_in FROM attendance WHERE class_name = ? AND date = ?", args: [cls, date] }),
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

// Regole: un solo alunno in bagno; una sola uscita aperta per alunno; se il bagno e' occupato si va in coda;
// al rientro entra automaticamente il primo della coda.
async function applyStatus({ student_id, class_name, date, status, time }) {
    const prev = (await db.execute({ sql: "SELECT status FROM attendance WHERE student_id = ? AND date = ?", args: [student_id, date] })).rows[0]?.status;
    if (status === prev) return { ok: true, unchanged: true };

    if (status === 'bagno') {
        const occ = (await db.execute({ sql: "SELECT student_id FROM attendance WHERE class_name = ? AND date = ? AND status = 'bagno' AND student_id != ?", args: [class_name, date, student_id] })).rows[0];
        if (occ) {
            const inQ = await db.execute({ sql: "SELECT id FROM bathroom_queue WHERE student_id = ? AND class_name = ?", args: [student_id, class_name] });
            if (inQ.rows.length === 0) {
                const u = (await db.execute({ sql: "SELECT full_name, desk_id FROM users WHERE id = ?", args: [student_id] })).rows[0] || {};
                await db.execute({ sql: "INSERT INTO bathroom_queue (student_id, student_name, desk_id, class_name, booked_at) VALUES (?, ?, ?, ?, ?)", args: [student_id, u.full_name || '', u.desk_id || null, class_name, time] });
            }
            return { ok: true, queued: true };
        }
    }

    await db.execute({
        sql: `INSERT INTO attendance (student_id, class_name, date, status, time, first_in) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, time = excluded.time,
                  first_in = COALESCE(attendance.first_in, excluded.first_in)`,
        args: [student_id, class_name, date, status, time, ['presente', 'ritardo', 'seconda_ora'].includes(status) ? time : null]
    });

    const open = (await db.execute({ sql: "SELECT id FROM bathroom_history WHERE student_id = ? AND date = ? AND in_time IS NULL ORDER BY id DESC LIMIT 1", args: [student_id, date] })).rows[0];
    let promoted = null;
    if (status === 'bagno') {
        if (!open) await db.execute({ sql: "INSERT INTO bathroom_history (student_id, class_name, date, out_time, in_time) VALUES (?, ?, ?, ?, NULL)", args: [student_id, class_name, date, time] });
        await db.execute({ sql: "DELETE FROM bathroom_queue WHERE student_id = ? AND class_name = ?", args: [student_id, class_name] });
    } else {
        if (open) await db.execute({ sql: "UPDATE bathroom_history SET in_time = ? WHERE id = ?", args: [time, open.id] });
        await db.execute({ sql: "DELETE FROM bathroom_queue WHERE student_id = ? AND class_name = ?", args: [student_id, class_name] });
        if (prev === 'bagno' && date === romeDate()) {
            const next = (await db.execute({ sql: "SELECT student_id FROM bathroom_queue WHERE class_name = ? ORDER BY id ASC LIMIT 1", args: [class_name] })).rows[0];
            if (next) { await applyStatus({ student_id: next.student_id, class_name, date, status: 'bagno', time }); promoted = next.student_id; }
        }
    }
    return { ok: true, promoted };
}

app.post('/api/attendance', requireStaff, async (req, res) => {
    const { student_id, class_id, date, status, time } = req.body;
    res.json(await applyStatus({ student_id, class_name: class_id, date, status, time }));
});

// Evento dal lettore NFC (ESP32). hold=true quando la tessera resta sul lettore il tempo di una richiesta bagno.
app.post('/api/reader/scan', async (req, res) => {
    if (!isDevice(req)) return res.status(401).json({ error: 'Chiave dispositivo non valida' });
    const { student_id, desk_id, class_name = '5AEE', hold = false } = req.body;
    const stu = (await db.execute(student_id
        ? { sql: "SELECT id, full_name FROM users WHERE id = ? AND role = 'studente'", args: [student_id] }
        : { sql: "SELECT id, full_name FROM users WHERE desk_id = ? AND class_name = ? AND role = 'studente'", args: [desk_id, class_name] })).rows[0];
    if (!stu) return res.status(404).json({ error: 'Alunno non trovato' });

    const now = Date.now();
    const last = (await db.execute({ sql: "SELECT ts FROM scan_log WHERE student_id = ?", args: [stu.id] })).rows[0];
    if (last && now - Number(last.ts) < 4000) return res.json({ ok: true, ignored: 'duplicate' }); // anti doppia lettura
    await db.execute({ sql: "INSERT INTO scan_log (student_id, ts) VALUES (?, ?) ON CONFLICT(student_id) DO UPDATE SET ts = excluded.ts", args: [stu.id, now] });

    const date = romeDate(), time = romeTime();
    const cur = (await db.execute({ sql: "SELECT status FROM attendance WHERE student_id = ? AND date = ?", args: [stu.id, date] })).rows[0]?.status || 'assente';
    let target;
    if (cur === 'bagno') target = 'presente';
    else if (hold) target = 'bagno';
    else if (['assente', 'ritardo', 'seconda_ora', 'fuori_aula', 'uscita_anticipata'].includes(cur)) target = 'presente';
    else return res.json({ ok: true, ignored: 'already_present' });

    const r = await applyStatus({ student_id: stu.id, class_name, date, status: target, time });
    res.json({ ...r, student: stu.full_name, status: r.queued ? 'in_coda' : target });
});

// Configurazione (classi, materie, disposizione banchi) letta dal database, solo dopo il login
app.get('/api/config', async (req, res) => {
    const r = await db.execute("SELECT key, value FROM app_config");
    const out = { classes: [], subjects: [], layouts: {} };
    for (const row of r.rows) {
        const v = JSON.parse(row.value);
        if (row.key === 'classes') out.classes = v;
        else if (row.key === 'subjects') out.subjects = v;
        else if (row.key.startsWith('layout:')) out.layouts[row.key.slice(7)] = v;
    }
    if (req.user && req.user.role === 'studente') {
        const mine = out.layouts[req.user.class_name];
        out.classes = []; out.layouts = mine ? { [req.user.class_name]: mine } : {};
    }
    res.json(out);
});
app.put('/api/config/:key', requireAdmin, async (req, res) => {
    await db.execute({ sql: "INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [req.params.key, JSON.stringify(req.body.value)] });
    res.json({ ok: true });
});

// Cassetta telefoni: 24 slot, il sensore (cella di carico) manda { slot, present }
app.get('/api/phones/:cls', async (req, res) => {
    const r = await db.execute({ sql: "SELECT slot, present, time FROM phone_slots WHERE class_name = ? AND date = ?", args: [req.params.cls, req.query.date || romeDate()] });
    res.json({ slots: r.rows });
});
app.post('/api/phones', requireStaff, async (req, res) => {
    const { class_name = '5AEE', slot, present } = req.body;
    const n = Number(slot);
    if (!(n >= 1 && n <= 24)) return res.status(400).json({ error: 'Slot non valido (1-24)' });
    await db.execute({
        sql: `INSERT INTO phone_slots (class_name, date, slot, present, time) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(class_name, date, slot) DO UPDATE SET present = excluded.present, time = excluded.time`,
        args: [class_name, req.body.date || romeDate(), n, present ? 1 : 0, romeTime()]
    });
    res.json({ ok: true });
});

// ================= ROTTE CODA BAGNO =================
app.post('/api/bathroom-queue/join', async (req, res) => {
    const { student_id, student_name, desk_id, class_name, booked_at } = req.body;
    if (req.user.role === 'studente' && Number(student_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'Puoi prenotare solo per il tuo account' });
    }
    const exists = await db.execute({
        sql: "SELECT id FROM bathroom_queue WHERE student_id = ? AND class_name = ?",
        args: [student_id, class_name]
    });
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Sei già in coda' });
    const inWc = await db.execute({ sql: "SELECT 1 FROM attendance WHERE student_id = ? AND date = ? AND status = 'bagno'", args: [student_id, romeDate()] });
    if (inWc.rows.length > 0) return res.status(400).json({ error: 'Sei già in bagno' });

    await db.execute({
        sql: "INSERT INTO bathroom_queue (student_id, student_name, desk_id, class_name, booked_at) VALUES (?, ?, ?, ?, ?)",
        args: [student_id, student_name, desk_id, class_name, booked_at || romeTime()]
    });
    res.json({ ok: true });
});

app.post('/api/bathroom-queue/remove', async (req, res) => {
    const { identifier, class_name } = req.body;
    if (req.user.role === 'studente') {
        await db.execute({
            sql: "DELETE FROM bathroom_queue WHERE student_id = ? AND class_name = ?",
            args: [req.user.id, class_name]
        });
        return res.json({ ok: true });
    }
    await db.execute({
        sql: "DELETE FROM bathroom_queue WHERE (id = ? OR student_id = ?) AND class_name = ?",
        args: [identifier, identifier, class_name]
    });
    res.json({ ok: true });
});

app.post('/api/bathroom-queue/clear', requireStaff, async (req, res) => {
    await db.execute({
        sql: "DELETE FROM bathroom_queue WHERE class_name = ?",
        args: [req.body.class_name]
    });
    res.json({ ok: true });
});

// ================= ROTTE LABORATORIO & ARMADIO =================
app.get('/api/lab/state/:cls', async (req, res) => {
    const cls = req.params.cls;
    if (req.user && req.user.role === 'studente' && req.user.class_name !== cls) return res.status(403).json({ error: 'Accesso negato' });
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
    await db.execute({
        sql: "UPDATE users SET workbench_id = ? WHERE id = ?",
        args: [req.body.workbench_id, req.user.id]
    });
    res.json({ ok: true });
});

app.post('/api/lab/checkout', async (req, res) => {
    const { item_id, workbench_id, class_name } = req.body;
    const r = await db.execute({ sql: "SELECT * FROM lab_inventory WHERE id = ?", args: [item_id] });
    const item = r.rows[0];
    if (!item || Number(item.available_qty) <= 0) {
        return res.status(400).json({ error: 'Componente esaurito nell\'armadio' });
    }

    const unitNum = Number(item.total_qty) - Number(item.available_qty) + 1;
    const unitLabel = `${item.name} (#${unitNum})`;
    const nowTime = romeTime();
    const studentName = req.user ? req.user.name : 'Operatore';

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

    const nowTime = romeTime();
    await db.batch([
        { sql: "UPDATE lab_loans SET status = 'returned', returned_at = ? WHERE id = ?", args: [nowTime, loan_id] },
        { sql: "UPDATE lab_inventory SET available_qty = MIN(total_qty, available_qty + 1) WHERE id = ?", args: [loan.item_id] }
    ], 'write');

    res.json({ ok: true, unitLabel: loan.unit_label });
});

// ================= ROTTE FIRME, AGENDA, VOTI, NOTE & ESP32 =================
app.post('/api/signatures', requireStaff, async (req, res) => {
    const { date, hour, subject, topic, class_name } = req.body;
    await db.execute({
        sql: "INSERT INTO signatures (class_name, date, hour, subject, topic, teacher) VALUES (?, ?, ?, ?, ?, ?)",
        args: [class_name, date, hour, subject, topic, req.user ? req.user.name : 'Docente']
    });
    res.json({ ok: true });
});

app.delete('/api/signatures/:id', requireStaff, async (req, res) => {
    await db.execute({ sql: "DELETE FROM signatures WHERE id = ?", args: [req.params.id] });
    res.json({ ok: true });
});

app.post('/api/agenda', requireStaff, async (req, res) => {
    const { date, subject, type, description, class_name } = req.body;
    await db.execute({
        sql: "INSERT INTO agenda (class_name, date, subject, type, description) VALUES (?, ?, ?, ?, ?)",
        args: [class_name, date, subject, type, description]
    });
    res.json({ ok: true });
});

app.delete('/api/agenda/:id', requireStaff, async (req, res) => {
    await db.execute({ sql: "DELETE FROM agenda WHERE id = ?", args: [req.params.id] });
    res.json({ ok: true });
});

app.post('/api/grades', requireStaff, async (req, res) => {
    const { student_id, subject, value, type, date, class_id } = req.body;
    await db.execute({
        sql: "INSERT INTO grades (student_id, class_name, subject, value, type, date) VALUES (?, ?, ?, ?, ?, ?)",
        args: [student_id, class_id, subject, value, type, date]
    });
    res.json({ ok: true });
});

app.delete('/api/grades/:id', requireStaff, async (req, res) => {
    await db.execute({ sql: "DELETE FROM grades WHERE id = ?", args: [req.params.id] });
    res.json({ ok: true });
});

app.post('/api/notes', requireStaff, async (req, res) => {
    const { student_id, text, type, date, class_id } = req.body;
    await db.execute({
        sql: "INSERT INTO notes (student_id, class_name, text, type, date, teacher) VALUES (?, ?, ?, ?, ?, ?)",
        args: [student_id, class_id, text, type, date, req.user ? req.user.name : 'Docente']
    });
    res.json({ ok: true });
});

app.delete('/api/notes/:id', requireStaff, async (req, res) => {
    await db.execute({ sql: "DELETE FROM notes WHERE id = ?", args: [req.params.id] });
    res.json({ ok: true });
});

app.get('/api/devices', requireAdmin, async (req, res) => {
    const r = await db.execute("SELECT * FROM esp_devices");
    res.json({ devices: r.rows });
});

app.post('/api/devices/tamper', requireAdmin, async (req, res) => {
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
