import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Entrypoint serverless (Vercel / AWS Lambda).
 *
 * Duas responsabilidades, nesta ordem:
 *
 *  1. **Nunca crashar por configuração.** O `import` do app pode lançar
 *     `ConfigError` se faltar variável de ambiente. Um throw aqui viraria
 *     `FUNCTION_INVOCATION_FAILED` — um 500 opaco que não diz nada a quem está
 *     no navegador. Em vez disso capturamos e respondemos 503 com a lista
 *     exata do que falta.
 *
 *  2. **Não fingir que o gateway está completo aqui.** Num runtime serverless a
 *     pipeline que move dinheiro fica desabilitada por default
 *     (`config.runtime.allowPipeline === false`), porque os locks de
 *     concorrência são in-process. O que funciona: /health, /quote e o painel
 *     admin (com Postgres configurado). O que não funciona: swap, liquidação e
 *     o agendador in-process. Ver DEPLOY.md.
 *
 * O import é dinâmico e cacheado entre invocações do mesmo container.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let cached: Handler | null = null;
let bootError: { problems: string[]; message: string } | null = null;

async function getHandler(): Promise<Handler | null> {
  if (cached) return cached;
  if (bootError) return null;

  try {
    const { createApp } = await import('../src/app');
    const app = createApp();
    cached = app as unknown as Handler;
    return cached;
  } catch (err) {
    const problems =
      err !== null &&
      typeof err === 'object' &&
      'problems' in err &&
      Array.isArray((err as { problems: unknown }).problems)
        ? ((err as { problems: string[] }).problems)
        : [];
    bootError = {
      problems,
      message: err instanceof Error ? err.message : String(err),
    };
    // Vai para os logs da plataforma; a resposta HTTP leva o mesmo conteúdo.
    console.error('[boot] falha ao inicializar o app:', bootError.message);
    return null;
  }
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const app = await getHandler();

  if (!app) {
    const required = [
      'RPC_ENDPOINT',
      'VAULT_PRIVATE_KEY',
      'FIAT_PROVIDER_SECRET',
      'ADMIN_API_KEY',
      'RECIPIENTS_JSON',
      'INPUT_MINT',
      'DATABASE_URL',
    ];
    const missing = required.filter((k) => !process.env[k]);

    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify(
        {
          error: 'configuration_error',
          message: 'O gateway não inicializou: configuração incompleta.',
          problems: bootError?.problems ?? [bootError?.message ?? 'erro desconhecido'],
          missingEnvVars: missing,
          hint:
            'Defina as variáveis no painel da plataforma (na Vercel: Settings → ' +
            'Environment Variables) e faça um redeploy. DATABASE_URL precisa ser ' +
            'Postgres: SQLite não funciona em disco efêmero. Ver DEPLOY.md.',
        },
        null,
        2,
      ),
    );
    return;
  }

  app(req, res);
}
