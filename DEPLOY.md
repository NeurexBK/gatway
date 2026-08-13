# Deploy

## Resumo curto

**A Vercel não é o host certo para este backend.** Ela agora funciona sem
crashar, e serve `/health`, `/quote` e o painel admin — mas a parte que move
dinheiro fica **desligada** lá, de propósito. Para o gateway completo use um host
com processo persistente (Render, Railway, Fly.io, VPS).

| | Vercel (serverless) | Host persistente |
|---|---|---|
| `/health`, `/quote`, painel admin | funciona | funciona |
| Webhook registra a ordem | funciona | funciona |
| Swap + liquidação do cliente | **desligado** | funciona |
| Distribuição diária de lucro | via cron externo, horário em UTC | horário/timezone do admin |
| Banco | Postgres obrigatório | SQLite (dev) ou Postgres |

## Por que a pipeline fica desligada em serverless

Três garantias do sistema dependem de **um processo único e de longa duração**:

1. `inFlight` — impede processar a mesma ordem duas vezes em paralelo;
2. o **mutex de swap** — torna indivisível a sequência "verificar saldo não
   reservado → swapar";
3. o **agendador** — um `setTimeout` de horas até o horário configurado.

Serverless roda N instâncias efêmeras. As duas primeiras deixam de valer, e o
resultado é o double-spend de depósito: duas ordens gastando o mesmo USDC. A
terceira simplesmente nunca dispara.

Por isso `config.runtime.allowPipeline` é `false` quando o runtime é detectado
como serverless. O webhook continua respondendo `202` e **registra** a ordem —
nada de pagamento perdido — mas ela fica em `PENDING` com
`lastError: PIPELINE_DISABLED` em vez de ser processada sem rede de segurança.

Para habilitar em serverless você precisa antes trocar os locks in-process por
lock no banco (advisory lock no Postgres). Depois disso, `ALLOW_PIPELINE=true`.
Não force esse flag antes disso.

---

## Opção A — Render (recomendado)

Processo persistente, uma instância, Postgres gerenciado. Tudo funciona.

1. **Postgres:** crie um Postgres no Render e copie a *Internal Database URL*.
2. **Serviço web:** conecte o repo e configure:
   - Build: `npm install && npm run db:postgres && npx prisma migrate deploy && npm run build`
   - Start: `npm start`
   - Instâncias: **1** (importante — ver acima)
3. **Variáveis de ambiente:** as da tabela abaixo, com `DATABASE_URL` do passo 1.

Na primeira subida, em vez de `migrate deploy`, gere a migration inicial:

```bash
npm run db:postgres
npx prisma migrate dev --name init
git add -A && git commit -m "chore(db): migration inicial postgres"
```

`render.yaml` no repo já traz isso pronto — o Render lê o arquivo e provisiona
o serviço e o banco sozinho.

## Opção B — Docker (VPS, Fly.io, Railway)

```bash
docker build -t solana-fiat-gateway .
docker run -p 3000:3000 --env-file .env solana-fiat-gateway
```

Uma réplica só. Se escalar horizontalmente, os locks precisam ir para o banco
primeiro.

## Opção C — Vercel (só a superfície de API)

Já está configurada: `vercel.json` + `api/index.ts`.

1. **Postgres obrigatório.** SQLite não funciona: o disco é efêmero e o banco
   desapareceria entre invocações. Use Neon, Supabase ou Vercel Postgres e
   coloque a connection string em `DATABASE_URL`.
2. **Variáveis de ambiente** no painel: Settings → Environment Variables.
   Faltando qualquer uma, a função responde **503 com a lista exata do que
   falta** em JSON — não mais o `FUNCTION_INVOCATION_FAILED` opaco.
3. **Migration:** rode do seu terminal, apontando para o Postgres de produção:
   ```bash
   npm run db:postgres && npx prisma migrate deploy
   ```
4. **Cron:** `vercel.json` já registra um cron diário em `0 0 * * *` batendo em
   `/admin/cron/distribute`, autenticado por `CRON_SECRET`. Defina essa
   variável, ou o endpoint responde 503 e nada é distribuído.

Duas ressalvas sobre o cron na Vercel:

- **o horário passa a ser o do cron, em UTC.** Os campos de hora/timezone do
  painel admin deixam de mandar — o agendador in-process não roda lá. Ajuste o
  `schedule` no `vercel.json`, não o admin.
- **plano Hobby limita cron a 2 invocações/dia.** Por isso o default é diário e
  não a cada hora.

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
| `CRON_SECRET` | — | Autentica o cron externo. Sem ela, `/admin/cron/distribute` responde 503. |
| `ALLOW_PIPELINE` | ligada em host persistente, desligada em serverless | Override manual. Só ligue em serverless após trocar os locks. |
| `NODE_ENV` | `development` | Em `production` o log sai em JSON e erros internos não vazam detalhe. |
| `DATABASE_PROVIDER` | — | Lido por `scripts/set-db-provider.js` quando nenhum argumento é passado. |

Gerar segredos:

```bash
node -e "console.log('ADMIN_API_KEY=admin_'+require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log('CRON_SECRET=cron_'+require('crypto').randomBytes(24).toString('hex'))"
```

## Trocar SQLite ↔ Postgres

O Prisma **não** aceita `env()` no `provider` do datasource (verificado na 5.22),
então a troca é por script sobre um schema único:

```bash
npm run db:postgres   # produção
npm run db:sqlite     # dev local
```

O script é idempotente e o `buildCommand` do `vercel.json` já o chama.

## Checklist antes do primeiro euro real

Nada disto é opcional:

- [ ] ciclo completo rodado em **devnet**, várias vezes, incluindo crash
      proposital entre swap e liquidação e entre dois lotes da distribuição
- [ ] `VAULT_PRIVATE_KEY` fora de variável de ambiente (KMS/HSM)
- [ ] cada evento de webhook confirmado contra a API do provedor por `paymentId`
- [ ] uma instância só, ou locks migrados para o banco
- [ ] alerta externo para `PayoutRun` em `PARTIAL` e ordens em `FAILED`
- [ ] repositório privado (o README lista as fragilidades do sistema)
- [ ] habilitação regulatória: operar on-ramp fiat e redistribuir fundos de
      terceiros é atividade regulada (KYC/AML, licença de pagamentos)
