/* ZUI KONTRAKTOR – Worker pembayaran langganan lewat iPaymu (Cloudflare Workers).
   Salin seluruh isi file ini ke editor Worker di dashboard Cloudflare. Panduan: worker/PANDUAN-IPAYMU.md

   Yang dikerjakan Worker ini:
   - POST /create  : pelanggan (pemilik/admin perusahaan) membuat transaksi iPaymu. Harga dihitung di sini dari Firestore.
   - POST /notify  : callback iPaymu. Status selalu dicek ulang ke iPaymu sebelum paket diaktifkan.
   - GET  /return/ : halaman kembali dari iPaymu. Cek status, lalu kembali ke aplikasi.
   - POST /check   : aplikasi meminta cek ulang status sebuah pembayaran.

   Secret (Settings → Variables and Secrets, tipe Secret):
     IPAYMU_VA        nomor VA iPaymu
     IPAYMU_KEY       API Key iPaymu
     FIREBASE_SA      isi lengkap file JSON kunci service account Firebase
   Variabel (tipe Text):
     IPAYMU_MODE      sandbox | live            (bawaan sandbox)
     APP_URL          https://kontraktor.zuisystem.com/
     TEST_EMAILS      di mode sandbox hanya email ini yang boleh membayar (pisahkan dengan koma)
     ADMIN_EMAILS     akun admin langganan (bawaan admin.zuisystem@gmail.com)
*/

const DEF_PRICES = { starter: { 1: 79000, 6: 395000, 12: 790000 }, pro: { 1: 149000, 6: 745000, 12: 1490000 }, business: { 1: 299000, 6: 1495000, 12: 2990000 } };
const PLAN_NAME = { starter: 'Starter', pro: 'Pro', business: 'Bisnis' };
const MONTHS = [1, 6, 12];
const REUSE_MS = 30 * 60 * 1000; // tautan bayar yang belum dibayar dipakai ulang selama 30 menit

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/' && req.method === 'GET') return text('ZUI bayar aktif · mode ' + mode(env));
      if (url.pathname === '/create' && req.method === 'POST') return json(await create(req, env), 200, cors);
      if (url.pathname === '/check' && req.method === 'POST') return json(await check(req, env), 200, cors);
      if (url.pathname === '/notify' && req.method === 'POST') return await notify(req, env);
      if (url.pathname.startsWith('/return/') && req.method === 'GET') return await back(url, env);
      return text('Not found', 404);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e && e.stack || e);
      return json({ error: e.status ? e.message : 'Terjadi kesalahan di server pembayaran.' }, status, cors);
    }
  }
};

/* ---------- endpoint ---------- */

async function create(req, env) {
  const user = await authUser(req, env);
  const body = await req.json().catch(() => ({}));
  const cid = String(body.cid || ''), plan = String(body.plan || ''), months = Number(body.months);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cid) || !DEF_PRICES[plan] || !MONTHS.includes(months)) throw err(400, 'Data paket tidak valid.');
  if (mode(env) !== 'live' && !list(env.TEST_EMAILS).includes(user.email)) throw err(403, 'Pembayaran online sedang diuji coba. Hubungi admin ZUI lewat chat di halaman Langganan.');

  const [member, company, payCfg] = await Promise.all([
    fsGet(env, `companies/${cid}/members/${user.uid}`),
    fsGet(env, `companies/${cid}`),
    fsGet(env, 'zconfig/pay')
  ]);
  if (!company) throw err(404, 'Perusahaan tidak ditemukan.');
  if (!member || !['owner', 'admin'].includes(member.data.role)) throw err(403, 'Hanya pemilik atau admin perusahaan yang bisa membayar langganan.');
  if (company.data.free) throw err(400, 'Perusahaan ini sudah gratis selamanya.');

  const prices = (payCfg && payCfg.data.prices) || {};
  const amount = Math.round(Number((prices[plan] || {})[months]) || DEF_PRICES[plan][months]);
  if (!(amount >= 1000)) throw err(400, 'Harga paket belum diatur.');

  // Pakai ulang tautan yang baru dibuat untuk paket yang sama, supaya tidak ada tagihan ganda.
  const now = Date.now();
  const mine = await fsQuery(env, 'subreqs', 'cid', cid);
  const open = mine.find(d => d.data.method === 'ipaymu' && d.data.status === 'pay' && d.data.mode === mode(env) && d.data.plan === plan &&
    d.data.months === months && d.data.amount === amount && d.data.url && now - ms(d.data.at) < REUSE_MS);
  if (open) return { id: open.id, url: open.data.url };

  const id = randomId();
  const coName = String(company.data.name || body.coName || 'Perusahaan').slice(0, 120);
  const self = new URL(req.url).origin;
  const product = `ZUI Kontraktor ${PLAN_NAME[plan]} ${months} bulan`;
  const pay = {
    product: [product], qty: ['1'], price: [String(amount)],
    description: [coName],
    referenceId: id,
    returnUrl: `${self}/return/${id}`,
    cancelUrl: `${self}/return/${id}?batal=1`,
    notifyUrl: `${self}/notify`,
    buyerName: coName.slice(0, 60),
    buyerEmail: user.email
  };
  const phone = String(body.phone || '').replace(/[^\d]/g, '');
  if (phone.length >= 8) pay.buyerPhone = phone.slice(0, 16);

  const r = await ipaymu(env, '/api/v2/payment', pay);
  const sid = r.Data && r.Data.SessionID, link = r.Data && r.Data.Url;
  if (!link) throw err(502, 'iPaymu menolak permintaan: ' + (r.Message || 'tanpa keterangan'));

  const doc = {
    cid, coName, plan, months, amount, cur: 'IDR', method: 'ipaymu', mode: mode(env), status: 'pay',
    by: user.uid, byEmail: user.email, at: new Date(now), sid: String(sid || ''), url: link, ref: ''
  };
  doc.sig = await sign(env, id, doc);
  await fsCommit(env, [{ update: { name: docName(env, `subreqs/${id}`), fields: toFields(doc) }, currentDocument: { exists: false } }]);
  return { id, url: link };
}

async function check(req, env) {
  const user = await authUser(req, env);
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || '');
  if (!/^[A-Za-z0-9]{20,40}$/.test(id)) throw err(400, 'Nomor pembayaran tidak valid.');
  const d = await fsGet(env, `subreqs/${id}`);
  if (!d || d.data.method !== 'ipaymu') throw err(404, 'Pembayaran tidak ditemukan.');
  if (!list(env.ADMIN_EMAILS || 'admin.zuisystem@gmail.com').includes(user.email)) {
    const m = await fsGet(env, `companies/${d.data.cid}/members/${user.uid}`);
    if (!m) throw err(403, 'Bukan anggota perusahaan ini.');
  }
  return await settle(env, id, String(body.trx || ''));
}

async function notify(req, env) {
  // iPaymu mengirim form-urlencoded; JSON juga diterima. Isinya tidak dipercaya: status dicek ulang ke iPaymu.
  let p = {};
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('json')) p = await req.json().catch(() => ({}));
  else { const f = await req.formData().catch(() => null); if (f) for (const [k, v] of f) p[k] = String(v); }
  const id = String(p.reference_id || p.referenceId || '');
  if (!/^[A-Za-z0-9]{20,40}$/.test(id)) return text('ignored');
  const r = await settle(env, id, String(p.trx_id || p.transactionId || ''));
  return text(r.status === 'none' ? 'ignored' : 'OK');
}

async function back(url, env) {
  const id = url.pathname.split('/')[2] || '';
  const app = new URL(env.APP_URL || 'https://kontraktor.zuisystem.com/');
  if (/^[A-Za-z0-9]{20,40}$/.test(id)) {
    // iPaymu menambahkan trx_id ke alamat kembali. Kalau formatnya aneh, ambil dari teks alamatnya.
    const trx = url.searchParams.get('trx_id') || (url.search.match(/trx_id=([0-9]+)/) || [])[1] || '';
    try { await settle(env, id, trx); } catch (e) { console.error(e && e.stack || e); }
    app.searchParams.set('bayar', id);
  }
  app.hash = 'langganan';
  return Response.redirect(app.toString(), 302);
}

/* ---------- cek ke iPaymu lalu aktifkan paket (aman dipanggil berkali-kali) ---------- */

async function settle(env, id, trx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = await fsGet(env, `subreqs/${id}`);
    if (!d || d.data.method !== 'ipaymu') return { status: 'none' };
    const x = d.data;
    if (x.status !== 'pay') return { status: x.status, plan: x.plan, until: x.until ? ms(x.until) : 0 };
    if (x.sig !== await sign(env, id, x)) { console.error('tanda tangan subreqs tidak cocok', id); return { status: 'none' }; }
    if (x.mode !== mode(env)) return { status: 'pay' };
    trx = trx || x.trx || '';
    if (!/^[0-9]{1,20}$/.test(trx)) return { status: 'pay' };

    const r = await ipaymu(env, '/api/v2/transaction', { transactionId: Number(trx) });
    const t = r.Data || {};
    if (String(t.ReferenceId || '') !== id) return { status: 'pay' };
    const st = Number(t.Status), paid = st === 1 || st === 6, gone = st === -2 || st === 2;
    if (!paid && !gone) {
      if (!x.trx) await fsCommit(env, [{ update: { name: d.name, fields: toFields({ trx }) }, updateMask: { fieldPaths: ['trx'] }, currentDocument: { updateTime: d.updateTime } }]).catch(() => {});
      return { status: 'pay' };
    }
    if (gone) {
      const ok = await fsCommit(env, [{ update: { name: d.name, fields: toFields({ status: 'exp', trx, doneAt: new Date() }) }, updateMask: { fieldPaths: ['status', 'trx', 'doneAt'] }, currentDocument: { updateTime: d.updateTime } }]).then(() => true, e => { if (e.conflict) return false; throw e; });
      if (ok) return { status: 'exp' };
      continue;
    }
    if (Number(t.Amount) + 0.5 < x.amount) { console.error('jumlah bayar kurang', id, t.Amount, x.amount); return { status: 'pay' }; }

    // Lunas: tambahkan masa aktif dari tanggal berakhir sekarang (atau dari hari ini kalau sudah lewat).
    const c = await fsGet(env, `companies/${x.cid}`);
    if (!c) return { status: 'pay' };
    const base = Math.max(Date.now(), c.data.until ? ms(c.data.until) : 0);
    const until = new Date(addMonths(base, x.months));
    const writes = [
      { update: { name: d.name, fields: toFields({ status: 'ok', trx, ref: 'iPaymu ' + trx, via: String(t.PaymentChannel || t.Via || t.TypeDesc || ''), paid: Number(t.Amount) || x.amount, until, doneAt: new Date() }) },
        updateMask: { fieldPaths: ['status', 'trx', 'ref', 'via', 'paid', 'until', 'doneAt'] }, currentDocument: { updateTime: d.updateTime } },
      { update: { name: c.name, fields: toFields({ plan: x.plan, until }) }, updateMask: { fieldPaths: ['plan', 'until'] }, currentDocument: { updateTime: c.updateTime } }
    ];
    const ok = await fsCommit(env, writes).then(() => true, e => { if (e.conflict) return false; throw e; });
    if (ok) return { status: 'ok', plan: x.plan, until: until.getTime() };
    // Dokumen berubah di tengah jalan (mis. callback datang bersamaan). Ulangi dari awal.
  }
  return { status: 'pay' };
}

/* ---------- iPaymu ---------- */

async function ipaymu(env, path, body) {
  if (!env.IPAYMU_VA || !env.IPAYMU_KEY) throw err(500, 'IPAYMU_VA / IPAYMU_KEY belum diisi.');
  const va = String(env.IPAYMU_VA).trim(), key = String(env.IPAYMU_KEY).trim();
  const raw = JSON.stringify(body);
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', enc(raw)));
  const signature = await hmacHex(key, `POST:${va}:${bodyHash}:${key}`);
  const base = mode(env) === 'live' ? 'https://my.ipaymu.com' : 'https://sandbox.ipaymu.com';
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', va, signature, timestamp: jakartaStamp() },
    body: raw
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || (out.Status && Number(out.Status) !== 200)) {
    console.error('iPaymu', path, res.status, JSON.stringify(out).slice(0, 500));
    throw err(502, 'iPaymu: ' + (out.Message || ('HTTP ' + res.status)));
  }
  return out;
}

function jakartaStamp() {
  const d = new Date(Date.now() + 7 * 3600 * 1000), p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/* ---------- login Firebase pelanggan (ID token) ---------- */

let JWKS = null, JWKS_AT = 0;
async function authUser(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer (.+)$/);
  if (!m) throw err(401, 'Silakan masuk ulang.');
  const [h64, p64, s64] = m[1].split('.');
  let head, pay;
  try { head = JSON.parse(dec(b64u(h64))); pay = JSON.parse(dec(b64u(p64))); } catch (e) { throw err(401, 'Silakan masuk ulang.'); }
  const project = sa(env).project_id, now = Date.now() / 1000;
  if (head.alg !== 'RS256' || pay.aud !== project || pay.iss !== 'https://securetoken.google.com/' + project || !pay.sub || pay.exp < now || pay.iat > now + 300) throw err(401, 'Sesi login habis. Silakan masuk ulang.');
  if (!JWKS || Date.now() - JWKS_AT > 3600e3) {
    const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    JWKS = (await r.json()).keys || []; JWKS_AT = Date.now();
  }
  const jwk = JWKS.find(k => k.kid === head.kid);
  if (!jwk) { JWKS = null; throw err(401, 'Sesi login habis. Silakan masuk ulang.'); }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s64), enc(h64 + '.' + p64));
  if (!ok) throw err(401, 'Silakan masuk ulang.');
  return { uid: pay.sub, email: String(pay.email || '').toLowerCase() };
}

/* ---------- Firestore REST dengan service account ---------- */

let SA = null, TOKEN = null, TOKEN_EXP = 0;
function sa(env) {
  if (!SA) { try { SA = JSON.parse(env.FIREBASE_SA); } catch (e) { throw err(500, 'FIREBASE_SA belum diisi atau bukan JSON.'); } }
  return SA;
}
async function gToken(env) {
  if (TOKEN && Date.now() < TOKEN_EXP - 60e3) return TOKEN;
  const s = sa(env), now = Math.floor(Date.now() / 1000);
  const h = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const c = b64uStr(JSON.stringify({ iss: s.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = s.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), ch => ch.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64uBytes(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(h + '.' + c)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + h + '.' + c + '.' + sig
  });
  const t = await r.json();
  if (!t.access_token) throw err(500, 'Service account ditolak Google: ' + (t.error_description || t.error || r.status));
  TOKEN = t.access_token; TOKEN_EXP = Date.now() + (t.expires_in || 3600) * 1000;
  return TOKEN;
}
const docName = (env, path) => `projects/${sa(env).project_id}/databases/(default)/documents/${path}`;
async function fs(env, path, init) {
  const r = await fetch('https://firestore.googleapis.com/v1/' + path, Object.assign({}, init, { headers: { Authorization: 'Bearer ' + await gToken(env), 'Content-Type': 'application/json' } }));
  if (r.status === 404 && (!init || !init.method)) return null;
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(err(500, 'Firestore: ' + ((out.error && out.error.message) || r.status)),
      { conflict: ['FAILED_PRECONDITION', 'ABORTED', 'ALREADY_EXISTS'].includes(out.error && out.error.status) });
  }
  return out;
}
async function fsGet(env, path) {
  const d = await fs(env, docName(env, path));
  return d ? { id: path.split('/').pop(), name: d.name, updateTime: d.updateTime, data: fromFields(d.fields || {}) } : null;
}
async function fsQuery(env, coll, field, value) {
  const out = await fs(env, docName(env, '').replace(/\/$/, '') + ':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toValue(value) } }, limit: 200 } }) });
  return (out || []).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), name: x.document.name, updateTime: x.document.updateTime, data: fromFields(x.document.fields || {}) }));
}
const fsCommit = (env, writes) => fs(env, docName(env, '').replace(/\/$/, '') + ':commit', { method: 'POST', body: JSON.stringify({ writes }) });

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: toFields(v) } };
}
function toFields(o) { const f = {}; for (const k in o) f[k] = toValue(o[k]); return f; }
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return { _ts: v.timestampValue };
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  return null;
}
function fromFields(f) { const o = {}; for (const k in f) o[k] = fromValue(f[k]); return o; }
const ms = v => v && v._ts ? Date.parse(v._ts) : (Number(v) || 0);

/* ---------- bantuan ---------- */

const mode = env => String(env.IPAYMU_MODE || 'sandbox').trim().toLowerCase() === 'live' ? 'live' : 'sandbox';
const list = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64uBytes = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = s => b64uBytes(enc(s));
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc(msg)));
}
// Tanda tangan isi pesanan, supaya plan/bulan/jumlah tidak bisa diubah dari aplikasi setelah dibuat.
const sign = (env, id, x) => hmacHex(String(env.IPAYMU_KEY) + '|' + sa(env).private_key_id, [id, x.cid, x.plan, x.months, x.amount, x.mode, x.sid].join('|'));
function randomId() { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', b = crypto.getRandomValues(new Uint8Array(24)); return [...b].map(x => a[x % 62]).join(''); }
function addMonths(t, n) {
  // sama dengan aplikasi: tanggal yang sama n bulan kemudian, dipotong ke akhir bulan bila perlu (zona WIB)
  const off = 7 * 3600e3, d = new Date(t + off), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.getTime() - off;
}
function err(status, message) { return Object.assign(new Error(message), { status, conflict: false }); }
function corsHeaders(req, env) {
  const origin = req.headers.get('origin') || '';
  const allowed = [new URL(env.APP_URL || 'https://kontraktor.zuisystem.com/').origin].concat(list(env.EXTRA_ORIGINS));
  return allowed.includes(origin.toLowerCase()) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : { Vary: 'Origin' };
}
const json = (o, status, headers) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });
const text = (s, status) => new Response(s, { status: status || 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
