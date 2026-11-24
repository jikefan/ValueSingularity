import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../lib/AuthProvider'
import { setAccessToken } from '../../lib/api'
import type { ChartOption } from '../../lib/charts'
import { GLOSSARY } from '../../lib/glossary'
import { createQueryClient } from '../../lib/queryClient'
import type {
  AiPreferences,
  MdaDiffResponse,
  StockDetail,
  StockSnapshotPayload,
  TokenResponse,
  UserProfile,
} from '../../types/api'
import { StockCtTab } from './StockCtTab'
import { StockDecisionTab } from './StockDecisionTab'
import { StockGovernanceTab } from './StockGovernanceTab'
import {
  StockFinancialsTab,
  StockGrowthTab,
  StockInstitutionsTab,
  StockMoatTab,
  StockOverviewTab,
} from './StockOverviewTabs'
import { StockValuationTab } from './StockValuationTab'

vi.mock('../../lib/charts', () => ({
  Chart: ({ ariaLabel }: { ariaLabel?: string; option: ChartOption }) => (
    <div role="img" aria-label={ariaLabel} />
  ),
}))

const TEST_USER: UserProfile = {
  id: '44444444-4444-4444-4444-444444444444',
  email: 'glossary@example.com',
  phone: null,
  display_name: '指标词典测试员',
  email_verified: true,
  plan_tier: 'pro',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
}

const TEST_TOKEN: TokenResponse = {
  access_token: 'glossary-token',
  token_type: 'bearer',
  expires_in: 900,
  user: TEST_USER,
}

const TEST_AI_PREFS: AiPreferences = {
  prefer_rule_only: false,
  byok_enabled: false,
  byok_base_url_masked: null,
  byok_api_key_configured: false,
  byok_api_key_masked: null,
  byok_model: 'gpt-4o-mini',
  quota: {
    plan_tier: 'pro',
    daily_limit: 5,
    used_today: 1,
    remaining_today: 4,
    byok_active: false,
    resets_at_shanghai: '2026-11-23 24:00 CST',
  },
}

const TEST_STOCK: StockDetail = {
  code: '600519',
  name: '贵州茅台',
  exchange: 'SH',
  industry_sw1: '食品饮料',
  industry_sw2: '白酒Ⅱ',
  list_date: '2001-08-27',
  is_st: false,
  is_active: true,
  snapshot_available: true,
}

const STANDARD_SNAPSHOT: StockSnapshotPayload = {
  schema_version: 1,
  code: '600519',
  name: '贵州茅台',
  exchange: 'SH',
  industry_sw1: '食品饮料',
  industry_sw2: '白酒Ⅱ',
  as_of: '2026-11-20',
  generated_at: '2026-11-20T10:00:00Z',
  data_source: 'akshare',
  annual_trends: [
    {
      year: 2024,
      revenue_yuan: 1.5e11,
      net_profit_yuan: 7.5e10,
      deduct_net_profit_yuan: 7.45e10,
      ocf_yuan: 8.1e10,
      fcf_yuan: 7.8e10,
      roe_pct: 31.2,
      gross_margin_pct: 91.8,
      net_margin_pct: 50.0,
      net_cash_yuan: 1.6e11,
      rd_ratio_pct: 0.42,
    },
    {
      year: 2025,
      revenue_yuan: 1.74e11,
      net_profit_yuan: 8.6e10,
      deduct_net_profit_yuan: 8.55e10,
      ocf_yuan: 9.2e10,
      fcf_yuan: 8.9e10,
      roe_pct: 32.5,
      gross_margin_pct: 92.1,
      net_margin_pct: 49.4,
      net_cash_yuan: 1.85e11,
      rd_ratio_pct: 0.45,
    },
  ],
  valuation: {
    latest_trade_date: '2026-11-20',
    close: 1520.0,
    total_mv_yuan: 1.91e12,
    pe_ttm: 22.1,
    pe_percentile_5y: 18.4,
    pe_percentile_10y: 26.5,
    pb: 7.8,
    pb_percentile_10y: 24.0,
    dividend_yield_pct: 3.45,
    graham_number: 1380.5,
    graham_margin_pct: -10.11,
    peg: 1.38,
    history: [
      { trade_date: '2025-11-20', close: 1480.0, pe_ttm: 21.8, pb: 7.5, total_mv_yuan: 1.86e12 },
      { trade_date: '2026-11-20', close: 1520.0, pe_ttm: 22.1, pb: 7.8, total_mv_yuan: 1.91e12 },
    ],
  },
  reverse_dcf: {
    solvable: true,
    note: '当前市值隐含未来 10 年 FCF 年化增速约 8.42%。',
    market_cap_yuan: 1.91e12,
    enterprise_value_yuan: 1.725e12,
    net_cash_yuan: 1.85e11,
    base_fcf_yuan: 8.35e10,
    base_fcf_years: 3,
    discount_rate_pct: 9.0,
    terminal_multiple: 12.0,
    implied_fcf_cagr_pct: 8.42,
    historical_revenue_cagr_pct: 14.8,
    implied_vs_history_gap_pct: -6.38,
    sensitivity: [
      { discount_rate_pct: 8.0, terminal_multiple: 10.0, implied_fcf_cagr_pct: 8.15 },
      { discount_rate_pct: 9.0, terminal_multiple: 12.0, implied_fcf_cagr_pct: 8.42 },
      { discount_rate_pct: 10.0, terminal_multiple: 15.0, implied_fcf_cagr_pct: 8.4 },
    ],
  },
  financial_ct: {
    overall_status: 'yellow',
    red_count: 0,
    yellow_count: 1,
    green_count: 6,
    checks: [
      {
        rule_id: 'dual_high_cash_debt',
        title: '存贷双高扫描',
        status: 'green',
        summary: '货币资金充沛且有息负债极低。',
        threshold: '货币资金/总资产 >= 25% 且 有息负债/总资产 >= 25%',
        value_text: '现金占比 58.2% / 负债占比 0.4%',
        evidences: [
          {
            year: 2025,
            label: '2025 年报存贷对照',
            metrics: {
              monetary_funds_yuan: 1.86e11,
              interest_debt_yuan: 1.2e9,
              cash_to_assets_pct: 58.2,
              debt_to_assets_pct: 0.4,
            },
          },
        ],
      },
      {
        rule_id: 'stalled_cip',
        title: '在建工程不转固',
        status: 'green',
        summary: '在建工程占比可控。',
        threshold: '连续3年在建工程/总资产 >= 10%',
        value_text: '2.1%',
        evidences: [],
      },
      {
        rule_id: 'ocf_profit_divergence',
        title: '现金流与利润背离',
        status: 'green',
        summary: '经营现金流连续高于归母净利润。',
        threshold: '近3年平均净现比 < 0.8',
        value_text: '1.07x',
        evidences: [],
      },
      {
        rule_id: 'receivable_inventory_bloat',
        title: '应收与存货膨胀',
        status: 'yellow',
        summary: '基酒存货温和上升。',
        threshold: '两金增速显著高于营收增速',
        value_text: '+4.2%',
        evidences: [
          {
            year: 2025,
            label: '2025 两金对照',
            metrics: {
              receivable_yuan: 1.1e9,
              inventory_yuan: 5.2e10,
              tied_to_revenue_pct: 30.5,
              growth_gap_pct: 4.2,
            },
          },
        ],
      },
      {
        rule_id: 'goodwill_overhang',
        title: '商誉减值悬顶',
        status: 'green',
        summary: '无商誉包袱。',
        threshold: '商誉/归母净资产 >= 20%',
        value_text: '0.00%',
        evidences: [],
      },
      {
        rule_id: 'shareholder_pledge',
        title: '大股东股权质押',
        status: 'green',
        summary: '质押比例极低。',
        threshold: '质押比例 >= 15%',
        value_text: '0.00%',
        evidences: [],
      },
      {
        rule_id: 'audit_opinion',
        title: '审计意见扫描',
        status: 'green',
        summary: '标准无保留审计意见。',
        threshold: '非标意见红灯',
        value_text: '标准无保留意见',
        evidences: [
          {
            year: 2025,
            label: '2025 审计意见',
            metrics: { audit_opinion: '标准无保留意见' },
          },
        ],
      },
    ],
  },
  shareholder_return: {
    window_years: 5,
    total_dividend_yuan: 2.6e11,
    total_repurchase_yuan: 6e9,
    total_equity_financing_yuan: 0,
    net_return_yuan: 2.66e11,
    total_fcf_yuan: 3.5e11,
    fcf_coverage_ratio: 1.32,
    current_dividend_yield_pct: 3.45,
    status: 'green',
    verdict: '近 5 年累计净回馈 2,660 亿元。',
    series: [
      {
        year: 2025,
        dividend_yuan: 6.4e10,
        repurchase_yuan: 6e9,
        equity_financing_yuan: 0,
        net_return_yuan: 7.0e10,
        fcf_yuan: 8.9e10,
      },
    ],
  },
  moat: {
    roe_5y_avg_pct: 31.8,
    roe_10y_min_pct: 25.4,
    gross_margin_latest_pct: 92.1,
    gross_margin_5y_std_pct: 0.35,
    roic_approx_pct: 34.6,
    dimensions: [
      {
        key: 'pricing_power',
        label: '毛利率与定价权',
        score: 96,
        summary: '毛利率长期稳定在 91% 以上。',
      },
      {
        key: 'capital_efficiency',
        label: '资本效率',
        score: 92,
        summary: '近似 ROIC 持续领先。',
      },
    ],
  },
  growth: {
    revenue_cagr_3y_pct: 15.2,
    revenue_cagr_5y_pct: 14.8,
    profit_cagr_5y_pct: 16.1,
    deduct_profit_cagr_5y_pct: 15.9,
    rd_ratio_latest_pct: 0.45,
    capex_to_ocf_latest_pct: 3.26,
  },
  radar: {
    scoring_profile: 'standard',
    profitability: 95,
    moat: 94,
    balance_sheet: 92,
    cashflow_quality: 90,
    valuation_margin: 74,
    total_score: 89,
    bear_cases: ['宏观商务消费景气度受周期影响。'],
  },
  peer_metrics: {
    code: '600519',
    name: '贵州茅台',
    exchange: 'SH',
    industry_sw1: '食品饮料',
    as_of: '2026-11-20',
    close: 1520.0,
    total_mv_yuan: 1.91e12,
    pe_ttm: 22.1,
    pe_percentile_10y: 26.5,
    pb: 7.8,
    roe_5y_avg_pct: 31.8,
    gross_margin_latest_pct: 92.1,
    net_cash_to_mv_pct: 9.69,
    ocf_to_profit_5y_pct: 107.2,
    shareholder_yield_pct: 3.66,
    implied_fcf_cagr_pct: 8.42,
    ct_red_count: 0,
    ct_yellow_count: 1,
    total_score: 89,
    is_financial: false,
  },
  pledge_ratio_pct: 0.0,
  pledge_date: '2026-11-20',
  latest_audit_opinion: '标准无保留意见',
  formula_notes: {
    radar: '五维雷达按确定性定量规则映射至 0–100 分。',
    reverse_dcf: '逆向 DCF 仅反推隐含增速，不输出主观目标价。',
  },
}

const FINANCIAL_SNAPSHOT: StockSnapshotPayload = {
  ...STANDARD_SNAPSHOT,
  code: '600036',
  name: '招商银行',
  industry_sw1: '银行',
  industry_sw2: '股份制银行Ⅱ',
  valuation: {
    ...STANDARD_SNAPSHOT.valuation,
    close: 38.5,
    pe_ttm: 6.2,
    pb: 0.92,
    pb_percentile_10y: 18.0,
    dividend_yield_pct: 5.4,
  },
  reverse_dcf: {
    ...STANDARD_SNAPSHOT.reverse_dcf,
    solvable: false,
    note: '金融行业采用 PB / ROE 与股息率评估。',
    enterprise_value_yuan: null,
    base_fcf_yuan: null,
    implied_fcf_cagr_pct: null,
    sensitivity: [],
  },
  radar: {
    ...STANDARD_SNAPSHOT.radar,
    scoring_profile: 'financial',
    dimension_labels: {
      profitability: '盈利能力',
      moat: '护城河',
      balance_sheet: '资产负债',
      cashflow_quality: '资本与分红耐力',
      valuation_margin: '估值安全边际',
    },
  },
  peer_metrics: {
    ...STANDARD_SNAPSHOT.peer_metrics,
    code: '600036',
    name: '招商银行',
    industry_sw1: '银行',
    is_financial: true,
  },
}

function renderWithProviders(ui: ReactElement) {
  const client = createQueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function asRequest(input: RequestInfo | URL): Request {
  if (input instanceof Request) {
    return input
  }
  throw new Error('Expected Request instance')
}

function assertNoNestedInteractiveTriggers(container: HTMLElement) {
  expect(container.querySelectorAll('button button')).toHaveLength(0)
  expect(container.querySelectorAll('label button')).toHaveLength(0)
}

describe('Stock detail tabs glossary tooltips', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('wires ? tooltips across Overview, Financials, Moat, Growth, and Institutions tabs without breaking label queries', () => {
    const overview = renderWithProviders(<StockOverviewTab snapshot={STANDARD_SNAPSHOT} />)
    assertNoNestedInteractiveTriggers(overview.container)

    expect(screen.getByText('五维定量雷达评分').tagName).toBe('SPAN')
    expect(screen.getByText('现金流质量').tagName).toBe('SPAN')
    expect(screen.getByRole('button', { name: '解释：五维定量雷达评分' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：2D 雷达图 / 3D 奇点球' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：盈利能力维度' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：护城河维度' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：资产负债维度' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：现金流质量维度' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：估值安全边际维度' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：最新收盘价' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：总市值' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：5年平均 ROE' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：排雷与股东回报' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：空头视角与核心风险提示' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：方法论与口径说明书' })).toBeInTheDocument()

    vi.useFakeTimers()
    fireEvent.mouseEnter(screen.getByRole('button', { name: '解释：现金流质量维度' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(GLOSSARY.radar_cashflow.summary)
    fireEvent.mouseLeave(screen.getByRole('button', { name: '解释：现金流质量维度' }))
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    vi.useRealTimers()
    overview.unmount()

    const financialOverview = renderWithProviders(
      <StockOverviewTab snapshot={FINANCIAL_SNAPSHOT} />,
    )
    assertNoNestedInteractiveTriggers(financialOverview.container)
    expect(screen.getByText('资本与分红耐力').tagName).toBe('SPAN')
    expect(screen.queryByText('现金流质量')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：资本与分红耐力' })).toBeInTheDocument()
    financialOverview.unmount()

    const financials = renderWithProviders(<StockFinancialsTab snapshot={STANDARD_SNAPSHOT} />)
    assertNoNestedInteractiveTriggers(financials.container)
    expect(screen.getByText('营业收入').tagName).toBe('SPAN')
    expect(screen.getByRole('button', { name: '解释：十年财务趋势图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：历年核心财务明细' })).toBeInTheDocument()
    for (const label of [
      '营业收入',
      '归母净利润',
      '扣非净利润',
      '经营现金流 (OCF)',
      '自由现金流 (FCF)',
      '净资产收益率 (ROE)',
      '毛利率',
      '净利率',
      '净现金',
    ]) {
      expect(screen.getByRole('button', { name: `解释：${label}` })).toBeInTheDocument()
    }
    financials.unmount()

    const moat = renderWithProviders(<StockMoatTab snapshot={STANDARD_SNAPSHOT} />)
    assertNoNestedInteractiveTriggers(moat.container)
    expect(screen.getByText('毛利率与定价权').tagName).toBe('STRONG')
    expect(screen.getByRole('button', { name: '解释：护城河资本回报核心指标' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：10年最低 ROE' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：最新毛利率' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：5年毛利率标准差' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '解释：近似投入资本回报率 (ROIC)' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：护城河分项评估' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：毛利率与定价权' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：资本效率' })).toBeInTheDocument()
    moat.unmount()

    const growth = renderWithProviders(<StockGrowthTab snapshot={STANDARD_SNAPSHOT} />)
    assertNoNestedInteractiveTriggers(growth.container)
    expect(screen.getByRole('button', { name: '解释：增长引擎与再投资效率' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：3年营收 CAGR' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：历史营收 CAGR 参考' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：5年归母净利润 CAGR' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：5年扣非净利润 CAGR' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：研发费用率' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：资本开支 / 经营现金流' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '解释：利润率与研发投入强度走势' }),
    ).toBeInTheDocument()
    growth.unmount()

    const institutions = renderWithProviders(<StockInstitutionsTab snapshot={STANDARD_SNAPSHOT} />)
    assertNoNestedInteractiveTriggers(institutions.container)
    expect(screen.getByRole('button', { name: '解释：机构风控视角' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：全市场股权质押比例' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：最新年报审计意见' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：5年 OCF / 净利润' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：净现金 / 总市值' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：同行横向排位对照' })).toBeInTheDocument()
    institutions.unmount()
  })

  it('wires ? tooltips across Valuation and Governance tabs while preserving slider labels and metric selectors', () => {
    const valuation = renderWithProviders(<StockValuationTab snapshot={STANDARD_SNAPSHOT} />)
    assertNoNestedInteractiveTriggers(valuation.container)

    expect(screen.getByLabelText('折现率 WACC (%)')).toHaveAttribute('type', 'range')
    expect(screen.getByLabelText('终值倍数 (x)')).toHaveAttribute('type', 'range')
    expect(
      screen.getByText('市场隐含 10Y FCF CAGR').parentElement?.querySelector('.metric-value'),
    ).toHaveTextContent('+8.42%')

    for (const label of [
      '10Y PE / PB 分位',
      'PE (TTM)',
      'PB (市净率)',
      '格雷厄姆数字',
      'PEG & 股息率',
      '历史 PE(TTM) 与总市值走势',
      'Reverse DCF 逆向估值反推器',
      '总市值',
      '净现金',
      '企业价值 (EV)',
      '基准 FCF（多年均值）',
      '交互式参数敏感性推演',
      '折现率 (WACC)',
      '第 10 年终值倍数',
      'Reverse DCF 隐含 FCF 增速',
      '历史营收 CAGR 参考',
      '隐含增速 − 历史增速',
      'WACC × 终值倍数敏感性矩阵',
      'WACC \\ 终值倍数',
    ]) {
      expect(screen.getByRole('button', { name: `解释：${label}` })).toBeInTheDocument()
    }

    fireEvent.mouseEnter(screen.getByRole('button', { name: '解释：格雷厄姆数字' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(GLOSSARY.graham_number.formula)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    valuation.unmount()

    const financialVal = renderWithProviders(<StockValuationTab snapshot={FINANCIAL_SNAPSHOT} />)
    assertNoNestedInteractiveTriggers(financialVal.container)
    expect(screen.getAllByRole('button', { name: '解释：PB-ROE 隐含长期回报参考' })).toHaveLength(3)
    expect(screen.getByRole('button', { name: '解释：当前股息率' })).toBeInTheDocument()
    financialVal.unmount()

    const governance = renderWithProviders(<StockGovernanceTab snapshot={STANDARD_SNAPSHOT} />)
    assertNoNestedInteractiveTriggers(governance.container)
    expect(screen.getByRole('button', { name: '解释：股东净回报体检器' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：累计现金分红' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：累计股份回购' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：累计股权再融资' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '解释：股东净回报' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: '解释：累计自由现金流' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：FCF 覆盖倍数' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：当前股息率' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：现金分红' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：股份回购' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：股权再融资' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：自由现金流' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：年度股东回报趋势图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：历年股东净回报明细' })).toBeInTheDocument()
    governance.unmount()
  })

  it('wires ? tooltips across ClearTruth CT rules, expanded evidence headers, MD&A diff, and Decision tab', async () => {
    const mdaResponse: MdaDiffResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      previous_period_label: '2024年报',
      current_period_label: '2025年报',
      mode: 'deterministic',
      summary: '识别到毛利率及存货口径波动。',
      metric_shifts: [
        {
          metric_label: '毛利率变化',
          previous_text: '91.80%',
          current_text: '92.10%',
          delta_text: '+0.30 pct',
          severity: 'green',
          interpretation: '毛利率保持高位稳定。',
        },
      ],
      text_highlights: [],
      quota: TEST_AI_PREFS.quota,
      compliance_notice: '仅供研究复盘，不构成投资建议。',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse(TEST_TOKEN, 200))
      }
      if (pathname === '/api/auth/me') {
        return Promise.resolve(jsonResponse(TEST_USER, 200))
      }
      if (pathname === '/api/ai/preferences') {
        return Promise.resolve(jsonResponse(TEST_AI_PREFS, 200))
      }
      if (pathname === '/api/journal') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/ai/mda-diff' && request.method === 'POST') {
        return Promise.resolve(jsonResponse(mdaResponse, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const ctView = renderWithProviders(<StockCtTab snapshot={STANDARD_SNAPSHOT} />)
    assertNoNestedInteractiveTriggers(ctView.container)

    expect(await screen.findByText('年报 MD&A 口径变化对比器 · 贵州茅台')).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: '解释：平台 AI 每日额度与 BYOK' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：AI 执行模式切换' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：财务排雷 CT 机' })).toBeInTheDocument()

    for (const ruleLabel of [
      '存贷双高扫描',
      '在建工程不转固',
      '现金流与利润背离',
      '应收与存货膨胀',
      '商誉减值悬顶',
      '大股东股权质押',
      '审计意见扫描',
    ]) {
      expect(screen.getByRole('button', { name: `解释：${ruleLabel}` })).toBeInTheDocument()
    }

    const expandBtns = screen.getAllByRole('button', { name: /展开历年证据/ })
    for (const btn of expandBtns) {
      fireEvent.click(btn)
    }
    expect(screen.getAllByRole('button', { name: '解释：摘要口径' })).toHaveLength(3)
    for (const colLabel of [
      '货币资金',
      '有息负债',
      '货币资金/总资产',
      '有息负债/总资产',
      '应收票据及账款',
      '存货',
      '两金/营收',
      '两金增速−营收增速',
      '审计意见',
    ]) {
      expect(screen.getByRole('button', { name: `解释：${colLabel}` })).toBeInTheDocument()
    }

    expect(screen.getByLabelText('上期报告标签')).toHaveValue('上期年报')
    expect(screen.getByLabelText('本期报告标签')).toHaveValue('本期年报')
    expect(screen.getByRole('button', { name: '解释：上期报告标签' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：本期报告标签' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：上期 MD&A 原文' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：本期 MD&A 原文' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '运行 MD&A 口径对比' }))
    expect(await screen.findByText('对比结论摘要')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：结构化口径指标变动' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：MD&A 文本措辞差异' })).toBeInTheDocument()
    assertNoNestedInteractiveTriggers(ctView.container)
    ctView.unmount()

    const decisionView = renderWithProviders(
      <StockDecisionTab stock={TEST_STOCK} snapshot={STANDARD_SNAPSHOT} />,
    )
    expect(await screen.findByLabelText('决策动作')).toBeInTheDocument()
    assertNoNestedInteractiveTriggers(decisionView.container)

    for (const fieldLabel of [
      '决策动作',
      '当前情绪',
      '参考价格（元）',
      '最大可承受回撤（%）',
      '投资理由',
      '否证条件',
    ]) {
      expect(screen.getByLabelText(fieldLabel)).toBeInTheDocument()
    }

    expect(screen.getByRole('button', { name: '解释：实时估值参考锚点' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：时间胶囊' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：决策情绪标签' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：参考价格（元）' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：最大可承受回撤（%）' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：投资理由' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：书面否证条件' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：买入前反方质询' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '解释：决策日记' }).length).toBeGreaterThanOrEqual(
      2,
    )
    expect(
      screen.getAllByRole('button', { name: '解释：量化否证红线' }).length,
    ).toBeGreaterThanOrEqual(2)

    fireEvent.mouseEnter(screen.getByRole('button', { name: '解释：买入前反方质询' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(GLOSSARY.devils_advocate.summary)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    decisionView.unmount()
  })
})
