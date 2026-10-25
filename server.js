/* WAO Server
   Liefert die Seiten aus und speichert die Daten der Praxis-App zentral, damit Patienten-Handy und Praxis-Gerät
   dieselben Termine, Patienten und Übungen sehen. Keine externen Pakete nötig (Node.js 18+).

   Start:   ADMIN_PIN=geheim node server.js
   Umgebung: PORT (Standard 3000), DATA_DIR (Standard ./data), ADMIN_PIN (Pflicht beim ersten Start)

   Rollen
   - Praxis:   nach Anmeldung mit PIN (HttpOnly-Cookie), voller Zugriff
   - Patient:  mit persönlichem Code (Header X-Patient-Code), nur eigene Daten
   - Öffentlich: Einstellungen, Übungen, belegte Zeiten (ohne Namen), Termin anfragen */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ASSETS = path.join(DATA, 'assets');
const DB_FILE = path.join(DATA, 'db.json');
const MAX_JSON = 2 * 1024 * 1024;
const MAX_ASSET = 25 * 1024 * 1024;
const SESSION_MS = 12 * 3600 * 1000;
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/physio.html': 'physio.html',
  '/uebungskatalog.html': 'uebungskatalog.html', '/wao-local.js': 'wao-local.js' };
const ASSET_TYPES = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime)|application\/pdf)$/;

fs.mkdirSync(ASSETS, { recursive: true });

/* ---------- Speicher ---------- */
let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let version = 1, saveTimer = null;
function changed() {
  version++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}
function flush() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

const coll = n => (db[n] = db[n] || {});
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const newId = () => crypto.randomBytes(10).toString('hex');
const getPath = (o, p) => p.split('.').reduce((a, k) => a == null ? undefined : a[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); let c = o; ks.slice(0, -1).forEach(k => { if (typeof c[k] !== 'object' || c[k] === null) c[k] = {}; c = c[k]; }); c[ks[ks.length - 1]] = v; };
const cmp = (a, b) => a == null && b == null ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------- Praxis-PIN ---------- */
const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') });
function checkPin(pin) {
  const a = db._auth; if (!a) return false;
  const h = Buffer.from(hashPin(pin, a.salt).hash, 'hex');
  return crypto.timingSafeEqual(h, Buffer.from(a.hash, 'hex'));
}
if (!db._auth) {
  if (!process.env.ADMIN_PIN || process.env.ADMIN_PIN.length < 4) {
    console.error('Beim ersten Start bitte eine Praxis-PIN setzen: ADMIN_PIN=<mind. 4 Zeichen> node server.js');
    process.exit(1);
  }
  db._auth = hashPin(process.env.ADMIN_PIN); flush();
}
if (db.settings && db.settings.praxis) delete db.settings.praxis.pin;

const sessions = new Map();
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
function isAdmin(req) {
  const t = cookies(req).wao_admin; const s = t && sessions.get(t);
  if (!s || s < Date.now()) { if (t) sessions.delete(t); return false; }
  return true;
}
function patientId(req) {
  const code = String(req.headers['x-patient-code'] || '').toUpperCase();
  if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(code)) return null;
  const hit = Object.entries(coll('patients')).find(([, p]) => p.code === code);
  return hit ? hit[0] : null;
}

/* einfache Bremse gegen Durchprobieren von PIN und Codes */
const hits = new Map();
function limited(req, key, max) {
  const k = key + '|' + (req.socket.remoteAddress || ''); const now = Date.now();
  const e = hits.get(k) || { n: 0, t: now };
  if (now - e.t > 15 * 60 * 1000) { e.n = 0; e.t = now; }
  e.n++; hits.set(k, e);
  return e.n > max;
}

/* ---------- Leserechte ---------- */
function visible(ctx, c, id, d, filters) {
  if (d === undefined) return undefined;
  if (c === 'settings') { const o = clone(d); delete o.pin; return o; }
  if (ctx.admin) return d;
  switch (c) {
    case 'exercises': return d;
    case 'appointments':
      if (ctx.pid && d.patientId === ctx.pid) return d;
      return { date: d.date, time: d.time, status: d.status, duration: d.duration };
    case 'patients':
      if (ctx.pid && id === ctx.pid) return d;
      if (filters.some(([f, op, v]) => f === 'code' && op === '==' && v === d.code)) return d;
      return undefined;
    case 'exlog': return ctx.pid && d.patientId === ctx.pid ? d : undefined;
    default: return undefined;
  }
}

function runQuery(ctx, c, filters, order, limit) {
  let rows = Object.entries(coll(c)).map(([id, d]) => ({ id, d }));
  for (const [f, op, v] of filters) {
    rows = rows.filter(({ d }) => {
      const x = getPath(d, f);
      switch (op) {
        case '==': return x === v; case '!=': return x !== v;
        case '<': return x < v; case '<=': return x <= v; case '>': return x > v; case '>=': return x >= v;
        case 'in': return Array.isArray(v) && v.includes(x);
        case 'array-contains': return Array.isArray(x) && x.includes(v);
        default: return false;
      }
    });
  }
  rows = rows.map(({ id, d }) => ({ id, d: visible(ctx, c, id, d, filters) })).filter(r => r.d !== undefined);
  if (order.length) rows.sort((a, b) => { for (const [f, dir] of order) { const r = cmp(getPath(a.d, f), getPath(b.d, f)); if (r) return dir === 'desc' ? -r : r; } return 0; });
  if (limit != null) rows = rows.slice(0, +limit);
  return rows.map(({ id, d }) => ({ id, data: d }));
}

/* ---------- Schreibrechte ---------- */
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
function hoursUntil(a) { return (new Date(a.date + 'T' + (a.time || '00:00') + ':00').getTime() - Date.now()) / 3600000; }

function write(ctx, op, c, id, data, merge) {
  const cur = coll(c)[id];
  if (ctx.admin) {
    if (c === 'settings' && data) delete data.pin;
    if (op === 'delete') { delete coll(c)[id]; return; }
    if (op === 'set') { coll(c)[id] = merge ? { ...(cur || {}), ...data } : data; return; }
    if (op === 'update') { if (!cur) throw httpErr(404, 'not-found'); Object.entries(data).forEach(([k, v]) => setPath(cur, k, v)); return; }
  }
  /* Patient oder öffentlich */
  if (op === 'set' && c === 'patients' && !cur) {
    const p = pick(data, ['name', 'contact', 'contactKey', 'code']);
    if (!p.name || !/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(p.code || '')) throw httpErr(400, 'invalid');
    if (Object.values(coll('patients')).some(x => x.code === p.code)) throw httpErr(409, 'code-taken');
    coll(c)[id] = { ...p, befund: '', verlauf: '', notizen: '', geburtsdatum: '', assigned: [], createdAt: Date.now() };
    return;
  }
  if (op === 'set' && c === 'appointments' && !cur) {
    if (!coll('patients')[data.patientId]) throw httpErr(400, 'invalid');
    const a = pick(data, ['patientId', 'name', 'contact', 'date', 'time', 'duration', 'type', 'note', 'agb']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date || '') || !/^\d{2}:\d{2}$/.test(a.time || '')) throw httpErr(400, 'invalid');
    if (Object.values(coll('appointments')).some(x => x.date === a.date && x.time === a.time && x.status !== 'abgesagt')) throw httpErr(409, 'slot-taken');
    coll(c)[id] = { ...a, status: 'angefragt', createdAt: Date.now() };
    return;
  }
  if (op === 'update' && c === 'appointments' && cur && ctx.pid && cur.patientId === ctx.pid && data.status === 'abgesagt') {
    const s = (coll('settings').praxis || {});
    Object.assign(cur, { status: 'abgesagt', cancelledBy: 'patient', cancelReason: String(data.cancelReason || '').slice(0, 1000),
      cancelledAt: Date.now(), cancelSeen: false, lateCancel: hoursUntil(cur) < (+s.cancelHours || 24) });
    return;
  }
  if (op === 'set' && c === 'exlog' && ctx.pid && id === ctx.pid + '_' + data.date && data.patientId === ctx.pid) {
    coll(c)[id] = { patientId: ctx.pid, date: String(data.date), done: data.done && typeof data.done === 'object' ? data.done : {}, updatedAt: Date.now() };
    return;
  }
  throw httpErr(403, 'permission-denied');
}

/* ---------- HTTP ---------- */
const httpErr = (status, code) => Object.assign(new Error(code), { status, code });
function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}), ...headers });
  res.end(buf);
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { reject(httpErr(413, 'too-large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const secure = req => req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;

async function api(req, res, url) {
  const ctx = { admin: isAdmin(req), pid: null };
  ctx.pid = ctx.admin ? null : patientId(req);

  if (url.pathname === '/api/version' && req.method === 'GET') return send(res, 200, { v: version, admin: ctx.admin });

  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (limited(req, 'login', 10)) throw httpErr(429, 'too-many');
    const { pin } = JSON.parse((await readBody(req, 4096)).toString() || '{}');
    if (!checkPin(String(pin || ''))) return send(res, 401, { ok: false });
    const t = crypto.randomBytes(32).toString('hex'); sessions.set(t, Date.now() + SESSION_MS);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `wao_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure(req) ? '; Secure' : ''}` });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    sessions.delete(cookies(req).wao_admin);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'wao_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (url.pathname === '/api/pin' && req.method === 'POST') {
    if (!ctx.admin) throw httpErr(403, 'permission-denied');
    const { pin } = JSON.parse((await readBody(req, 4096)).toString() || '{}');
    if (String(pin || '').length < 4) throw httpErr(400, 'invalid');
    db._auth = hashPin(String(pin)); changed();
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/db' && req.method === 'POST') {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) throw httpErr(415, 'json-only');
    const q = JSON.parse((await readBody(req, MAX_JSON)).toString());
    const c = String(q.coll || ''); if (!NAME.test(c) || c.startsWith('_')) throw httpErr(400, 'invalid');
    const filters = Array.isArray(q.filters) ? q.filters.filter(f => Array.isArray(f) && typeof f[0] === 'string') : [];
    if (q.op === 'query') {
      if (c === 'patients' && !ctx.admin && filters.some(f => f[0] === 'code') && limited(req, 'code', 60)) throw httpErr(429, 'too-many');
      return send(res, 200, { docs: runQuery(ctx, c, filters, Array.isArray(q.order) ? q.order : [], q.limit) });
    }
    const id = String(q.id || ''); if (!NAME.test(id)) throw httpErr(400, 'invalid');
    if (q.op === 'get') return send(res, 200, { doc: visible(ctx, c, id, coll(c)[id], []) ?? null });
    if (['set', 'update', 'delete'].includes(q.op)) {
      if (q.op !== 'delete' && (typeof q.data !== 'object' || q.data === null)) throw httpErr(400, 'invalid');
      write(ctx, q.op, c, id, clone(q.data), !!q.merge);
      changed();
      return send(res, 200, { ok: true });
    }
    throw httpErr(400, 'invalid');
  }

  if (url.pathname === '/api/assets' && req.method === 'POST') {
    if (!ctx.admin) throw httpErr(403, 'permission-denied');
    const type = String(req.headers['content-type'] || '').split(';')[0];
    if (!ASSET_TYPES.test(type)) throw httpErr(415, 'type');
    const body = await readBody(req, MAX_ASSET);
    const id = newId();
    fs.writeFileSync(path.join(ASSETS, id), body);
    fs.writeFileSync(path.join(ASSETS, id + '.json'), JSON.stringify({ type, size: body.length, at: Date.now() }));
    return send(res, 200, { id, url: '/api/assets/' + id });
  }
  const m = url.pathname.match(/^\/api\/assets\/([a-f0-9]{20})$/);
  if (m) {
    const id = m[1], file = path.join(ASSETS, id);
    if (req.method === 'DELETE') {
      if (!ctx.admin) throw httpErr(403, 'permission-denied');
      fs.rmSync(file, { force: true }); fs.rmSync(file + '.json', { force: true });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const pub = Object.values(coll('exercises')).some(e => e.assetId === id);
      if (!pub && !ctx.admin) throw httpErr(403, 'permission-denied');
      let meta; try { meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8')); } catch (e) { throw httpErr(404, 'not-found'); }
      return streamFile(req, res, file, meta.type, { 'Content-Security-Policy': 'sandbox', 'Cache-Control': pub ? 'public, max-age=86400' : 'private, no-store' });
    }
  }
  throw httpErr(404, 'not-found');
}

/* Dateien mit Range-Unterstützung (für Videos auf dem iPhone nötig) */
function streamFile(req, res, file, type, extra = {}) {
  const size = fs.statSync(file).size;
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...extra };
  if (r && (r[1] || r[2])) {
    let start = r[1] ? +r[1] : size - +r[2], end = r[1] && r[2] ? Math.min(+r[2], size - 1) : size - 1;
    if (start < 0) start = 0;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = PUBLIC_FILES[url.pathname];
    if (f && (req.method === 'GET' || req.method === 'HEAD')) {
      const type = f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      return streamFile(req, res, path.join(__dirname, f), type, { 'Cache-Control': 'no-cache', 'Referrer-Policy': 'same-origin' });
    }
    send(res, 404, 'Nicht gefunden', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.code || 'error' });
  }
}).listen(PORT, () => console.log(`WAO Server läuft auf http://localhost:${PORT}  (Daten: ${DATA})`));
