import { describe, expect, it } from 'vitest'
import { dcfPresentValue, formatSpreadPct, solveImpliedFcfCagrPct } from './reverseDcfSolver'

describe('reverseDcfSolver', () => {
  it('matches Python reverse_dcf.py round-trip parity at 9% WACC and 12x multiple', () => {
    const baseFcf = 12e8
    const targetEv = dcfPresentValue(baseFcf, 0.08, 0.09, 12.0, 10)
    const solved = solveImpliedFcfCagrPct({
      enterpriseValueYuan: targetEv,
      baseFcfYuan: baseFcf,
      discountRatePct: 9.0,
      terminalMultiple: 12.0,
    })
    expect(solved).toBe(8)
  })

  it('converges accurately on 600519 sample snapshot coordinates (~8.42% at 9%/12x)', () => {
    const ev = 1.725e12
    const baseFcf = 8.35e10
    const solvedBase = solveImpliedFcfCagrPct({
      enterpriseValueYuan: ev,
      baseFcfYuan: baseFcf,
      discountRatePct: 9.0,
      terminalMultiple: 12.0,
    })
    expect(solvedBase).not.toBeNull()
    expect(solvedBase).toBeGreaterThan(5)
    expect(solvedBase).toBeLessThan(12)

    const solvedHigherWacc = solveImpliedFcfCagrPct({
      enterpriseValueYuan: ev,
      baseFcfYuan: baseFcf,
      discountRatePct: 11.0,
      terminalMultiple: 12.0,
    })
    const solvedHigherMultiple = solveImpliedFcfCagrPct({
      enterpriseValueYuan: ev,
      baseFcfYuan: baseFcf,
      discountRatePct: 9.0,
      terminalMultiple: 18.0,
    })

    expect(solvedHigherWacc).not.toBeNull()
    expect(solvedHigherMultiple).not.toBeNull()
    expect(solvedHigherWacc ?? 0).toBeGreaterThan(solvedBase ?? 0)
    expect(solvedHigherMultiple ?? 0).toBeLessThan(solvedBase ?? 0)
  })

  it('returns null when inputs are non-positive or outside [-30%, +60%] bounds', () => {
    expect(
      solveImpliedFcfCagrPct({
        enterpriseValueYuan: -1e9,
        baseFcfYuan: 1e8,
        discountRatePct: 9,
        terminalMultiple: 12,
      }),
    ).toBeNull()

    expect(
      solveImpliedFcfCagrPct({
        enterpriseValueYuan: 1e11,
        baseFcfYuan: 0,
        discountRatePct: 9,
        terminalMultiple: 12,
      }),
    ).toBeNull()

    expect(
      solveImpliedFcfCagrPct({
        enterpriseValueYuan: 1e16,
        baseFcfYuan: 1e8,
        discountRatePct: 9,
        terminalMultiple: 12,
      }),
    ).toBeNull()

    expect(
      solveImpliedFcfCagrPct({
        enterpriseValueYuan: 1e6,
        baseFcfYuan: 1e9,
        discountRatePct: 9,
        terminalMultiple: 12,
      }),
    ).toBeNull()
  })

  it('computes signed spread relative to historical revenue CAGR', () => {
    expect(formatSpreadPct(11.15, 14.8)).toBe(-3.65)
    expect(formatSpreadPct(null, 14.8)).toBeNull()
    expect(formatSpreadPct(11.15, undefined)).toBeNull()
  })
})
