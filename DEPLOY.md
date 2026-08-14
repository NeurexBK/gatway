# Deploy

A pipeline completa funciona nos dois runtimes. O que muda é **como** o trabalho
periódico é disparado e quanto tempo cada invocação tem.

| | Vercel (serverless) | Host persistente |
|---|---|---|
| `/health`, `/quote`, painel admin | funciona | funciona |
| Webhook registra a ordem | funciona | funciona |
| Swap + liquidação do cliente | funciona (inline, com teto de tempo) | funciona (background) |
| Distribuição de lucro | cron externo, horário em **UTC** | horário/timezone do admin |
| Retomada de ordens | cron externo (`/admin/cron/tick`) | varredura a cada 5 min |
| Banco | Postgres obrigatório | SQLite (dev) ou Postgres |
| Exclusão mútua | lock no banco | lock no banco |

## Como a concorrência é garantida

Isto é o que torna serverless viável, e vale entender antes de confiar:

O saldo de USDC do vault é um pote comum — on-chain não há como saber qual
depósito pertence a qual ordem. Sem exclusão real, duas ordens simultâneas leem
o mesmo saldo, ambas se julgam cobertas, e a segunda gasta o dinheiro da
primeira.

A exclusão vem da tabela `Lock` (`src/services/lock.service.ts`), não de
estruturas em memória:

- **exclusão** pelo PRIMARY KEY: dois `INSERT` concorrentes do mesmo nome — um
  ganha, o outro recebe violação de unicidade. Não existe janela entre
  "verificar" e "criar", que é o furo de qualquer implementação com SELECT+INSERT;
- **lease com expiração**: se o detentor morrer (função que estoura o tempo,
  container derrubado), o lock não fica preso — passado o prazo, outro processo
  rouba, e o roubo é atômico (`UPDATE ... WHERE expiresAt < now`);
- **liberação por dono**: quem já perdeu o lease não libera o lock de quem o
  roubou.

Três locks: `swap:global` (serializa "verificar saldo → swapar"),
`payout:global` (uma distribuição por vez) e `order:<id>` (uma ordem por vez).

Verificado com 3 processos separados disputando a mesma seção crítica: 18
entradas, máximo simultâneo 1, zero violações. `GET /admin/api/locks` mostra os
locks ativos.

`ALLOW_PIPELINE=false` continua disponível como kill switch operacional.

## Duas diferenças reais em serverless

**1. O webhook processa antes de responder.** Não existe background numa função
serverless: depois do `res.end()` ela pode ser congelada ou morta, então
`setImmediate` não garante execução alguma. A pipeline roda inline, com teto de
`SERVERLESS_BUDGET_MS` (default 45s). O provedor espera mais pela resposta; o que
não terminar no prazo fica para o tick do cron. A resposta traz
`processedInline: true` e `elapsedMs`.

**2. A espera pelo depósito é curta.** Em serverless ela é limitada a metade do
orçamento da invocação (em vez dos 180s do default), porque não cabe. Se o
settlement do on-ramp aterrar depois disso, a ordem fica `PENDING` e **só avança
no próximo tick do cron**. Com cron diário, isso significa que um cliente pode
esperar até 24h.

Se você opera de verdade na Vercel, resolva o segundo ponto com um tick
frequente. O endpoint é idempotente e protegido por lock, então pode ser chamado
de minuto em minuto:

- **Vercel Pro:** troque o `schedule` no `vercel.json` para `*/5 * * * *`;
- **plano Hobby** (limite de 2 crons/dia): use um pinger externo — cron-job.org,
  GitHub Actions com `schedule`, ou Upstash QStash — chamando
  `GET https://SEU-APP.vercel.app/admin/cron/tick` com o header
  `Authorization: Bearer $CRON_SECRET`.

---

## Opção A — Render (mais simples)

Processo persistente, Postgres gerenciado, horário do admin funcionando.

`render.yaml` já está no repo — o Render lê o arquivo e provisiona serviço e
banco. Preencha os segredos marcados `sync: false` no painel.

Na primeira subida, gere a migration inicial:

```bash
npm run db:postgres
npx prisma migrate dev --name init
git add -A && git commit -m "chore(db): migration inicial postgres"
```

## Opção B — Docker (VPS, Fly.io, Railway)

```bash
docker build -t solana-fiat-gateway .
docker run -p 3000:3000 --env-file .env solana-fiat-gateway
```

## Opção C — Vercel

1. **Postgres.** SQLite não funciona: disco efêmero. Use Neon, Supabase ou
   Vercel Postgres.

   Serverless abre muitas conexões curtas, então use a **connection string com
   pooler** e limite o pool do Prisma:

   ```
   DATABASE_URL="postgresql://...pooler.../db?pgbouncer=true&connection_limit=1"
   ```

   Para migrations, use a URL **direta** (sem pooler), do seu terminal:

   ```bash
   npm run db:postgres
   DATABASE_URL="postgresql://...direta.../db" npx prisma migrate deploy
   ```

2. **Variáveis de ambiente** no painel (Settings → Environment Variables).
   Faltando qualquer uma, a função responde **503 com a lista exata do que
   falta** em JSON — não um 500 opaco.

3. **`CRON_SECRET`** é obrigatória para o tick funcionar; sem ela o endpoint
   responde 503 e nada é distribuído nem retomado.

4. **Confirme o `maxDuration` do seu plano.** O `vercel.json` pede 60s. Se o seu
   plano permitir menos, baixe `SERVERLESS_BUDGET_MS` para uns 5s abaixo do
   limite real, ou a invocação é morta no meio da pipeline (o trabalho é
   retomável, mas você queima tempo).

---

## Variáveis de ambiente

Obrigatórias em qualquer host:

| Variável | Observação |
|---|---|
| `RPC_ENDPOINT` | Helius ou QuickNode. RPC público toma rate limit. |
| `VAULT_PRIVATE_KEY` | base58 ou array de 64 bytes. **Use KMS/HSM em produção.** |
| `FIAT_PROVIDER_SECRET` | segredo do webhook do on-ramp. |
| `ADMIN_API_KEY` | mín. 16 chars. Protege `/admin/api/*`. |
| `RECIPIENTS_JSON` | seed da primeira subida; depois a fonte de verdade é o banco. |
| `INPUT_MINT` | USDC mainnet: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `DATABASE_URL` | Postgres em produção. |

Relevantes para deploy:

| Variável | Default | Para quê |
|---|---|---|
| `CRON_SECRET` | — | Autentica `/admin/cron/tick` e `/admin/cron/distribute`. |
| `SERVERLESS_BUDGET_MS` | `45000` | Teto de trabalho por invocação. Mantenha abaixo do `maxDuration`. |
| `ALLOW_PIPELINE` | ligada | Kill switch. `false` registra ordens sem processá-las. |
| `NODE_ENV` | `development` | Em `production`: log JSON e sem detalhe de erro interno na resposta. |
| `DATABASE_PROVIDER` | — | Lido por `scripts/set-db-provider.js` sem argumento. |

```bash
node -e "console.log('ADMIN_API_KEY=admin_'+require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log('CRON_SECRET=cron_'+require('crypto').randomBytes(24).toString('hex'))"
```

## Endpoints de cron

| Rota | O que faz |
|---|---|
| `GET\|POST /admin/cron/tick` | Retoma execuções interrompidas, retoma ordens pendentes, distribui lucro se houver, limpa locks expirados. **Use este.** |
| `GET\|POST /admin/cron/distribute` | Só a distribuição. |

Ambos autenticados por `Authorization: Bearer $CRON_SECRET`, idempotentes e
protegidos por lock — chamar em paralelo não duplica trabalho.

## Trocar SQLite ↔ Postgres

O Prisma não aceita `env()` no `provider` do datasource (verificado na 5.22),
então a troca é por script sobre um schema único:

```bash
npm run db:postgres   # produção
npm run db:sqlite     # dev local
```

O `buildCommand` do `vercel.json` já chama o script. O `binaryTargets` do schema
inclui `rhel-openssl-3.0.x` (runtime da Vercel/Lambda) além de `native`.

## Checklist antes do primeiro euro real

Nada disto é opcional:

- [ ] ciclo completo rodado em **devnet**, várias vezes, incluindo crash
      proposital entre swap e liquidação e entre dois lotes da distribuição
- [ ] `VAULT_PRIVATE_KEY` fora de variável de ambiente (KMS/HSM)
- [ ] cada evento de webhook confirmado contra a API do provedor por `paymentId`
      — hoje o HMAC é a única prova de que o pagamento existiu
- [ ] tick frequente configurado, se estiver em serverless
- [ ] alerta externo para `PayoutRun` em `PARTIAL` e ordens em `FAILED`
- [ ] repositório privado (o README lista as fragilidades do sistema)
- [ ] habilitação regulatória: operar on-ramp fiat e redistribuir fundos de
      terceiros é atividade regulada (KYC/AML, licença de pagamentos)
