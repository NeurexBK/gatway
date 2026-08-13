/**
 * Entrypoint do servidor de longa duração.
 *
 * Deliberadamente minúsculo e sem imports estáticos do app: a validação de
 * ambiente lança `ConfigError` durante o `import` de `./config`, e só um
 * `import()` dinâmico dentro de `try/catch` consegue transformar isso numa
 * mensagem útil em vez de um stack trace cru.
 *
 * Para o entrypoint serverless, ver `api/index.ts`.
 */
async function run(): Promise<void> {
  try {
    const { start } = await import('./bootstrap');
    await start();
  } catch (err) {
    if (err instanceof Error && err.name === 'ConfigError') {
      console.error(`\n[config] ${err.message}\n`);
      console.error('Corrija o .env (ou as variáveis de ambiente do host) e suba de novo.\n');
      process.exit(1);
    }
    // Qualquer outra falha de boot: stack completo, é bug ou dependência fora.
    console.error('\n[boot] falha ao inicializar:');
    console.error(err);
    process.exit(1);
  }
}

void run();
