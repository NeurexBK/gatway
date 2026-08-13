import { Router, type Request, type Response } from 'express';
import { config, TOTAL_BPS } from '../config';
import { GatewayError, SUPPORTED_CURRENCIES, type FiatCurrency } from '../types';
import { compareProviderFees, resolveEffectiveFee } from '../services/fee.service';
import { quoteHuman } from '../services/jupiter.service';
import { ah } from '../utils/async-route';

/**
 * Cotação pública para o checkout.
 *
 * É AQUI que o roteamento "sempre o melhor provedor" acontece de verdade: o
 * frontend consulta este endpoint antes de iniciar a compra, recebe qual
 * on-ramp está mais barato agora e direciona o cliente para ele. Escolher
 * provedor depois do pagamento seria impossível — o dinheiro já teria entrado
 * pelo caminho errado.
 */

const router: Router = Router();

router.get('/', ah(async (req: Request, res: Response) => {
  const currency = String(req.query.currency ?? 'EUR').toUpperCase() as FiatCurrency;
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new GatewayError(
      `moeda não suportada: "${currency}" (aceitas: ${SUPPORTED_CURRENCIES.join(', ')})`,
      'UNSUPPORTED_CURRENCY',
      false,
    );
  }

  const amount = Number(req.query.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new GatewayError('amount precisa ser um número positivo', 'INVALID_AMOUNT', false);
  }

  const [comparison, fee] = await Promise.all([
    compareProviderFees(currency, amount),
    resolveEffectiveFee(currency, amount),
  ]);

  // Estimativa de SOL: assume settlement ~1:1 em stablecoin (o on-ramp credita
  // o valor menos as taxas dele). É ESTIMATIVA — o valor final vem do delta
  // real do swap no momento da liquidação.
  const baseUnits = BigInt(Math.round(amount * 10 ** config.swap.inputMintDecimals));
  let estimate: { outSol: number; priceImpactPct: string } | { error: string };
  try {
    const jup = await quoteHuman(baseUnits);
    estimate = { outSol: jup.outSol, priceImpactPct: jup.priceImpactPct };
  } catch (err) {
    estimate = { error: err instanceof Error ? err.message : String(err) };
  }

  const customerShare = (TOTAL_BPS - fee.feeBps) / TOTAL_BPS;

  res.json({
    fiatCurrency: currency,
    fiatAmount: amount.toFixed(2),
    /** Provedor para onde o checkout deve mandar o cliente. */
    recommendedProvider: comparison.best?.provider ?? null,
    providerCostBps: fee.providerCostBps,
    marginBps: fee.marginBps,
    feeBps: fee.feeBps,
    feePercent: `${(fee.feeBps / 100).toFixed(2)}%`,
    feeSource: fee.sourceProvider,
    estimatedCustomerSol:
      'outSol' in estimate ? Number((estimate.outSol * customerShare).toFixed(9)) : null,
    swapEstimate: estimate,
    providers: comparison.quotes.map((q) => ({
      provider: q.provider,
      costBps: q.available ? q.costBps : null,
      available: q.available,
    })),
    disclaimer:
      'Estimativa. O valor final depende da cotação do swap no instante da liquidação. ' +
      'Custos de provedor vêm de adapters ainda não verificados contra as APIs reais.',
    collectedAt: comparison.collectedAt,
  });
}));

export default router;
