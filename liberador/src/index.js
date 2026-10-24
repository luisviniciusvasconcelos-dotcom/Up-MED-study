/**
 * Liberador Up-MED
 * Recebe os webhooks da Kiwify e libera, renova ou corta o acesso na Up-MED study
 * escrevendo em access/{uid} no Realtime Database — o mesmo registro que o painel
 * "Liberar acessos" já usa: { until, by, at, blocked? }.
 *
 * Fluxo
 *  1. Kiwify faz POST em /kiwify?signature=<hmac-sha1>.
 *  2. A assinatura é conferida com o token do webhook (HMAC-SHA1 do corpo cru).
 *  3. O e-mail do comprador é procurado em members/*.email.
 *     - Achou: grava access/{uid}.
 *     - Não achou (comprou antes de criar a conta): guarda em kiwify/pending/{email}
 *       e o agendamento a cada 15 min libera assim que a conta aparecer.
 *  4. Todo evento fica registrado em kiwify/log para conferência.
 *
 * Segredos (wrangler secret put):
 *  KIWIFY_TOKEN          token do webhook na Kiwify
 *  FIREBASE_SA           JSON da conta de serviço do Firebase (inteiro, numa linha)
 * Variáveis (wrangler.toml):
 *  DATABASE_URL          https://<projeto>-default-rtdb.firebaseio.com
 *  DIAS_PADRAO           dias de acesso quando a Kiwify não informa o fim do período (183)
 *  DIAS_TOLERANCIA       dias extras depois do vencimento, para o aluno não perder acesso na véspera da cobrança (3)
 */

const DAY = 86400000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, servico: 'liberador-upmed' });
    }
    if (req.method !== 'POST' || url.pathname !== '/kiwify') {
      return json({ erro: 'rota inexistente' }, 404);
    }

    const raw = await req.text();
    const sig = url.searchParams.get('signature') || '';
    if (!env.KIWIFY_TOKEN || !(await validSignature(raw, sig, env.KIWIFY_TOKEN))) {
      return json({ erro: 'assinatura inválida' }, 401);
    }

    let ev;
    try { ev = JSON.parse(raw); } catch { return json({ erro: 'json inválido' }, 400); }

    const db = await Db.open(env);
    const res = await handleEvent(ev, db, env, Date.now());
    return json(res);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const db = await Db.open(env);
      await reconcilePending(db, Date.now());
    })());
  }
};

/* ---------------- regras de negócio ---------------- */

export async function handleEvent(ev, db, env, now) {
  const type = ev.webhook_event_type || '';
  const email = normEmail(pick(ev, ['Customer.email', 'customer.email', 'email']));
  const orderId = ev.order_id || '';
  const dedupeKey = fbKey(`${orderId}_${type}`);

  if (!email) return log(db, now, { type, orderId, resultado: 'sem e-mail no evento' });
  if (orderId && await db.get(`kiwify/done/${dedupeKey}`)) {
    return { ok: true, resultado: 'repetido, ignorado' };
  }

  const tol = num(env.DIAS_TOLERANCIA, 3) * DAY;
  const accessUntil = parseKiwifyDate(
    pick(ev, ['Subscription.customer_access.access_until', 'customer_access.access_until', 'Subscription.next_payment'])
  );

  let action = null;
  switch (type) {
    case 'order_approved':
    case 'subscription_renewed': {
      const until = accessUntil ? accessUntil + tol : null;
      action = { kind: 'grant', until, days: num(env.DIAS_PADRAO, 183) };
      break;
    }
    case 'order_refunded':
    case 'chargeback':
      action = { kind: 'revoke' };
      break;
    case 'subscription_canceled':
      // cancelou: mantém até o fim do período pago (a Kiwify informa); reembolso já vem com a data de hoje
      action = accessUntil ? { kind: 'cap', until: accessUntil } : null;
      break;
    default:
      action = null; // pix_created, billet_created, order_rejected, subscription_late: nada a fazer
  }

  if (!action) return log(db, now, { type, email, orderId, resultado: 'evento sem ação' });

  const uid = await findUidByEmail(db, email);
  let resultado;
  if (uid) {
    resultado = await applyAction(db, uid, action, now);
  } else if (action.kind === 'grant') {
    await db.set(`kiwify/pending/${fbKey(email)}`, { email, action, orderId, at: now });
    resultado = 'conta ainda não existe: liberação guardada para quando ela for criada';
  } else {
    await db.del(`kiwify/pending/${fbKey(email)}`);
    resultado = 'conta não existe: liberação pendente removida';
  }

  if (orderId) await db.set(`kiwify/done/${dedupeKey}`, now);
  return log(db, now, { type, email, orderId, uid: uid || null, resultado });
}

export async function applyAction(db, uid, action, now) {
  const cur = (await db.get(`access/${uid}`)) || {};
  const curUntil = cur.until || 0;
  let until;
  if (action.kind === 'grant') {
    // nunca encurta um acesso maior que o administrador já tenha dado
    const base = Math.max(now, curUntil);
    until = action.until ? Math.max(action.until, curUntil) : base + action.days * DAY;
    await db.set(`access/${uid}`, { until, by: 'kiwify', at: now });
    return `acesso liberado até ${iso(until)}`;
  }
  if (action.kind === 'revoke') {
    await db.set(`access/${uid}`, { until: now, by: 'kiwify', at: now, blocked: true });
    return 'acesso encerrado (reembolso/chargeback)';
  }
  if (action.kind === 'cap') {
    until = Math.min(curUntil || action.until, action.until);
    await db.set(`access/${uid}`, { until, by: 'kiwify', at: now });
    return `assinatura cancelada: acesso vale até ${iso(until)}`;
  }
  return 'nada feito';
}

export async function reconcilePending(db, now) {
  const pend = (await db.get('kiwify/pending')) || {};
  const keys = Object.keys(pend);
  if (!keys.length) return 0;
  const members = (await db.get('members')) || {};
  let n = 0;
  for (const k of keys) {
    const p = pend[k];
    const uid = uidFromMembers(members, p.email);
    if (!uid) continue;
    const r = await applyAction(db, uid, p.action, now);
    await db.del(`kiwify/pending/${k}`);
    await log(db, now, { type: 'pendente_liberado', email: p.email, orderId: p.orderId, uid, resultado: r });
    n++;
  }
  return n;
}

async function findUidByEmail(db, email) {
  const members = (await db.get('members')) || {};
  return uidFromMembers(members, email);
}
function uidFromMembers(members, email) {
  for (const [uid, m] of Object.entries(members)) {
    if (m && normEmail(m.email) === email) return uid;
  }
  return null;
}

async function log(db, now, entry) {
  await db.push('kiwify/log', { ...entry, at: now });
  return { ok: true, ...entry };
}

/* ---------------- Kiwify: assinatura ---------------- */

export async function validSignature(raw, sig, token) {
  if (!/^[0-9a-f]{40}$/.test(sig)) return false;
  const key = await crypto.subtle.importKey('raw', enc(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, enc(raw)));
  let diff = 0;
  for (let i = 0; i < 40; i++) diff |= mac.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/* ---------------- Firebase Realtime Database (REST + conta de serviço) ---------------- */

export const Db = {
  async open(env) {
    const token = await googleToken(JSON.parse(env.FIREBASE_SA));
    const base = env.DATABASE_URL.replace(/\/$/, '');
    const call = async (method, path, body) => {
      const r = await fetch(`${base}/${path}.json`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!r.ok) throw new Error(`Firebase ${method} ${path}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    return {
      get: (p) => call('GET', p),
      set: (p, v) => call('PUT', p, v),
      push: (p, v) => call('POST', p, v),
      del: (p) => call('DELETE', p)
    };
  }
};

async function googleToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(`${header}.${claim}`));
  const jwt = `${header}.${claim}.${b64url(sig)}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`
  });
  if (!r.ok) throw new Error(`Google token: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

/* ---------------- utilidades ---------------- */

const enc = (s) => new TextEncoder().encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function b64url(x) {
  const bytes = typeof x === 'string' ? enc(x) : new Uint8Array(x);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function normEmail(e) { return (e || '').toString().trim().toLowerCase(); }
export function fbKey(s) { return s.replace(/[.#$\[\]\/]/g, ','); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }
function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
export function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v != null && v !== '') return v;
  }
  return null;
}
/** Datas da Kiwify: "YYYY-MM-DD HH:mm" (Brasília) na raiz, ISO/UTC dentro de Subscription. */
export function parseKiwifyDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T') + (s.length === 10 ? 'T23:59:00' : '') + '-03:00');
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
