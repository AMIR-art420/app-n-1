// سرور پیام‌رسان: اتاق‌های رمزدار + چت لحظه‌ای + جستجوی فارسی/انگلیسی
const express = require('express'), http = require('http'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const KEEP_DAYS = +process.env.KEEP_DAYS || 30; // پیام‌های قدیمی‌تر پاک می‌شوند
const MAX_OWN = +process.env.MAX_ROOMS_PER_USER || 5; // سقف اتاق‌هایی که هر نفر می‌تواند بسازد
const MAX_SUBS = 50; // سقف اتاق‌های عضو در یک اتصال
const db = new Database(process.env.DB || path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, name TEXT, norm TEXT, compact TEXT UNIQUE, salt TEXT, hash TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY, room INTEGER, nick TEXT, text TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS m_room ON msgs(room, id);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, norm TEXT UNIQUE, salt TEXT, hash TEXT, av INTEGER DEFAULT 0, avatar BLOB, created INTEGER);`);
// مهاجرت: ستون سازنده‌ی اتاق (هش شناسه‌ی دستگاه)
if (!db.prepare('PRAGMA table_info(rooms)').all().some(c => c.name === 'owner')) db.exec('ALTER TABLE rooms ADD COLUMN owner TEXT');
db.exec('CREATE INDEX IF NOT EXISTS r_owner ON rooms(owner)');
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''");
if (!db.prepare('PRAGMA table_info(msgs)').all().some(c => c.name === 'uid')) db.exec('ALTER TABLE msgs ADD COLUMN uid INTEGER');

// توکن عضویت: بعد از ورود با رمز، سرور یک توکن امضاشده می‌دهد تا برای اتصال‌های بعدی نیازی به ارسال رمز نباشد
let secret = (db.prepare("SELECT v FROM meta WHERE k='secret'").get() || {}).v;
if (!secret) { secret = crypto.randomBytes(32).toString('hex'); db.prepare("INSERT INTO meta(k,v) VALUES('secret',?)").run(secret); }
const tokenFor = room => crypto.createHmac('sha256', secret).update(`m:${room.id}:${room.hash}`).digest('hex');
const tokenOk = (t, room) => { const a = Buffer.from(String(t || '')), b = Buffer.from(tokenFor(room)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// ---- حساب کاربری: توکن ورود = «شناسه.امضا»؛ با عوض‌شدن رمز یا حذف حساب خودبه‌خود نامعتبر می‌شود ----
const sigOf = u => crypto.createHmac('sha256', secret).update(`u:${u.id}:${u.hash}`).digest('hex');
const userToken = u => `${u.id}.${sigOf(u)}`;
const userByToken = t => {
  const [id, sig] = String(t || '').split('.');
  if (!/^\d{1,12}$/.test(id || '')) return null;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+id);
  if (!u) return null;
  const a = Buffer.from(String(sig || '')), b = Buffer.from(sigOf(u));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
};
const authUser = req => userByToken((String(req.headers.authorization || '').match(/^Bearer (.+)$/) || [])[1]);
const pubUser = u => ({ id: u.id, name: u.name, av: u.av || 0, bio: u.bio || '' });
const ownerOf = req => { const u = authUser(req); return u ? 'u' + u.id : null; };
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u200e\u200f\u202a-\u202e]/g, '').trim().replace(/\s+/g, ' ');

// یکسان‌سازی متن برای جستجو: ی/ک عربی، اعراب، نیم‌فاصله، ارقام فارسی/عربی، حروف بزرگ
const norm = s => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ۀە]/g, 'ه').replace(/[أإآٱ]/g, 'ا')
  .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6F0).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660)
  .replace(/[\u064B-\u065F\u0670\u0640\u200c\u200d]/g, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

const compact = s => norm(s).replace(/ /g, '');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const checkPw = (pw, salt, hash) => {
  const a = Buffer.from(hashPw(pw, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// محدودیت تلاش (جلوگیری از حدس زدن رمز)
const fails = new Map();
const blocked = (k, max, win) => (fails.get(k) || []).filter(t => Date.now() - t < win).length >= max;
const record = k => fails.set(k, [...(fails.get(k) || []).filter(t => Date.now() - t < 3600e3), Date.now()]);
setInterval(() => fails.clear(), 6 * 3600e3);
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

const live = new Map(); // roomId -> Set<ws>  (الان داخل صفحه‌ی چت آن اتاق‌اند)
const subs = new Map(); // roomId -> Set<ws>  (عضو اتاق‌اند و پیام/اعلان همان اتاق را می‌گیرند)
const addTo = (m, id, ws) => { if (!m.has(id)) m.set(id, new Set()); m.get(id).add(ws); };
const delFrom = (m, id, ws) => { const s = m.get(id); if (s) { s.delete(ws); if (!s.size) m.delete(id); } };
const online = id => (live.get(id) || new Set()).size;
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const broadcast = (map, id, o) => (map.get(id) || []).forEach(c => send(c, o));

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const deleteRoom = id => {
  db.transaction(() => { db.prepare('DELETE FROM msgs WHERE room=?').run(id); db.prepare('DELETE FROM rooms WHERE id=?').run(id); })();
  broadcast(subs, id, { t: 'gone', room: id });
  (subs.get(id) || []).forEach(c => { c.subs.delete(id); if (c.room === id) c.room = null; });
  subs.delete(id); live.delete(id);
};

// جستجوی اتاق: همه‌ی کلمات باید در نام اتاق باشند
app.get('/api/rooms', (req, res) => {
  const q = norm(req.query.q), toks = q.split(' ').filter(Boolean).slice(0, 5);
  const esc = t => `%${t.replace(/[\\%_]/g, '\\$&')}%`;
  // یا کل عبارت (بدون فاصله) در نام باشد، یا همه‌ی کلمه‌ها جدا جدا
  const where = q ? `(compact LIKE ? ESCAPE '\\' OR (${toks.map(() => `norm LIKE ? ESCAPE '\\'`).join(' AND ')}))` : '1';
  const args = q ? [esc(q.replace(/ /g, '')), ...toks.map(esc)] : [];
  const rows = db.prepare(`SELECT id, name FROM rooms WHERE ${where} ORDER BY id DESC LIMIT 60`).all(...args)
    .map(r => ({ ...r, online: online(r.id) }))
    .sort((a, b) => b.online - a.online).slice(0, 40);
  res.json(rows);
});

// اتاق‌هایی که این دستگاه ساخته
app.get('/api/mine', (req, res) => {
  const owner = ownerOf(req);
  if (!owner) return res.status(401).json({ error: 'unauthorized' });
  const rooms = owner ? db.prepare('SELECT id, name FROM rooms WHERE owner=? ORDER BY id').all(owner) : [];
  res.json({ rooms, max: MAX_OWN });
});

app.post('/api/rooms', (req, res) => {
  const ip = ipOf(req), owner = ownerOf(req), name = String(req.body.name || '').trim().replace(/\s+/g, ' '), pw = String(req.body.password || '');
  if (!owner) return res.status(401).json({ error: 'ابتدا وارد حساب خود شوید.' });
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'نام اتاق باید بین ۲ تا ۴۰ حرف باشد.' });
  if (pw.length < 6 || pw.length > 64) return res.status(400).json({ error: 'رمز اتاق باید حداقل ۶ حرف باشد.' });
  if (db.prepare('SELECT COUNT(*) c FROM rooms WHERE owner=?').get(owner).c >= MAX_OWN)
    return res.status(403).json({ error: `هر نفر حداکثر ${MAX_OWN.toLocaleString('fa-IR')} اتاق می‌تواند بسازد. برای ساخت اتاق جدید، یکی از اتاق‌های خودتان را حذف کنید.` });
  if (blocked('c' + ip, 5, 3600e3)) return res.status(429).json({ error: 'تعداد اتاق‌های ساخته‌شده زیاد است. بعداً تلاش کنید.' });
  const n = norm(name), salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = db.prepare('INSERT INTO rooms(name,norm,compact,salt,hash,created,owner) VALUES(?,?,?,?,?,?,?)').run(name, n, n.replace(/ /g, ''), salt, hashPw(pw, salt), Date.now(), owner);
    record('c' + ip);
    res.json({ id: r.lastInsertRowid, name });
  } catch { res.status(409).json({ error: 'اتاقی با این نام وجود دارد.' }); }
});

// حذف اتاق (فقط سازنده)
app.delete('/api/rooms/:id', (req, res) => {
  const owner = ownerOf(req), id = +req.params.id;
  if (!owner) return res.status(401).json({ error: 'unauthorized' });
  const room = owner && db.prepare('SELECT id, owner FROM rooms WHERE id=?').get(id);
  if (!room || room.owner !== owner) return res.status(404).json({ error: 'اتاق پیدا نشد یا مال شما نیست.' });
  deleteRoom(id);
  res.json({ ok: true });
});

// ---- ثبت‌نام / ورود / پروفایل ----
const sendAuth = (res, u) => res.json({ token: userToken(u), user: pubUser(u) });
app.post('/api/register', (req, res) => {
  const ip = ipOf(req), name = cleanName(req.body.name), pw = String(req.body.password || '');
  if (name.length < 2 || name.length > 24) return res.status(400).json({ error: 'نام باید بین ۲ تا ۲۴ حرف باشد.' });
  if (pw.length < 6 || pw.length > 64) return res.status(400).json({ error: 'رمز عبور باید حداقل ۶ حرف باشد.' });
  if (blocked('g' + ip, 10, 3600e3)) return res.status(429).json({ error: 'تعداد ثبت‌نام زیاد بود. بعداً تلاش کنید.' });
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = db.prepare('INSERT INTO users(name,norm,salt,hash,created) VALUES(?,?,?,?,?)').run(name, compact(name), salt, hashPw(pw, salt), Date.now());
    record('g' + ip);
    sendAuth(res, db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid));
  } catch { res.status(409).json({ error: 'این نام قبلاً گرفته شده. نام دیگری انتخاب کنید.' }); }
});
app.post('/api/login', (req, res) => {
  const ip = ipOf(req), n = compact(cleanName(req.body.name)), pw = String(req.body.password || '').slice(0, 64);
  if (blocked('l' + ip, 10, 600e3) || blocked('n' + n, 20, 600e3)) return res.status(429).json({ error: 'تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید.' });
  const u = n && db.prepare('SELECT * FROM users WHERE norm=?').get(n);
  if (!u || !checkPw(pw, u.salt, u.hash)) { record('l' + ip); record('n' + n); return res.status(401).json({ error: 'نام یا رمز عبور اشتباه است.' }); }
  sendAuth(res, u);
});
app.get('/api/me', (req, res) => {
  const u = authUser(req);
  u ? res.json({ user: pubUser(u) }) : res.status(401).json({ error: 'unauthorized' });
});
// عکس پروفایل: کلاینت آن را به JPEG مربعی کوچک تبدیل می‌کند؛ سرور هم نوع و حجم را بررسی می‌کند
app.post('/api/avatar', express.raw({ type: () => true, limit: '200kb' }), (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const b = req.body;
  if (!Buffer.isBuffer(b) || b.length < 100 || b[0] !== 0xFF || b[1] !== 0xD8 || b[2] !== 0xFF) return res.status(400).json({ error: 'فقط تصویر JPEG پذیرفته می‌شود.' });
  const av = Date.now();
  db.prepare('UPDATE users SET avatar=?, av=? WHERE id=?').run(b, av, u.id);
  res.json({ user: { ...pubUser(u), av } });
});
app.delete('/api/avatar', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  db.prepare('UPDATE users SET avatar=NULL, av=0 WHERE id=?').run(u.id);
  res.json({ user: { ...pubUser(u), av: 0 } });
});
app.get('/api/avatar/:id', (req, res) => {
  const r = /^\d{1,12}$/.test(req.params.id) && db.prepare('SELECT avatar FROM users WHERE id=?').get(+req.params.id);
  if (!r || !r.avatar) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }).send(r.avatar);
});
// ---- ویرایش پروفایل ----
const userById = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
app.put('/api/profile', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const name = cleanName(req.body.name), bio = String(req.body.bio || '').replace(/[\u0000-\u0008\u000b-\u001f\u200e\u200f\u202a-\u202e]/g, '').trim().slice(0, 70);
  if (name.length < 2 || name.length > 24) return res.status(400).json({ error: 'نام باید بین ۲ تا ۲۴ حرف باشد.' });
  try { db.prepare('UPDATE users SET name=?, norm=?, bio=? WHERE id=?').run(name, compact(name), bio, u.id); }
  catch { return res.status(409).json({ error: 'این نام قبلاً گرفته شده. نام دیگری انتخاب کنید.' }); }
  res.json({ user: pubUser(userById(u.id)) });
});
// تغییر رمز: توکن‌های قبلی (دستگاه‌های دیگر) باطل می‌شوند و توکن جدید برمی‌گردد
app.post('/api/password', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const oldPw = String(req.body.oldPassword || '').slice(0, 64), newPw = String(req.body.newPassword || '');
  if (newPw.length < 6 || newPw.length > 64) return res.status(400).json({ error: 'رمز جدید باید حداقل ۶ حرف باشد.' });
  if (blocked('p' + u.id, 5, 600e3)) return res.status(429).json({ error: 'تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید.' });
  if (!checkPw(oldPw, u.salt, u.hash)) { record('p' + u.id); return res.status(403).json({ error: 'رمز فعلی اشتباه است.' }); }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(newPw, salt), u.id);
  sendAuth(res, userById(u.id));
});
// حذف حساب: اتاق‌های ساخته‌شده توسط او پاک می‌شود و پیام‌هایش بی‌نام‌ونشان می‌ماند
app.delete('/api/account', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  if (blocked('p' + u.id, 5, 600e3)) return res.status(429).json({ error: 'تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید.' });
  if (!checkPw(String(req.body.password || '').slice(0, 64), u.salt, u.hash)) { record('p' + u.id); return res.status(403).json({ error: 'رمز عبور اشتباه است.' }); }
  db.prepare('SELECT id FROM rooms WHERE owner=?').all('u' + u.id).forEach(r => deleteRoom(r.id));
  db.prepare('UPDATE msgs SET uid=NULL WHERE uid=?').run(u.id);
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  wss.clients.forEach(c => { if (c.user && c.user.id === u.id) { send(c, { t: 'autherr' }); c.user = null; } });
  res.json({ ok: true });
});
// نمایش پروفایل دیگران (با زدن روی عکس در چت)
app.get('/api/user/:id', (req, res) => {
  if (!authUser(req)) return res.status(401).json({ error: 'unauthorized' });
  const u = /^\d{1,12}$/.test(req.params.id) && userById(+req.params.id);
  u ? res.json({ user: pubUser(u) }) : res.status(404).json({ error: 'کاربر پیدا نشد.' });
});
app.use((err, req, res, next) => res.status(err.status || 400).json({ error: 'درخواست نامعتبر است.' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });

// خارج شدن از صفحه‌ی چت (عضویت و دریافت اعلان می‌ماند)
function unpresent(ws) {
  if (!ws.room) return;
  const id = ws.room; delFrom(live, id, ws); ws.room = null;
  broadcast(live, id, { t: 'online', room: id, n: online(id) });
}
const subscribe = (ws, id) => { ws.subs.add(id); addTo(subs, id, ws); };
const unsubscribe = (ws, id) => { if (ws.room === id) unpresent(ws); ws.subs.delete(id); delFrom(subs, id, ws); };

// بررسی عضویت: با توکن (بی‌هزینه) یا رمز اتاق (محدودیت تلاش دارد)
function authorize(ws, it) {
  const id = +it.id, room = db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
  if (!room) return { gone: true };
  if (it.token && tokenOk(it.token, room)) return { room };
  if (it.password) {
    const kIp = 'j' + ws.ip, kRoom = 'r' + id;
    if (blocked(kIp, 10, 60e3) || blocked(kRoom, 30, 600e3)) return { limited: true };
    if (checkPw(String(it.password), room.salt, room.hash)) return { room };
    record(kIp); record(kRoom);
  }
  return { auth: true };
}

wss.on('connection', (ws, req) => {
  ws.ip = ipOf(req); ws.alive = true; ws.room = null; ws.subs = new Set(); ws.user = null; ws.stamps = [];
  ws.on('pong', () => (ws.alive = true));
  ws.on('close', () => { unpresent(ws); [...ws.subs].forEach(id => delFrom(subs, id, ws)); });
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.t === 'auth') {
      const u = userByToken(d.token);
      if (!u) return send(ws, { t: 'autherr' });
      ws.user = u; return send(ws, { t: 'authed', user: pubUser(u) });
    }
    if (!ws.user) return send(ws, { t: 'autherr' });
    if (d.t === 'sub') {
      // عضویت پس‌زمینه: فقط اتاق‌هایی که فرد واقعاً عضوشان است (توکن یا رمز درست) پیام و اعلان می‌گیرند
      const ok = [], bad = [];
      for (const it of (Array.isArray(d.items) ? d.items : []).slice(0, MAX_SUBS)) {
        const r = authorize(ws, it || {});
        if (r.room) { subscribe(ws, r.room.id); ok.push({ id: r.room.id, name: r.room.name, token: tokenFor(r.room) }); }
        else bad.push({ id: +(it || {}).id, why: r.gone ? 'gone' : r.auth ? 'auth' : 'limit' });
      }
      send(ws, { t: 'subbed', ok, bad });
    } else if (d.t === 'join') {
      const r = authorize(ws, d);
      if (r.limited) return send(ws, { t: 'err', m: 'تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید.' });
      if (r.gone) return send(ws, { t: 'err', m: 'این اتاق دیگر وجود ندارد.' });
      if (r.auth) return send(ws, { t: 'err', m: 'رمز اتاق اشتباه است.' });
      const id = r.room.id;
      unpresent(ws); subscribe(ws, id);
      ws.room = id; addTo(live, id, ws);
      const history = db.prepare('SELECT COALESCE(u.name, m.nick) nick, m.text, m.ts, m.uid, COALESCE(u.av, 0) av FROM msgs m LEFT JOIN users u ON u.id = m.uid WHERE m.room=? ORDER BY m.id DESC LIMIT 100').all(id).reverse();
      send(ws, { t: 'joined', id, name: r.room.name, token: tokenFor(r.room), history });
      broadcast(live, id, { t: 'online', room: id, n: online(id) });
    } else if (d.t === 'leave') {
      unpresent(ws);
    } else if (d.t === 'unsub') {
      unsubscribe(ws, +d.id);
    } else if (d.t === 'msg' && ws.room) {
      const text = String(d.text || '').trim().slice(0, 1000);
      const now = Date.now(); ws.stamps = ws.stamps.filter(t => now - t < 3000);
      if (!text || ws.stamps.length >= 5) return;
      ws.stamps.push(now);
      const u = db.prepare('SELECT id, name, av FROM users WHERE id=?').get(ws.user.id);
      if (!u) return send(ws, { t: 'autherr' });
      db.prepare('INSERT INTO msgs(room,nick,text,ts,uid) VALUES(?,?,?,?,?)').run(ws.room, u.name, text, now, u.id);
      broadcast(subs, ws.room, { t: 'msg', room: ws.room, uid: u.id, nick: u.name, av: u.av || 0, text, ts: now });
    }
  });
});

// قطع اتصال‌های مرده + پاکسازی پیام‌های قدیمی
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30e3);
const prune = () => db.prepare('DELETE FROM msgs WHERE ts < ?').run(Date.now() - KEEP_DAYS * 864e5);
prune(); setInterval(prune, 6 * 3600e3);

server.listen(PORT, () => console.log('listening on', PORT));
