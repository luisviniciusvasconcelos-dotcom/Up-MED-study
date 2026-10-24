# Liberador Up-MED

Pagou na Kiwify, o acesso abre sozinho na Up-MED study. Renovou, estende. Cancelou, vale até o fim do período pago. Pediu reembolso ou deu chargeback, fecha na hora.

Roda grátis no Cloudflare Workers e escreve no mesmo `access/{uid}` que o painel "Liberar acessos" já usa. Você continua podendo liberar e bloquear à mão; o liberador nunca encurta um acesso maior que você tenha dado.

## Instalação (uma vez, uns 20 minutos)

Precisa de Node.js instalado no computador.

1. **Conta de serviço só para o banco.** No Google Cloud Console (mesmo projeto do Firebase) → IAM e administrador → Contas de serviço → Criar conta de serviço. Nome: `upmed-banco`. Papel: **Firebase Realtime Database Admin** (só esse). Depois, na conta criada → Chaves → Adicionar chave → JSON. Esse arquivo dá acesso total ao banco: nunca o coloque no GitHub, no chat ou em pasta pública. Use o mesmo arquivo no liberador e no segredo `FIREBASE_SA` do GitHub.
2. **Cloudflare.** Crie conta grátis em dash.cloudflare.com (não pede cartão).
3. No terminal, dentro desta pasta:
   ```
   npm install -g wrangler
   wrangler login
   wrangler secret put FIREBASE_SA     # cole o conteúdo inteiro do .json numa linha
   wrangler secret put KIWIFY_TOKEN    # cole o token do passo 5 (pode voltar aqui depois)
   wrangler deploy
   ```
   O deploy mostra o endereço, algo como `https://liberador-upmed.SEU-USUARIO.workers.dev`.
4. Abra esse endereço no navegador. Deve aparecer `{"ok":true,...}`.
5. **Kiwify.** Apps → Webhooks → Criar webhook.
   - URL: `https://liberador-upmed.SEU-USUARIO.workers.dev/kiwify`
   - Produto: Up-MED study
   - Eventos: Compra aprovada, Compra reembolsada, Chargeback, Assinatura renovada, Assinatura cancelada
   - Copie o token gerado e rode `wrangler secret put KIWIFY_TOKEN` com ele.
6. **Teste.** Na Kiwify, *Testar webhook* com o e-mail de uma conta sua da Up-MED. Em segundos o painel Acessos mostra o vencimento novo, e o Firebase ganha uma linha em `kiwify/log`.

## Regras do banco

O liberador usa a conta de serviço, que ignora as regras de segurança. Não precisa mudar nada nelas. Só confira que o nó `kiwify` não é legível por alunos (com as regras atuais, nada fora do que você liberou é legível).

## O que fica registrado

- `kiwify/log` — cada evento recebido e o que foi feito
- `kiwify/pending` — compras de quem ainda não criou conta (liberadas automaticamente em até 15 min depois do cadastro, desde que use o mesmo e-mail da compra)
- `kiwify/done` — controle para não processar o mesmo evento duas vezes

## Testes

`node test/teste.mjs` roda 9 verificações, incluindo o vetor de assinatura oficial da Kiwify.
