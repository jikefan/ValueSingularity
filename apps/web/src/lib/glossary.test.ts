import { describe, expect, it } from 'vitest'
import { GLOSSARY, type GlossaryKey } from './glossary'

const REQUIRED_GLOSSARY_KEYS: readonly GlossaryKey[] = [
  // Market & Macro
  'market_temperature',
  'pe_median',
  'market_pe_percentile',
  'bond_yield_10y',
  'equity_bond_spread',
  'industry_money_flow',
  'industry_change_pct',
  'industry_net_inflow',
  'industry_company_count',
  'workflow_guide',
  // Screener
  'screener_radar',
  'filter_zero_red',
  'filter_pe_percentile_max',
  'filter_roe_min',
  'filter_dividend_yield_min',
  'radar_total_score',
  'ct_lights',
  'pe_ttm_and_pct',
  'roe_5y_avg',
  'dividend_yield',
  'implied_fcf_cagr',
  // Stock Overview & Meta
  'stock_verdict',
  'stock_radar_summary',
  'radar_profitability',
  'radar_moat',
  'radar_leverage',
  'radar_cashflow',
  'radar_capital_endurance',
  'radar_valuation',
  'valuation_pct_10y',
  'ct_and_implied',
  'industry_sw1',
  'industry_sw2',
  'list_date',
  'trade_status',
  'radar_2d_3d',
  'bear_risk_summary',
  'methodology_spec',
  'pe_ttm',
  'pb',
  'latest_close',
  // Financials
  'revenue',
  'net_profit',
  'deduct_net_profit',
  'ocf',
  'fcf',
  'roe',
  'gross_margin',
  'net_margin',
  'net_cash',
  // Moat & Growth & Institutions
  'moat_indicators',
  'roe_10y_min',
  'gross_margin_latest',
  'gross_margin_std',
  'roic_approx',
  'cash_profit_ratio',
  'capex_burden',
  'interest_bearing_debt',
  'growth_engine',
  'rd_intensity',
  'pledge_ratio',
  'audit_opinion',
  'peer_rank',
  // Valuation & DCF
  'hist_pe_mv',
  'reverse_dcf',
  'pb_roe_implied',
  'market_cap',
  'enterprise_value',
  'base_fcf_3y',
  'wacc',
  'terminal_multiple',
  'hist_rev_cagr',
  'implied_minus_hist',
  'sensitivity_matrix',
  // Governance
  'shareholder_return',
  'total_dividend',
  'total_repurchase',
  'equity_financing',
  'net_shareholder_return',
  'total_fcf',
  'dividend_yield_current',
  // ClearTruth CT Rules & MD&A
  'ct_scanner',
  'ct_cash_debt_high',
  'ct_cip_bloat',
  'ct_ocf_divergence',
  'ct_ar_inventory_bloat',
  'ct_goodwill_risk',
  'ct_pledge_risk',
  'ct_audit_opinion',
  'mda_diff',
  'mda_metric_shift',
  'mda_text_diff',
  // Decision, Alerts & Ledger
  'devils_advocate',
  'time_capsule',
  'falsify_rule',
  'decision_journal',
  'decision_emotion',
  'strike_zone_threshold',
  'strike_zone_sentinel',
  'webhook_push',
  'byok_ai',
  'decision_ledger',
  'emotion_win_rate',
  'hs300_benchmark',
  'excess_alpha',
  'win_rate',
  'pe_score_delta',
  'falsify_status',
  // Compare
  'compare_matrix',
  'snapshot_status',
  'net_cash_to_mv',
  'ocf_to_profit_5y',
  'net_cash_yield',
]

const REQUIRED_FOUR_FIELD_KEYS = [
  // Forensics & Profit Truth
  'forensic_profit_truth',
  'core_operating_profit',
  'invest_and_fair_value',
  'invest_profit_share',
  'subsidy_and_oneoff',
  'investment_assets_ratio',
  'dupont_attribution',
  'asset_turnover',
  'equity_multiplier',
  'capital_allocation',
  'interest_burden',
  'ocf_to_core_profit',
  // Cross-Asset Discovery & Regime
  'macro_discovery_board',
  'us_2y_fed_anchor',
  'us_10y_real_yield',
  'us_10y_2y_spread',
  'us_cn_10y_spread',
  'gold_fed_signal',
  'gold_au9999_sge',
  'style_rotation_signal',
  'dividend_bond_spread',
  'earnings_quality_contrast',
  'deep_value_fortress',
  'quality_filter',
] as const satisfies readonly GlossaryKey[]

const REQUIRED_PLAIN_GLOSSARY_KEYS = [
  'market_temperature',
  'pe_median',
  'market_pe_percentile',
  'bond_yield_10y',
  'equity_bond_spread',
  'industry_money_flow',
  'workflow_guide',
  'screener_radar',
  'filter_zero_red',
  'quality_filter',
  'us_2y_fed_anchor',
  'us_10y_real_yield',
  'us_10y_2y_spread',
  'us_cn_10y_spread',
  'gold_au9999_sge',
  'gold_fed_signal',
  'style_rotation_signal',
  'earnings_quality_contrast',
  'deep_value_fortress',
  'forensic_profit_truth',
  'core_operating_profit',
  'invest_profit_share',
  'subsidy_and_oneoff',
  'investment_assets_ratio',
  'ocf_to_core_profit',
  'interest_burden',
  'dupont_attribution',
  'capital_allocation',
  'radar_total_score',
  'valuation_pct_10y',
  'ct_and_implied',
  'reverse_dcf',
  'graham_number',
  'roe_5y_avg',
  'dividend_yield',
  'dividend_bond_spread',
  'pb',
  'pe_ttm',
  'fcf',
  'ocf',
  'net_cash',
  'strike_zone_threshold',
  'strike_zone_sentinel',
  'decision_ledger',
  'emotion_win_rate',
  'gross_margin',
  'roe',
  'pe_ttm_and_pct',
  'net_margin',
  'revenue',
  'net_profit',
  'deduct_net_profit',
  'shareholder_return',
  'net_cash_yield',
] as const satisfies readonly GlossaryKey[]

describe('GLOSSARY', () => {
  it('defines non-empty label, summary, and valid optional plain/formula/reading for every entry', () => {
    const keys = Object.keys(GLOSSARY) as GlossaryKey[]
    const allRequired = [...REQUIRED_GLOSSARY_KEYS, ...REQUIRED_FOUR_FIELD_KEYS]
    expect(keys.length).toBeGreaterThanOrEqual(allRequired.length)
    expect(REQUIRED_PLAIN_GLOSSARY_KEYS.length).toBeGreaterThanOrEqual(45)

    for (const requiredKey of allRequired) {
      expect(GLOSSARY[requiredKey]).toBeDefined()
    }

    for (const fourFieldKey of REQUIRED_FOUR_FIELD_KEYS) {
      const entry = GLOSSARY[fourFieldKey]
      expect(entry.label.trim().length, `${fourFieldKey}.label`).toBeGreaterThan(0)
      expect(entry.summary.trim().length, `${fourFieldKey}.summary`).toBeGreaterThan(0)
      expect(entry.formula.trim().length, `${fourFieldKey}.formula`).toBeGreaterThan(0)
      expect(entry.reading.trim().length, `${fourFieldKey}.reading`).toBeGreaterThan(0)
    }

    for (const plainKey of REQUIRED_PLAIN_GLOSSARY_KEYS) {
      const entry = GLOSSARY[plainKey]
      expect('plain' in entry && typeof entry.plain === 'string', `${plainKey}.plain`).toBe(true)
      if ('plain' in entry && typeof entry.plain === 'string') {
        expect(entry.plain.trim().length, `${plainKey}.plain`).toBeGreaterThan(0)
      }
    }

    for (const key of keys) {
      const entry = GLOSSARY[key]
      expect(entry.label.trim().length, `${key}.label`).toBeGreaterThan(0)
      expect(entry.summary.trim().length, `${key}.summary`).toBeGreaterThan(0)
      if ('plain' in entry && entry.plain !== undefined) {
        expect(entry.plain.trim().length, `${key}.plain`).toBeGreaterThan(0)
      }
      if ('formula' in entry && entry.formula !== undefined) {
        expect(entry.formula.trim().length, `${key}.formula`).toBeGreaterThan(0)
      }
      if ('reading' in entry && entry.reading !== undefined) {
        expect(entry.reading.trim().length, `${key}.reading`).toBeGreaterThan(0)
      }
    }

    expect(GLOSSARY.quality_filter.summary).toContain('剔除投资依赖')
    expect(GLOSSARY.quality_filter.reading).toContain('剔除投资依赖')
    expect(GLOSSARY.quality_filter.summary).not.toContain('隐藏炒股/补贴虚胖股')
    expect(GLOSSARY.quality_filter.reading).not.toContain('隐藏炒股/补贴虚胖股')
  })
})
