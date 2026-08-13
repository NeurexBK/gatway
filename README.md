# Solana Fiat Gateway — modelo broker

O cliente paga em **EUR/USD/BRL**, o on-ramp credita stablecoin no vault, o
backend faz **swap para SOL** via Jupiter, envia ao cliente o SOL **menos a
taxa**, e a taxa acumulada é **distribuída aos sócios em horário fixo diário**.

```
cliente paga fiat
      │
      ▼
on-ramp mais barato ──webhook HMAC──► POST /webhook/fiat-payment
      │                                      │ 202 imediato
      │ settlement USDC no vault             ▼
      │                              Order PENDING
      │                                      │ aguarda depósito (reserva FIFO)
      │                                      ▼
      │                                 PROCESSING
      │                                      │ swap USDC→SOL (Jupiter)
      │                                      ▼
      │                                   SWAPPED
      │                                      │ cliente recebe SOL − taxa
      │                                      ▼
      │                                   SETTLED ──── taxa retida no vault
      │                                      │              (lucro acumulado)
      │                                      │
      │        horário fixo diário  ─────────┤
      │        (ex.: 21:30 America/Sao_Paulo)│
      │                                      ▼
      │                              PayoutRun: split por bps
      │                                      ▼
      └───────────────────────────────► DISTRIBUTED
```

**Onde entra o dinheiro:** a receita é só a taxa. `feeBps = custo do melhor
on-ramp (tempo real) + margem`, limitada por piso/teto. Provedor mais barato =
mais margem retida sem mexer no preço final do cliente.

## O que está verificado e o que não está

Isto importa mais que a lista de features. Estado real em 13/08/2026:

| Componente | Status |
|---|---|
| Máquina de estados, idempotência, reserva FIFO de depósito | **testado** (cenários de corrida simulados no banco) |
| Split por bps, invariante de conservação, resto para o maior bps | **testado** (incluindo valores com resto) |
| Cálculo da taxa e rateio cliente/lucro | **testado** (soma cliente+lucro === total swapado) |
| Cálculo do horário com timezone e DST | **testado** (UTC, São Paulo, Lisboa, Tóquio, virada de dia) |
| Validação HMAC, anti-replay, rejeição de payload | **testado** |
| Admin: auth, validações, edição de split e horário | **testado** |
| Jupiter `/quote` e `/swap` | **testado contra a API real** (cotação e build de tx) |
| Guarda de price impact | **testado** (12 bps @ 2M USDC, 1999 bps @ 50M — abortou) |
| **Swap executado on-chain** | **NUNCA EXECUTADO** — nenhuma tx foi transmitida, em nenhuma rede |
| **Liquidação do cliente on-chain** | **NUNCA EXECUTADA** |
| **Distribuição on-chain** | **NUNCA EXECUTADA** |
| Adapters de taxa (MoonPay/Transak/Ramp) | **NÃO VERIFICADOS** — sem chaves; ver abaixo |

Tudo que move valor de verdade continua sem exercício real. Não use com dinheiro
antes de rodar o ciclo completo em devnet.

### Adapters de taxa dos on-ramps

Vêm **desligados** por default. O que foi possível confirmar sem chaves:

| Provedor | Endpoint | Status |
|---|---|---|
| MoonPay | `GET /v3/currencies/sol/buy_quote` | Endpoint **existe** (401 com chave inválida, não 404). Formato da resposta não verificado. |
| Ramp | `POST /api/host-api/v3/onramp/quote/all` | Endpoint **existe** (400 `hostApiKey must be a string`). Formato não verificado. |
| Transak | `GET /api/v2/currencies/price` | Não probado (precisa de partner key). |
| SpherePay | — | **Não implementado**: não achei endpoint de cotação público e verificável. Deixei explícito em vez de inventar. |

Ao plugar uma chave, compare o `costBps` calculado com o extrato real do
provedor **antes** de confiar no número. Se todos falharem, a taxa cai em
`fallbackProviderCostBps` — o pagamento nunca é bloqueado por isso.

> **Jupiter:** o host clássico `quote-api.jup.ag/v6` foi **retirado do ar** (não
> resolve mais em DNS). O default agora é `lite-api.jup.ag/swap/v1`, que serve o
> mesmo contrato — verificado com cotação e build de transação reais.

## Sobre "atomicidade"

Não é implementável ponta a ponta: o fiat vive fora da chain, e swap, liquidação
e distribuição são transações Solana distintas, sem rollback conjunto. O que
existe é o equivalente prático:

| Propriedade | Como é garantida |
|---|---|
| **Idempotência na borda** | `Order.providerEventId` é `UNIQUE`. Reentrega do webhook não cria segunda ordem nem segundo swap. |
| **Durabilidade por etapa** | Cada transição é gravada **antes** da etapa seguinte. Crash retoma de onde parou. |
| **Reserva FIFO de depósito** | O saldo de USDC é um pote comum; a atribuição é por ordem de chegada. Duas ordens **nunca** gastam o mesmo depósito — foi este o bug que existia na primeira versão. |
| **Swap serializado** | Um mutex torna "verificar saldo → swapar" indivisível no processo. |
| **Split atômico** | ≤ `MAX_TRANSFERS_PER_TX` destinatários vão em **uma** transação: todos recebem ou ninguém recebe. |
| **Lucro nunca pago duas vezes** | As ordens são vinculadas ao `PayoutRun` **antes** de mover dinheiro; a partir daí saem do pool elegível. |
| **Falha parcial não redistribui** | Se um lote saiu e outro não, o run fica `PARTIAL` e é retomado — nunca reiniciado do zero. |
| **Conservação de valor** | `sum(allocations) === total`, sempre. Resto da divisão inteira para o maior bps. |

## Deploy

Ver **[DEPLOY.md](DEPLOY.md)**. Resumo: **use um host com processo persistente**
(Render, Railway, Fly.io, VPS). Em serverless (Vercel) a API sobe e o painel
funciona, mas a pipeline que move dinheiro fica **desligada** de propósito — os
locks de concorrência e o agendador dependem de um processo único de longa
duração. `render.yaml` e `Dockerfile` estão prontos no repo.

## Setup local

```bash
npm install
cp .env.example .env
npm run keygen          # gera VAULT_PRIVATE_KEY
npm run prisma:push     # cria o SQLite de dev
npm run dev
```

`ADMIN_API_KEY` é obrigatória (mín. 16 chars):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Depois abra **http://localhost:3000/admin** e cole a chave.

Simular um pagamento:

```bash
npm run sign-webhook
```

## Painel admin

`GET /admin` — página única, sem CDN, sem framework. Configura:

- **horário da distribuição** — hora, minuto e timezone IANA, com o próximo
  disparo recalculado na hora (respeita DST);
- **lucro mínimo** por execução, para não queimar fee de rede com poeira;
- **taxa** — margem, piso, teto e custo de fallback, em bps;
- **carteiras do split** — endereços e porcentagens, com a soma travada em
  10000 bps: o botão de salvar só habilita em 100% exato;
- **consulta de taxas** dos on-ramps em tempo real, com o ranking e qual foi
  eleito o melhor;
- **distribuir agora**, com opção de ignorar o mínimo;
- histórico de execuções e ordens recentes.

O `RECIPIENTS_JSON` do `.env` virou **apenas seed** da primeira subida — depois
disso a fonte de verdade é o banco.

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/webhook/fiat-payment` | Webhook. `401` assinatura, `400` payload inaceitável, `200` não acionável, `202` aceito. |
| `GET` | `/quote?currency=EUR&amount=100` | **Cotação de checkout.** Devolve o on-ramp mais barato agora + taxa efetiva. É aqui que o roteamento "sempre o melhor" acontece — o frontend consulta antes de iniciar a compra. |
| `GET` | `/webhook/orders/:id` | Estado de uma ordem. |
| `GET` | `/admin` | Painel. |
| `GET/PUT` | `/admin/api/settings` · `/admin/api/recipients` | Config (requer chave). |
| `GET` | `/admin/api/overview` · `/api/fees` · `/api/runs` · `/api/orders` | Dados do painel. |
| `POST` | `/admin/api/distribution/run-now` | Disparo manual. |
| `GET` | `/health` · `/health/ready` · `/health/config` | Liveness · readiness · config efetiva. |

## Estrutura

```
src/
  config/index.ts                  valida TODO o .env no boot (zod)
  database/schema.prisma           Order, PayoutRun, Payout, Recipient,
                                   GatewaySettings, ProviderFeeSnapshot
  services/solana.service.ts       RPC, saldos, envio com rebroadcast
  services/jupiter.service.ts      quote + swap, mede o delta real de lamports
  services/fee.service.ts          agregador de taxas dos on-ramps + taxa efetiva
  services/distribution.service.ts split por bps + SystemProgram.transfer
  services/webhook.service.ts      HMAC + normalização multi-provedor
  services/order.service.ts        pipeline por ordem (swap + liquidação)
  services/payout.service.ts       distribuição do lucro (PayoutRun)
  services/scheduler.service.ts    horário fixo diário + varredura de pendências
  services/settings.service.ts     config no banco + cálculo de horário/timezone
  routes/{webhook,quote,admin,health}.routes.ts
  routes/admin.page.ts             painel HTML embutido
  utils/{logger,serialize,async-route}.ts
  types/index.ts                   interfaces + GatewayError (retryable)
  app.ts, server.ts
```

`utils/async-route.ts` não é decoração: o Express 4 **não** encaminha rejeições
de handlers `async` ao error middleware. Sem o wrapper, uma timezone inválida
digitada no admin derrubava o processo inteiro via `unhandledRejection` — isso
aconteceu no teste, e é o motivo de todo handler assíncrono estar envolvido.

## O que falta antes de dinheiro real

Continua valendo o que foi levantado antes, menos o que já foi corrigido.

**Corrigido nesta fase:** double-spend do depósito (reserva FIFO + mutex), teto
de price impact, teto por ordem (`MAX_ORDER_INPUT_RAW`), varredura periódica de
ordens órfãs (antes só retomava no boot), crash por erro em rota async.

**Aberto:**

1. **Rodar o ciclo completo em devnet**, várias vezes, incluindo crash proposital
   entre swap e liquidação, e entre dois lotes da distribuição.
2. **Custódia** — `VAULT_PRIVATE_KEY` em env var não serve para produção. KMS/HSM
   ou signer remoto.
3. **Confirmar cada evento na API do provedor** por `paymentId`. Hoje o HMAC é a
   única prova de que o pagamento existiu; se o segredo vazar, um evento forjado
   dispara swap e liquidação.
4. **Testes automatizados.** As verificações desta fase foram scripts descartáveis;
   `computeSplit`, `verifySignature`, `computeNextRunAt` e `committedInputRaw`
   merecem suíte fixa.
5. **Uma instância só.** `inFlight`, o mutex de swap e o guard de execução são
   in-process. Escalar horizontalmente exige lock no banco (advisory lock no
   Postgres) — com 2 réplicas, hoje, há risco de swap duplicado.
6. **Alerting.** `PARTIAL` e `NEEDS_MANUAL_REVIEW` só aparecem no painel e no log.
7. **SQLite → Postgres**, com migrations em vez de `db push`.
8. **Admin com login por pessoa.** Chave estática compartilhada não dá auditoria
   de quem mudou o split.
9. **Regulatório.** Operar on-ramp fiat, custodiar e redistribuir fundos de
   terceiros é atividade regulada na maioria das jurisdições (KYC/AML, licença de
   pagamentos). A parte técnica está aqui; a habilitação legal não.
