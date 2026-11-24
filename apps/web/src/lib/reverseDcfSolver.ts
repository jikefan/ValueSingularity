const DEFAULT_HORIZON_YEARS = 10
const MIN_GROWTH_RATE = -0.3
const MAX_GROWTH_RATE = 0.6
const BISECTION_ITERATIONS = 80

export type SolveImpliedFcfCagrInput = {
  enterpriseValueYuan: number
  baseFcfYuan: number
  discountRatePct: number
  terminalMultiple: number
  horizonYears?: number
  minGrowth?: number
  maxGrowth?: number
}

/** Computes DCF enterprise value for a 10-year constant-growth FCF stream and terminal multiple. */
export function dcfPresentValue(
  baseFcf: number,
  growthRate: number,
  discountRate: number,
  terminalMultiple: number,
  horizonYears = DEFAULT_HORIZON_YEARS,
): number {
  let pv = 0
  for (let year = 1; year <= horizonYears; year += 1) {
    const fcfT = baseFcf * (1 + growthRate) ** year
    pv += fcfT / (1 + discountRate) ** year
  }
  const terminalFcf = baseFcf * (1 + growthRate) ** horizonYears
  const terminalValue = terminalFcf * terminalMultiple
  pv += terminalValue / (1 + discountRate) ** horizonYears
  return pv
}

/**
 * Solves for the implied FCF CAGR (%) in [minGrowth, maxGrowth] matching enterpriseValueYuan.
 * Mirrors apps/api/app/domain/engines/reverse_dcf.py for exact browser parity.
 */
export function solveImpliedFcfCagrPct({
  enterpriseValueYuan,
  baseFcfYuan,
  discountRatePct,
  terminalMultiple,
  horizonYears = DEFAULT_HORIZON_YEARS,
  minGrowth = MIN_GROWTH_RATE,
  maxGrowth = MAX_GROWTH_RATE,
}: SolveImpliedFcfCagrInput): number | null {
  if (
    !Number.isFinite(enterpriseValueYuan) ||
    !Number.isFinite(baseFcfYuan) ||
    !Number.isFinite(discountRatePct) ||
    !Number.isFinite(terminalMultiple) ||
    enterpriseValueYuan <= 0 ||
    baseFcfYuan <= 0 ||
    terminalMultiple <= 0 ||
    discountRatePct <= -100
  ) {
    return null
  }

  const r = discountRatePct / 100
  const pvLow = dcfPresentValue(baseFcfYuan, minGrowth, r, terminalMultiple, horizonYears)
  const pvHigh = dcfPresentValue(baseFcfYuan, maxGrowth, r, terminalMultiple, horizonYears)
  if (enterpriseValueYuan < pvLow || enterpriseValueYuan > pvHigh) {
    return null
  }

  let low = minGrowth
  let high = maxGrowth
  for (let i = 0; i < BISECTION_ITERATIONS; i += 1) {
    const mid = 0.5 * (low + high)
    const pvMid = dcfPresentValue(baseFcfYuan, mid, r, terminalMultiple, horizonYears)
    if (pvMid < enterpriseValueYuan) {
      low = mid
    } else {
      high = mid
    }
  }

  return Number((0.5 * (low + high) * 100).toFixed(2))
}

/** Computes signed percentage-point spread (implied CAGR minus historical revenue CAGR). */
export function formatSpreadPct(
  impliedPct: number | null | undefined,
  historicalPct: number | null | undefined,
): number | null {
  if (
    impliedPct === null ||
    impliedPct === undefined ||
    historicalPct === null ||
    historicalPct === undefined ||
    !Number.isFinite(impliedPct) ||
    !Number.isFinite(historicalPct)
  ) {
    return null
  }
  return Number((impliedPct - historicalPct).toFixed(2))
}
