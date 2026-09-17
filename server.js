const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const session = require('express-session');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

const dataDir = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(dataDir, 'raja.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 phone TEXT UNIQUE NOT NULL,
 name TEXT NOT NULL,
 pin_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS game_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 phone TEXT NOT NULL,
 room TEXT NOT NULL,
 result TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'change-this-before-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);
app.use(express.static(__dirname));

const rooms = new Map();
const colors = ['red', 'green', 'yellow', 'blue'];
const diceFaces = ['⚀','⚁','⚂','⚃','⚄','⚅'];

function cleanPhone(value) { return String(value || '').replace(/\D/g, '').slice(-10); }
function validPhone(value) { return /^\d{10}$/.test(value); }
function validPin(value) { return /^\d{4,6}$/.test(String(value || '')); }
function cleanName(value) { return String(value || '').trim().slice(0, 30); }
function me(req) { return req.session.user || null; }

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}
function verifyPin(pin, stored) {
  try {
    const [kind, salt, expected] = String(stored).split(':');
    if (kind !== 'scrypt' || !salt || !expected) return false;
    const actual = crypto.scryptSync(String(pin), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}
function setUserSession(req, user, cb) {
  req.session.regenerate(err => {
    if (err) return cb(err);
    req.session.user = user;
    req.session.save(cb);
  });
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'RAJA Entertainment' }));

app.post('/api/register', (req, res) => {
  const phone = cleanPhone(req.body.phone);
  const name = cleanName(req.body.name);
  const pin = String(req.body.pin || '');
  if (!validPhone(phone)) return res.status(400).json({ error: '10 digit mobile number डालें।' });
  if (!name) return res.status(400).json({ error: 'नाम डालें।' });
  if (!validPin(pin)) return res.status(400).json({ error: '4-6 digit PIN बनाइए।' });
  try {
    const info = db.prepare('INSERT INTO users(phone,name,pin_hash) VALUES(?,?,?)').run(phone, name, hashPin(pin));
    const user = { id: Number(info.lastInsertRowid), phone, name };
    setUserSession(req, user, err => {
      if (err) return res.status(500).json({ error: 'Session error.' });
      res.json({ ok: true, user });
    });
  } catch {
    res.status(409).json({ error: 'यह mobile number पहले से registered है।' });
  }
});

app.post('/api/login', (req, res) => {
  const phone = cleanPhone(req.body.phone);
  const pin = String(req.body.pin || '');
  const u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  if (!u || !verifyPin(pin, u.pin_hash)) return res.status(401).json({ error: 'Mobile number या PIN गलत है।' });
  const user = { id: u.id, phone: u.phone, name: u.name };
  setUserSession(req, user, err => {
    if (err) return res.status(500).json({ error: 'Session error.' });
    res.json({ ok: true, user });
  });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ user: me(req) }));

function requireAdmin(req, res, next) {
  const user = me(req);
  const adminPhone = cleanPhone(process.env.ADMIN_PHONE);

  if (!user || user.phone !== adminPhone) {
    return res.status(403).json({ error: 'Admin access denied' });
  }

  next();
}

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT id, phone, name, created_at FROM users ORDER BY id DESC'
  ).all();

  res.json({ users });
});

function makeCode() {
  let c;
  do c = 'RAJA' + Math.floor(100 + Math.random() * 900);
  while (rooms.has(c));
  return c;
}
function state(room) {
  return {
    code: room.code,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, pawns: p.pawns, ready: p.ready })),
    started: room.started,
    turn: room.turn,
    dice: room.dice,
    winner: room.winner,
    chat: room.chat.slice(-30)
  };
}
function emit(room) { io.to(room.code).emit('state', state(room)); }
function saveResult(room, winnerId) {
  const p = room.players.get(winnerId);
  if (!p || !p.phone) return;
  db.prepare('INSERT INTO game_history(phone,room,result) VALUES(?,?,?)').run(p.phone, room.code, 'WIN');
}

// Share the Express session with Socket.IO so a logged-in browser is authenticated.
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.on('connection', socket => {
  const u = socket.request.session && socket.request.session.user;
  if (!u) return socket.emit('errorMessage', 'पहले Login करें।');
  socket.data.user = u;

  socket.on('createRoom', () => {
    const code = makeCode();
    const room = { code, players: new Map(), started: false, turn: null, dice: 0, winner: null, chat: [] };
    room.players.set(socket.id, { id: socket.id, phone: u.phone, name: u.name, color: 'red', pawns: [0,0,0,0], ready: true });
    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;
    emit(room);
  });

  socket.on('joinRoom', ({ roomCode } = {}) => {
    const code = String(roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('errorMessage', 'Room नहीं मिला।');
    if (room.started) return socket.emit('errorMessage', 'Game पहले ही शुरू हो चुका है।');
    if (room.players.size >= 4) return socket.emit('errorMessage', 'Room full है।');
    room.players.set(socket.id, { id: socket.id, phone: u.phone, name: u.name, color: colors[room.players.size], pawns: [0,0,0,0], ready: true });
    socket.join(code);
    socket.data.room = code;
    emit(room);
  });

  socket.on('ready', () => {
    const room = rooms.get(socket.data.room);
    const player = room && room.players.get(socket.id);
    if (player && !room.started) { player.ready = !player.ready; emit(room); }
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    if (room.players.size < 2) return socket.emit('errorMessage', 'कम से कम 2 players चाहिए।');
    if ([...room.players.values()].some(p => !p.ready)) return socket.emit('errorMessage', 'सभी players Ready हों।');
    room.started = true;
    room.turn = [...room.players.keys()][0];
    room.dice = 0;
    room.winner = null;
    emit(room);
  });

  socket.on('rollDice', () => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started || room.winner || room.turn !== socket.id || room.dice) return;
    room.dice = 1 + Math.floor(Math.random() * 6);
    emit(room);
  });

  socket.on('movePawn', ({ index } = {}) => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started || room.winner || room.turn !== socket.id || !room.dice) return;
    const player = room.players.get(socket.id);
    const i = Number(index);
    const d = room.dice;
    if (!player || !Number.isInteger(i) || i < 0 || i > 3) return;
    let pos = player.pawns[i];
    if (pos === 0) { if (d !== 6) return; pos = 1; }
    else pos = Math.min(57, pos + d);
    player.pawns[i] = pos;
    room.dice = 0;
    if (player.pawns.every(x => x === 57)) {
      room.winner = player.id;
      saveResult(room, player.id);
    } else if (d !== 6) {
      const ids = [...room.players.keys()];
      const k = ids.indexOf(socket.id);
      room.turn = ids[(k + 1) % ids.length];
    }
    emit(room);
  });

  socket.on('chat', ({ msg } = {}) => {
    const room = rooms.get(socket.data.room);
    const player = room && room.players.get(socket.id);
    if (!room || !player) return;
    const text = String(msg || '').trim().slice(0, 180);
    if (text) { room.chat.push({ name: player.name, msg: text }); emit(room); }
  });

  socket.on('rematch', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.players.size < 2) return;
    room.players.forEach(p => p.pawns = [0,0,0,0]);
    room.started = true;
    room.winner = null;
    room.dice = 0;
    room.turn = [...room.players.keys()][0];
    emit(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    room.players.delete(socket.id);
    if (!room.players.size) return rooms.delete(room.code);
    if (room.turn === socket.id) room.turn = [...room.players.keys()][0];
    if (room.players.size < 2) room.started = false;
    emit(room);
  });
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, '0.0.0.0', () => console.log(`RAJA Entertainment listening on ${PORT}`));
