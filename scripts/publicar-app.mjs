// Publica o app (neuro/index.html) no Firebase, em app/neuro, para o portal entregar só a quem tem acesso.
// Uso: FIREBASE_SA='<json da conta de serviço>' DATABASE_URL='https://...firebaseio.com' node scripts/publicar-app.mjs
import { readFileSync } from 'node:fs';
import { createSign, createHash } from 'node:crypto';

const SA = process.env.FIREBASE_SA, DB = (process.env.DATABASE_URL || '').replace(/\/$/, '');
if (!SA || !DB) { console.log('FIREBASE_SA ou DATABASE_URL não configurados; nada publicado.'); process.exit(0); }

const html = readFileSync(new URL('../neuro/index.html', import.meta.url), 'utf8');
const m = html.match(/APP_VERSION='([^']+)'/);
const version = (m ? m[1] : 'sem-versao') + '-' + createHash('sha256').update(html).digest('hex').slice(0, 10);

const sa = JSON.parse(SA);
const b64 = (x) => Buffer.from(x).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64(JSON.stringify({
  iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email'
}));
const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
const tok = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + sig
}).then((r) => r.json());
if (!tok.access_token) { console.error('Falha no token do Google:', tok); process.exit(1); }

// grava o html primeiro e a versão por último: o portal só baixa quando a versão muda
const put = async (path, val) => {
  const r = await fetch(`${DB}/${path}.json`, { method: 'PUT', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(val) });
  if (!r.ok) { console.error(`Falha ao gravar ${path}:`, r.status, await r.text()); process.exit(1); }
};
await put('app/neuro/html', html);
await put('app/neuro/at', Date.now());
await put('app/neuro/version', version);
console.log(`Publicado: versão ${version} (${(html.length / 1024).toFixed(0)} KB)`);
