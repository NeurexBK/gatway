import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Encaminha rejeições de handlers `async` para o error middleware do Express.
 *
 * O Express 4 só captura erros lançados de forma sincrônica. Um `throw` dentro
 * de um handler `async` vira uma promise rejeitada que ninguém trata — cai no
 * `unhandledRejection` do processo. Num gateway de pagamentos isso significa
 * que um input inválido no admin derruba o serviço no meio de ordens em voo.
 *
 * Todo handler assíncrono TEM de ser envolvido por este wrapper.
 * (Ao migrar para Express 5, que trata isto nativamente, o wrapper pode sair.)
 */
export function ah(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
