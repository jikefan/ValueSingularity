import { describe, expect, it } from 'vitest'
import {
  chgClass,
  deltaTone,
  fmtMoney,
  fmtNum,
  fmtPct,
  formatForensicRatioPct,
  formatNum,
  formatPct,
  formatSignedPct,
  formatStockName,
  formatYi,
  qualityTone,
  toYi,
} from './format'

describe('format', () => {
  it('renders signed percentages', () => {
    expect(fmtPct(1.234)).toBe('+1.23%')
    expect(fmtPct(-1.2)).toBe('-1.20%')
    expect(fmtPct(0)).toBe('0.00%')
  })

  it('abbreviates money in 亿/万', () => {
    expect(fmtMoney(3.12e9)).toBe('31.20 亿')
    expect(fmtMoney(-6.1e8)).toBe('-6.10 亿')
    expect(fmtMoney(8.4e8)).toBe('8.40 亿')
    expect(fmtMoney(1200)).toBe('1200.00')
  })

  it('keeps fixed digits for numbers', () => {
    expect(fmtNum(24.6, 1)).toBe('24.6')
  })

  it('maps sign to css class', () => {
    expect(chgClass(0.1)).toBe('up')
    expect(chgClass(-0.1)).toBe('down')
    expect(chgClass(0)).toBe('flat')
  })

  it('formats nullable 亿元, percentage, number, and delta tone safely', () => {
    expect(formatYi(1.25e11)).toBe('1,250.00 亿元')
    expect(formatYi(-3.5e8, 1)).toBe('-3.5 亿元')
    expect(formatYi(null)).toBe('—')
    expect(formatYi(undefined)).toBe('—')

    expect(toYi(1.234e9)).toBe(12.34)
    expect(toYi(null)).toBeNull()

    expect(formatPct(28.456)).toBe('28.46%')
    expect(formatPct(null)).toBe('—')
    expect(formatSignedPct(5.2)).toBe('+5.20%')
    expect(formatSignedPct(-3.1, 1)).toBe('-3.1%')
    expect(formatSignedPct(undefined)).toBe('—')

    expect(formatNum(18.567)).toBe('18.57')
    expect(formatNum(null)).toBe('—')

    expect(deltaTone(4.2)).toBe('up')
    expect(deltaTone(-1.5)).toBe('down')
    expect(deltaTone(4.2, true)).toBe('down')
    expect(deltaTone(0)).toBe('flat')
    expect(deltaTone(null)).toBe('')

    expect(qualityTone(4.2)).toBe('tone-good')
    expect(qualityTone(-1.5)).toBe('tone-bad')
    expect(qualityTone(4.2, true)).toBe('tone-bad')
    expect(qualityTone(-1.5, true)).toBe('tone-good')
    expect(qualityTone(0)).toBe('flat')
    expect(qualityTone(null)).toBe('')
    expect(qualityTone(Number.NaN)).toBe('')
  })

  it('normalizes stock names by removing internal whitespace and guarding blanks', () => {
    expect(formatStockName('五 粮 液')).toBe('五粮液')
    expect(formatStockName('  贵州 茅台 \t')).toBe('贵州茅台')
    expect(formatStockName('招商银行')).toBe('招商银行')
    expect(formatStockName('')).toBe('—')
    expect(formatStockName('   ')).toBe('—')
    expect(formatStockName(null)).toBe('—')
    expect(formatStockName(undefined)).toBe('—')
  })

  it('formats forensic ratios safely and guards extreme sentinel percentages', () => {
    expect(formatForensicRatioPct(42.36)).toBe('42.4%')
    expect(formatForensicRatioPct(-18.24)).toBe('-18.2%')
    expect(formatForensicRatioPct(0)).toBe('0.0%')
    expect(formatForensicRatioPct(899.94)).toBe('899.9%')

    expect(formatForensicRatioPct(null)).toBe('—')
    expect(formatForensicRatioPct(undefined)).toBe('—')
    expect(formatForensicRatioPct(Number.NaN)).toBe('—')
    expect(formatForensicRatioPct(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatForensicRatioPct(null, { fallbackText: '暂无数据' })).toBe('暂无数据')

    expect(formatForensicRatioPct(999.0)).toBe('主业微利(不适用)')
    expect(formatForensicRatioPct(900)).toBe('主业微利(不适用)')
    expect(formatForensicRatioPct(-950)).toBe('主业微利(不适用)')
    expect(formatForensicRatioPct(999.0, { fallbackText: '无法计算' })).toBe('无法计算')
    expect(formatForensicRatioPct(500, { maxDisplay: 500 })).toBe('主业微利(不适用)')
    expect(formatForensicRatioPct(499.9, { maxDisplay: 500 })).toBe('499.9%')
  })
})
