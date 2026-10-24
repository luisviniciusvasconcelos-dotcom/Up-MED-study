// Testes do liberador: node test/teste.mjs
import assert from 'node:assert/strict';
import { validSignature, handleEvent, reconcilePending, parseKiwifyDate } from '../src/index.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00-03:00');
const env = { DIAS_PADRAO: '183', DIAS_TOLERANCIA: '3' };

function memDb(seed) {
  const data = structuredClone(seed);
  const parts = (p) => p.split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), data) ?? null;
  const set = (p, v) => { const ks = parts(p); let o = data; ks.slice(0, -1).forEach((k) => (o = o[k] ??= {})); o[ks.at(-1)] = structuredClone(v); };
  const del = (p) => { const ks = parts(p); let o = data; for (const k of ks.slice(0, -1)) { o = o?.[k]; if (!o) return; } delete o[ks.at(-1)]; };
  let n = 0;
  return { data, get: async (p) => get(p), set: async (p, v) => set(p, v), del: async (p) => del(p), push: async (p, v) => set(`${p}/k${n++}`, v) };
}

// 1. vetor de teste oficial da Kiwify
const body = '{"order_id":"9b1c2d3e-0000-4000-8000-000000000001","order_status":"paid","webhook_event_type":"order_approved"}';
assert.equal(await validSignature(body, 'bf18f352a4f981b91dfa3f6d8742a81080ab8c86', 'kiwify-token-de-teste'), true);
assert.equal(await validSignature(body, 'bf18f352a4f981b91dfa3f6d8742a81080ab8c87', 'kiwify-token-de-teste'), false);
assert.equal(await validSignature(body + ' ', 'bf18f352a4f981b91dfa3f6d8742a81080ab8c86', 'kiwify-token-de-teste'), false);
console.log('ok  assinatura HMAC confere com o vetor da Kiwify');

// 2. compra aprovada de quem já tem conta → libera até o fim do período + tolerância
const seed = { members: { u1: { email: 'Ana@Uncisal.edu.br', name: 'Ana' } }, access: {} };
let db = memDb(seed);
const compra = {
  order_id: 'o1', webhook_event_type: 'order_approved', order_status: 'paid',
  Customer: { email: 'ana@uncisal.edu.br ' },
  Subscription: { customer_access: { has_access: true, access_until: '2027-04-24T12:00:00Z' } }
};
let r = await handleEvent(compra, db, env, NOW);
assert.equal(db.data.access.u1.until, Date.parse('2027-04-24T12:00:00Z') + 3 * DAY);
assert.equal(db.data.access.u1.by, 'kiwify');
console.log('ok  compra aprovada libera até', r.resultado);

// 3. mesmo evento repetido é ignorado
r = await handleEvent(compra, db, env, NOW);
assert.equal(r.resultado, 'repetido, ignorado');
console.log('ok  evento duplicado ignorado');

// 4. acesso maior dado pelo administrador não é encurtado
db = memDb({ members: { u1: { email: 'ana@uncisal.edu.br' } }, access: { u1: { until: NOW + 400 * DAY } } });
await handleEvent(compra, db, env, NOW);
assert.equal(db.data.access.u1.until, NOW + 400 * DAY);
console.log('ok  não encurta acesso manual mais longo');

// 5. sem data da Kiwify → 183 dias a partir de hoje
db = memDb(seed);
await handleEvent({ ...compra, order_id: 'o2', Subscription: undefined }, db, env, NOW);
assert.equal(db.data.access.u1.until, NOW + 183 * DAY);
console.log('ok  sem data usa 183 dias');

// 6. reembolso corta o acesso
await handleEvent({ order_id: 'o2', webhook_event_type: 'order_refunded', order_status: 'refunded', Customer: { email: 'ana@uncisal.edu.br' } }, db, env, NOW + DAY);
assert.equal(db.data.access.u1.until, NOW + DAY);
assert.equal(db.data.access.u1.blocked, true);
console.log('ok  reembolso encerra o acesso');

// 7. cancelamento mantém até o fim do período pago
db = memDb({ members: { u1: { email: 'ana@uncisal.edu.br' } }, access: { u1: { until: NOW + 190 * DAY } } });
await handleEvent({ order_id: 'o3', webhook_event_type: 'subscription_canceled', Customer: { email: 'ana@uncisal.edu.br' },
  Subscription: { customer_access: { access_until: new Date(NOW + 180 * DAY).toISOString() } } }, db, env, NOW);
assert.equal(db.data.access.u1.until, NOW + 180 * DAY);
console.log('ok  cancelamento mantém até o fim do período');

// 8. comprou antes de criar conta → fica pendente e é liberado depois
db = memDb({ members: {}, access: {} });
r = await handleEvent({ ...compra, order_id: 'o4', Customer: { email: 'bia@gmail.com' } }, db, env, NOW);
assert.ok(db.data.kiwify.pending['bia@gmail,com']);
db.data.members.u9 = { email: 'bia@gmail.com' };
assert.equal(await reconcilePending(db, NOW + 600000), 1);
assert.ok(db.data.access.u9.until > NOW + 180 * DAY);
assert.equal(Object.keys(db.data.kiwify.pending).length, 0);
console.log('ok  compra antes do cadastro é liberada quando a conta aparece');

// 9. datas no formato de Brasília da raiz do evento
assert.equal(parseKiwifyDate('2027-04-24 10:30'), Date.parse('2027-04-24T10:30:00-03:00'));
console.log('ok  datas da Kiwify convertidas');

console.log('\nTodos os testes passaram.');
