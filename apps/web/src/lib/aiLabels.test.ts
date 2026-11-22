import { describe, expect, it } from 'vitest'
import { formatFalsifyRuleLine, getAiSourceSectionLabel } from './aiLabels'

describe('aiLabels', () => {
  it('localizes all backend cited_facts source_section keys and passes through unknown labels', () => {
    expect(getAiSourceSectionLabel('radar')).toBe('五维雷达')
    expect(getAiSourceSectionLabel('valuation')).toBe('估值')
    expect(getAiSourceSectionLabel('moat')).toBe('护城河')
    expect(getAiSourceSectionLabel('financial_ct')).toBe('财务排雷')
    expect(getAiSourceSectionLabel('shareholder_return')).toBe('股东回报')
    expect(getAiSourceSectionLabel('reverse_dcf')).toBe('逆向DCF')
    expect(getAiSourceSectionLabel('growth')).toBe('增长引擎')
    expect(getAiSourceSectionLabel('metadata')).toBe('基础信息')
    expect(getAiSourceSectionLabel('user_draft')).toBe('投资理由')
    expect(getAiSourceSectionLabel('估值截面')).toBe('估值截面')
  })

  it('appends %, 元, x units cleanly in formatFalsifyRuleLine', () => {
    expect(formatFalsifyRuleLine({ metric: 'roe', op: 'lt', value: 12, periods: 2 })).toBe(
      'ROE < 12%（连续 2 期）',
    )
    expect(
      formatFalsifyRuleLine({ metric: 'pe_percentile_10y', op: 'gte', value: 80, periods: 1 }),
    ).toBe('10年PE分位 ≥ 80%（连续 1 期）')
    expect(formatFalsifyRuleLine({ metric: 'close', op: 'lte', value: 1400, periods: 1 })).toBe(
      '股价 ≤ 1400元（连续 1 期）',
    )
    expect(
      formatFalsifyRuleLine({ metric: 'fcf_coverage_ratio', op: 'lt', value: 1.2, periods: 1 }),
    ).toBe('FCF覆盖倍数 < 1.2x（连续 1 期）')
    expect(formatFalsifyRuleLine({ metric: 'ct_red_count', op: 'gte', value: 1, periods: 1 })).toBe(
      'CT红灯数 ≥ 1（连续 1 期）',
    )
  })
})
