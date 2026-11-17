import { describe, expect, it } from 'vitest'
import { chgClass, fmtMoney, fmtNum, fmtPct } from './format'

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
})
