import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartOption } from '../../lib/charts'
import { CHART_COLORS, LIGHT_CHART_COLORS } from '../../lib/chartTheme'
import { GLOSSARY } from '../../lib/glossary'
import { createQueryClient } from '../../lib/queryClient'
import { applyTheme } from '../../lib/theme'
import type { StockForensicsSection, StockSnapshotPayload } from '../../types/api'
import { StockForensicsTab } from './StockForensicsTab'
import {
  FORMULA_NOTE_TITLES,
  getEarningsQualityBadgeMeta,
  getForensicBridgeStepClass,
  getForensicCautionAlertState,
} from './stockHelpers'

const capturedChartOptions = new Map<string, ChartOption>()

vi.mock('../../lib/charts', () => ({
  Chart: ({ ariaLabel, option }: { ariaLabel?: string; option: ChartOption }) => {
    if (ariaLabel) {
      capturedChartOptions.set(ariaLabel, option)
    }
    return <div role="img" aria-label={ariaLabel} />
  },
}))

const BASE_SNAPSHOT: StockSnapshotPayload = {
  schema_version: 1,
  code: '600177',
  name: '雅戈尔',
  exchange: 'SH',
  industry_sw1: '纺织服饰',
  industry_sw2: '服装家纺',
  as_of: '2026-11-20',
  generated_at: '2026-11-20T10:00:00Z',
  data_source: 'akshare',
  annual_trends: [],
  valuation: {
    latest_trade_date: '2026-11-20',
    close: 7.95,
    total_mv_yuan: 3.68e10,
    pe_ttm: 9.8,
    pe_percentile_5y: 28.0,
    pe_percentile_10y: 32.0,
    pb: 0.92,
    pb_percentile_10y: 25.0,
    dividend_yield_pct: 5.5,
    graham_number: 10.2,
    graham_margin_pct: 22.0,
    peg: 1.1,
    history: [],
  },
  reverse_dcf: {
    solvable: true,
    note: '基准反推说明',
    market_cap_yuan: 3.68e10,
    enterprise_value_yuan: 4.1e10,
    net_cash_yuan: -4.2e9,
    base_fcf_yuan: 2.5e9,
    base_fcf_years: 3,
    discount_rate_pct: 9.0,
    terminal_multiple: 12.0,
    implied_fcf_cagr_pct: 4.1,
    historical_revenue_cagr_pct: 3.2,
    implied_vs_history_gap_pct: 0.9,
    sensitivity: [],
  },
  financial_ct: {
    overall_status: 'green',
    red_count: 0,
    yellow_count: 0,
    green_count: 7,
    checks: [],
  },
  shareholder_return: {
    window_years: 5,
    total_dividend_yuan: 1.1e10,
    total_repurchase_yuan: 0,
    total_equity_financing_yuan: 0,
    net_return_yuan: 1.1e10,
    total_fcf_yuan: 1.4e10,
    fcf_coverage_ratio: 1.27,
    current_dividend_yield_pct: 5.5,
    status: 'green',
    verdict: '近 5 年累计净回馈 110 亿元。',
    series: [],
  },
  moat: {
    roe_5y_avg_pct: 11.8,
    roe_10y_min_pct: 7.4,
    gross_margin_latest_pct: 48.2,
    gross_margin_5y_std_pct: 2.1,
    roic_approx_pct: 6.4,
    dimensions: [],
  },
  growth: {
    revenue_cagr_3y_pct: 2.8,
    revenue_cagr_5y_pct: 3.2,
    profit_cagr_5y_pct: 1.5,
    deduct_profit_cagr_5y_pct: -2.4,
    rd_ratio_latest_pct: 0.8,
    capex_to_ocf_latest_pct: 18.0,
  },
  radar: {
    scoring_profile: 'standard',
    profitability: 62,
    moat: 58,
    balance_sheet: 60,
    cashflow_quality: 56,
    valuation_margin: 74,
    total_score: 62,
    bear_cases: ['投资组合市值波动显著大于主业服饰零售利润。'],
  },
  peer_metrics: {
    code: '600177',
    name: '雅戈尔',
    exchange: 'SH',
    industry_sw1: '纺织服饰',
    as_of: '2026-11-20',
    close: 7.95,
    total_mv_yuan: 3.68e10,
    pe_ttm: 9.8,
    pe_percentile_10y: 32.0,
    pb: 0.92,
    roe_5y_avg_pct: 11.8,
    gross_margin_latest_pct: 48.2,
    net_cash_to_mv_pct: -11.4,
    ocf_to_profit_5y_pct: 84.0,
    shareholder_yield_pct: 5.5,
    implied_fcf_cagr_pct: 4.1,
    ct_red_count: 0,
    ct_yellow_count: 0,
    total_score: 62,
    is_financial: false,
  },
  pledge_ratio_pct: 0.0,
  pledge_date: '2026-11-20',
  latest_audit_opinion: '标准无保留意见',
  formula_notes: {},
  forensics: null,
}

const INVESTMENT_DRIVEN_FORENSICS: StockForensicsSection = {
  earnings_quality_tag: 'investment_driven',
  earnings_quality_label: '盈利高度依赖对外投资',
  verdict:
    '近3年投资与公允价值变动收益占营业利润 64.2%，最新年报主业核心营业利润 11.20 亿元、投资及公允价值收益 22.80 亿元，表内金融与长期股权投资资产 385.00 亿元（占总资产 47.6%），需警惕投资波动掩盖主业真实盈利。',
  core_profit_share_3y_pct: 33.4,
  invest_profit_share_3y_pct: 64.2,
  non_recurring_share_3y_pct: 4.8,
  ocf_to_core_profit_3y_pct: 118.5,
  interest_burden_pct: 19.4,
  investment_assets_yuan: 3.85e10,
  investment_assets_ratio_pct: 47.6,
  dupont_roe_5y_avg_pct: 11.8,
  dupont_net_margin_5y_avg_pct: 23.5,
  dupont_asset_turnover_5y_avg: 0.24,
  dupont_equity_multiplier_5y_avg: 2.09,
  findings: [
    {
      finding_id: 'investment_reliance',
      title: '对外投资驱动诊断',
      status: 'red',
      headline: '盈利高度依赖对外投资',
      detail: '近3年投资与公允价值变动收益占营业利润 64.2%，表内投资类资产占总资产 47.6%。',
      metric_text: '投资收益占比 64.2%',
    },
    {
      finding_id: 'non_recurring_subsidy',
      title: '非经常性损益与补贴扫描',
      status: 'green',
      headline: '扣非与归母利润高度贴合',
      detail: '近3年扣非与归母利润差异较小，政府补助占比仅 4.8%。',
      metric_text: '非经/补贴占比 4.8%',
    },
    {
      finding_id: 'dupont_attribution',
      title: '杜邦三因子归因',
      status: 'yellow',
      headline: '资产周转率偏慢（大量资产沉淀于金融投资）',
      detail: '5年均值 ROE 11.8% = 净利率 23.5% × 周转率 0.24 × 权益乘数 2.09。',
      metric_text: 'ROE 11.8% / 乘数 2.09x',
    },
    {
      finding_id: 'capital_allocation',
      title: '五年资本配置归因',
      status: 'yellow',
      headline: '盈余留存·金融资产配置型',
      detail: '近5年 OCF 168.00 亿元，分红与回购 110.00 亿元，同时表内投资资产维持高位。',
      metric_text: '盈余留存·金融资产配置型',
    },
  ],
  annual_decomposition: [
    {
      year: 2024,
      revenue_yuan: 1.42e10,
      operate_profit_yuan: 3.1e9,
      core_operating_profit_yuan: 1.05e9,
      core_operating_margin_pct: 7.39,
      investment_and_fair_value_yuan: 1.92e9,
      invest_share_of_op_profit_pct: 61.9,
      subsidy_and_oneoff_yuan: 1.3e8,
      impairment_net_yuan: -8e7,
      net_profit_yuan: 2.75e9,
      deduct_net_profit_yuan: 2.61e9,
      ocf_yuan: 1.38e9,
    },
    {
      year: 2025,
      revenue_yuan: 1.51e10,
      operate_profit_yuan: 3.55e9,
      core_operating_profit_yuan: 1.12e9,
      core_operating_margin_pct: 7.42,
      investment_and_fair_value_yuan: 2.28e9,
      invest_share_of_op_profit_pct: 64.2,
      subsidy_and_oneoff_yuan: 1.5e8,
      impairment_net_yuan: -6e7,
      net_profit_yuan: 3.18e9,
      deduct_net_profit_yuan: 2.98e9,
      ocf_yuan: 1.49e9,
    },
  ],
  dupont_series: [
    {
      year: 2024,
      roe_pct: 10.6,
      net_margin_pct: 19.37,
      asset_turnover: 0.22,
      equity_multiplier: 2.12,
    },
    {
      year: 2025,
      roe_pct: 11.8,
      net_margin_pct: 21.06,
      asset_turnover: 0.24,
      equity_multiplier: 2.09,
    },
  ],
  capital_allocation: {
    window_years: 5,
    total_ocf_yuan: 1.68e10,
    total_capex_yuan: 2.9e9,
    capex_to_ocf_pct: 17.3,
    total_dividends_yuan: 1.05e10,
    total_repurchases_yuan: 5e8,
    total_equity_financing_yuan: 0,
    payout_to_ocf_pct: 65.5,
    net_debt_change_yuan: 1.2e9,
    ending_net_cash_yuan: -4.2e9,
    ending_investment_assets_yuan: 3.85e10,
    allocation_style: '盈余留存·金融资产配置型',
    summary:
      '近5年累计 OCF 168.00 亿元，CapEx/OCF 17.3%，分红回购/OCF 65.5%，同时长期留存高比例投资资产。',
  },
}

const CORE_CASH_COW_FORENSICS: StockForensicsSection = {
  earnings_quality_tag: 'core_cash_cow',
  earnings_quality_label: '主业造血现金牛',
  verdict:
    '近3年主业核心营业利润占比 98.4%、OCF 对核心利润转化率 107.2%，盈利纯度与现金流质量俱佳。',
  core_profit_share_3y_pct: 98.4,
  invest_profit_share_3y_pct: 0.6,
  non_recurring_share_3y_pct: 1.0,
  ocf_to_core_profit_3y_pct: 107.2,
  interest_burden_pct: 0.3,
  investment_assets_yuan: 8.5e8,
  investment_assets_ratio_pct: 0.3,
  dupont_roe_5y_avg_pct: 31.8,
  dupont_net_margin_5y_avg_pct: 49.4,
  dupont_asset_turnover_5y_avg: 0.56,
  dupont_equity_multiplier_5y_avg: 1.15,
  findings: [
    {
      finding_id: 'investment_reliance',
      title: '对外投资驱动诊断',
      status: 'green',
      headline: '主业自身造血主导',
      detail: '近3年主业核心营业利润占比达 98.4%，投资与公允价值贡献仅 0.6%。',
      metric_text: '投资收益占比 0.6%',
    },
  ],
  annual_decomposition: [],
  dupont_series: [],
  capital_allocation: {
    window_years: 5,
    total_ocf_yuan: 3.8e11,
    total_capex_yuan: 1.4e10,
    capex_to_ocf_pct: 3.7,
    total_dividends_yuan: 2.6e11,
    total_repurchases_yuan: 6e9,
    total_equity_financing_yuan: 0,
    payout_to_ocf_pct: 70.0,
    net_debt_change_yuan: -3.2e10,
    ending_net_cash_yuan: 1.85e11,
    ending_investment_assets_yuan: 8.5e8,
    allocation_style: '轻资产现金牛·高分红回报型',
    summary: '近5年经营现金流极度充沛，分红与回购持续稳健。',
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function renderForensicsTab(ui: ReactElement) {
  const client = createQueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
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

function getChartSeriesList(option: ChartOption | undefined): Record<string, unknown>[] {
  if (!isRecord(option) || !Array.isArray(option.series)) {
    return []
  }
  return option.series.filter(isRecord)
}

function callValueFormatter(tooltipObj: unknown, value: unknown): string | undefined {
  if (!isRecord(tooltipObj) || typeof tooltipObj.valueFormatter !== 'function') {
    return undefined
  }
  const output: unknown = Reflect.apply(tooltipObj.valueFormatter, undefined, [value, 0])
  return typeof output === 'string' ? output : undefined
}

function assertNoNestedInteractiveTriggers(container: HTMLElement) {
  expect(container.querySelectorAll('button button')).toHaveLength(0)
  expect(container.querySelectorAll('label button')).toHaveLength(0)
}

describe('StockForensicsTab', () => {
  afterEach(() => {
    cleanup()
    capturedChartOptions.clear()
    vi.restoreAllMocks()
    delete document.documentElement.dataset.theme
    window.localStorage.clear()
    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      configurable: true,
      writable: true,
    })
  })

  it('renders investment-driven forensic bridge, grouped profit bridge without stack, unit-aware formatters, DuPont attribution, and Capital Allocation with ? hints', () => {
    const snapshot: StockSnapshotPayload = {
      ...BASE_SNAPSHOT,
      forensics: INVESTMENT_DRIVEN_FORENSICS,
    }

    const { container } = renderForensicsTab(<StockForensicsTab snapshot={snapshot} />)
    assertNoNestedInteractiveTriggers(container)

    const qualityBadge = screen.getByText('盈利高度依赖对外投资', { selector: '.quality-badge' })
    expect(qualityBadge).toHaveClass('quality-badge-red')

    const verdictBox = screen
      .getByText(/需警惕投资波动掩盖主业真实盈利/)
      .closest('.discovery-verdict-box')
    expect(verdictBox).toHaveClass('discovery-verdict-red')

    const coreTile = screen.getByText('主业核心利润占比 (3Y)').closest('.forensic-bridge-step')
    expect(coreTile).not.toHaveClass('forensic-bridge-core')
    expect(coreTile).toHaveTextContent('33.4%')

    const investTile = screen.getByText('投资与公允价值占比 (3Y)').closest('.forensic-bridge-step')
    expect(investTile).toHaveClass('forensic-bridge-danger')
    expect(investTile).toHaveTextContent('64.2%')
    expect(investTile).toHaveTextContent('≥ 50% 触发高依赖红灯 · ≥ 20% 关注')

    const assetsTile = screen.getByText('表内投资类资产占比').closest('.forensic-bridge-step')
    expect(assetsTile).toHaveClass('forensic-bridge-danger')
    expect(assetsTile).toHaveTextContent('47.6%')
    expect(assetsTile).toHaveTextContent('385.00 亿元')

    expect(screen.getByText('118.5%')).toBeInTheDocument()
    expect(screen.getByText('19.4%')).toBeInTheDocument()
    expect(screen.getByText('利息/息税前核心利润 · ≥ 50% 红灯 / ≥ 25% 黄灯')).toBeInTheDocument()

    const investFindingCard = screen.getByText('对外投资驱动诊断').closest('.forensic-finding-card')
    expect(investFindingCard).toHaveClass('forensic-finding-red')
    expect(investFindingCard).toHaveTextContent('投资收益占比 64.2%')

    expect(screen.getByRole('img', { name: '年度利润构成拆解图' })).toBeInTheDocument()
    const bridgeChart = capturedChartOptions.get('年度利润构成拆解图')
    expect(bridgeChart).toMatchObject({
      tooltip: { trigger: 'axis' },
      series: [
        {
          name: '主业核心经营利润',
          type: 'bar',
          itemStyle: { color: CHART_COLORS.positive },
        },
        {
          name: '投资收益与公允价值',
          type: 'bar',
          itemStyle: { color: CHART_COLORS.amber },
        },
        {
          name: '补贴与一次性损益',
          type: 'bar',
          itemStyle: { color: CHART_COLORS.negative },
        },
        {
          name: '营业利润',
          type: 'line',
          itemStyle: { color: CHART_COLORS.white },
          data: [31, 35.5],
        },
        {
          name: '归母净利润',
          type: 'line',
          itemStyle: { color: CHART_COLORS.electric },
        },
        {
          name: '经营现金流 OCF',
          type: 'line',
          itemStyle: { color: CHART_COLORS.violet },
        },
      ],
    })
    const bridgeSeries = getChartSeriesList(bridgeChart)
    expect(bridgeSeries).toHaveLength(6)
    for (const barSeries of bridgeSeries.slice(0, 3)) {
      expect(barSeries).not.toHaveProperty('stack')
    }
    const bridgeTooltip = isRecord(bridgeChart) ? bridgeChart.tooltip : undefined
    expect(callValueFormatter(bridgeTooltip, 11.2)).toBe('11.20 亿')
    expect(callValueFormatter(bridgeTooltip, -4.2)).toBe('-4.20 亿')
    expect(callValueFormatter(bridgeTooltip, null)).toBe('—')
    expect(callValueFormatter(bridgeTooltip, Number.NaN)).toBe('—')

    const decompTable = screen.getByRole('table', { name: '年度利润构成拆解明细表' })
    expect(decompTable).toHaveClass('pro-table')
    expect(within(decompTable).getByText('151.00')).toBeInTheDocument()
    expect(within(decompTable).getByText('11.20')).toBeInTheDocument()
    expect(within(decompTable).getByText('7.42%')).toBeInTheDocument()
    expect(within(decompTable).getByText('22.80')).toBeInTheDocument()

    expect(screen.getByRole('img', { name: '杜邦三因子趋势图' })).toBeInTheDocument()
    const dupontChart = capturedChartOptions.get('杜邦三因子趋势图')
    expect(dupontChart).toMatchObject({
      tooltip: { trigger: 'axis' },
      yAxis: [{ name: '%' }, { name: '倍数 / 次' }],
      series: [
        { name: 'ROE (%)', type: 'bar', itemStyle: { color: CHART_COLORS.positive } },
        { name: '销售净利率 (%)', type: 'line', itemStyle: { color: CHART_COLORS.electric } },
        {
          name: '总资产周转率 (次)',
          type: 'line',
          yAxisIndex: 1,
          itemStyle: { color: CHART_COLORS.amber },
        },
        {
          name: '权益乘数 (x)',
          type: 'line',
          yAxisIndex: 1,
          itemStyle: { color: CHART_COLORS.violet },
        },
      ],
    })
    const dupontSeries = getChartSeriesList(dupontChart)
    expect(callValueFormatter(dupontSeries[0]?.tooltip, 11.8)).toBe('11.80%')
    expect(callValueFormatter(dupontSeries[1]?.tooltip, 21.06)).toBe('21.06%')
    expect(callValueFormatter(dupontSeries[2]?.tooltip, 0.24)).toBe('0.24 次')
    expect(callValueFormatter(dupontSeries[3]?.tooltip, 2.09)).toBe('2.09 倍')
    expect(callValueFormatter(dupontSeries[2]?.tooltip, null)).toBe('—')
    expect(callValueFormatter(dupontSeries[3]?.tooltip, Number.NaN)).toBe('—')

    const dupontTable = screen.getByRole('table', { name: '杜邦三因子历年明细表' })
    expect(dupontTable).toHaveClass('pro-table')
    expect(screen.getAllByText('0.24 次')).toHaveLength(2)
    expect(screen.getAllByText('2.09x')).toHaveLength(2)
    expect(within(dupontTable).getByText('0.22 次')).toBeInTheDocument()
    expect(within(dupontTable).getByText('2.12x')).toBeInTheDocument()

    expect(screen.getByText('168.00 亿元')).toBeInTheDocument()
    expect(screen.getByText('29.00 亿元')).toBeInTheDocument()
    expect(screen.getByText('CapEx/OCF 17.3%')).toBeInTheDocument()
    expect(screen.getByText('110.00 亿元')).toBeInTheDocument()
    expect(screen.getByText(/回馈\/OCF 65.5%/)).toBeInTheDocument()
    expect(screen.getByText('-42.00 亿元')).toBeInTheDocument()

    for (const label of [
      '利润含金量深度鉴真',
      '主业核心经营利润',
      '近3年投资收益占营业利润比',
      '投资收益与公允价值变动',
      '政府补贴与一次性损益',
      '表内投资类资产占比',
      'OCF / 主业核心利润',
      '利息负担率',
      '营业收入',
      '归母净利润',
      '净资产收益率 (ROE)',
      '杜邦三因子归因',
      '5年平均 ROE',
      '净利率',
      '总资产周转率',
      '权益乘数',
      '近5年资本配置画像',
      '经营现金流 (OCF)',
      '资本开支 / 经营现金流',
      '股东净回报',
      '净现金',
      '对外投资驱动诊断',
      '非经常性损益与补贴扫描',
      '五年资本配置归因',
    ]) {
      expect(
        screen.getAllByRole('button', { name: `解释：${label}` }).length,
        `missing ? tooltip for ${label}`,
      ).toBeGreaterThanOrEqual(1)
    }

    const dupontHintBtn = screen.getAllByRole('button', { name: '解释：杜邦三因子归因' })[1]
    expect(dupontHintBtn).toBeDefined()
    if (dupontHintBtn) {
      fireEvent.mouseEnter(dupontHintBtn)
    }
    expect(screen.getByRole('tooltip')).toHaveTextContent(GLOSSARY.dupont_attribution.formula)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    act(() => {
      applyTheme('light')
    })
    expect(capturedChartOptions.get('年度利润构成拆解图')).toMatchObject({
      series: [
        { itemStyle: { color: LIGHT_CHART_COLORS.positive } },
        { itemStyle: { color: LIGHT_CHART_COLORS.amber } },
        { itemStyle: { color: LIGHT_CHART_COLORS.negative } },
        { itemStyle: { color: LIGHT_CHART_COLORS.white } },
        { itemStyle: { color: LIGHT_CHART_COLORS.electric } },
        { itemStyle: { color: LIGHT_CHART_COLORS.violet } },
      ],
    })
  })

  it('applies warning bridge class between 20% and 35% investment share, core green styling for core_cash_cow, and unified red tone for subsidy_inflated', () => {
    const warnSnapshot: StockSnapshotPayload = {
      ...BASE_SNAPSHOT,
      forensics: {
        ...INVESTMENT_DRIVEN_FORENSICS,
        earnings_quality_tag: 'balanced_steady',
        earnings_quality_label: '盈利结构稳健均衡',
        invest_profit_share_3y_pct: 24.5,
      },
    }
    const warnView = renderForensicsTab(<StockForensicsTab snapshot={warnSnapshot} />)
    const warnInvestTile = screen
      .getByText('投资与公允价值占比 (3Y)')
      .closest('.forensic-bridge-step')
    expect(warnInvestTile).toHaveClass('forensic-bridge-warn')
    expect(warnInvestTile).not.toHaveClass('forensic-bridge-danger')
    warnView.unmount()

    const subsidySnapshot: StockSnapshotPayload = {
      ...BASE_SNAPSHOT,
      forensics: {
        ...INVESTMENT_DRIVEN_FORENSICS,
        earnings_quality_tag: 'subsidy_inflated',
        earnings_quality_label: '补贴 / 一次性损益偏高',
        invest_profit_share_3y_pct: 4.2,
        non_recurring_share_3y_pct: 52.0,
        investment_assets_ratio_pct: 8.5,
      },
    }
    const subsidyView = renderForensicsTab(<StockForensicsTab snapshot={subsidySnapshot} />)
    assertNoNestedInteractiveTriggers(subsidyView.container)

    expect(screen.getByText('补贴 / 一次性损益偏高', { selector: '.quality-badge' })).toHaveClass(
      'quality-badge-red',
    )
    expect(
      screen.getByText(/需警惕投资波动掩盖主业真实盈利/).closest('.discovery-verdict-box'),
    ).toHaveClass('discovery-verdict-red')
    expect(getEarningsQualityBadgeMeta('subsidy_inflated')).toMatchObject({
      badgeClass: 'quality-badge quality-badge-red',
      verdictTone: 'red',
    })
    expect(getForensicCautionAlertState(subsidySnapshot.forensics)).toEqual({
      show: true,
      highSeverity: true,
    })
    subsidyView.unmount()

    const cashCowSnapshot: StockSnapshotPayload = {
      ...BASE_SNAPSHOT,
      code: '600519',
      name: '贵州茅台',
      forensics: CORE_CASH_COW_FORENSICS,
    }
    const cowView = renderForensicsTab(<StockForensicsTab snapshot={cashCowSnapshot} />)
    assertNoNestedInteractiveTriggers(cowView.container)

    expect(screen.getByText('主业造血现金牛', { selector: '.quality-badge' })).toHaveClass(
      'quality-badge-green',
    )
    expect(
      screen.getByText(/盈利纯度与现金流质量俱佳/).closest('.discovery-verdict-box'),
    ).toHaveClass('discovery-verdict-green')
    expect(screen.getByText('主业核心利润占比 (3Y)').closest('.forensic-bridge-step')).toHaveClass(
      'forensic-bridge-core',
    )
    expect(screen.getByText('暂无年度利润构成拆解数据')).toBeInTheDocument()
    expect(screen.getByText('暂无逐年杜邦三因子明细序列')).toBeInTheDocument()
  })

  it('renders resync CTA on legacy snapshots, posts force=true sync, recovers from failure, and triggers quick tab switches', async () => {
    const onSwitchTab = vi.fn()
    let resolveSync: ((res: Response) => void) | undefined
    let attempt = 0
    const requestedUrls: string[] = []

    const hydratedSnapshot: StockSnapshotPayload = {
      ...BASE_SNAPSHOT,
      forensics: INVESTMENT_DRIVEN_FORENSICS,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      requestedUrls.push(request.url)
      const url = new URL(request.url)
      if (
        url.pathname === '/api/stocks/600177/sync' &&
        url.searchParams.get('force') === 'true' &&
        request.method === 'POST'
      ) {
        attempt += 1
        if (attempt === 1) {
          return Promise.resolve(jsonResponse({ detail: '上游财报源暂时超时' }, 503))
        }
        return new Promise<Response>((resolve) => {
          resolveSync = resolve
        })
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    const { container } = renderForensicsTab(
      <StockForensicsTab
        snapshot={{ ...BASE_SNAPSHOT, forensics: null }}
        onSwitchTab={onSwitchTab}
      />,
    )
    assertNoNestedInteractiveTriggers(container)

    expect(screen.getByText('利润真相与资本归因')).toBeInTheDocument()
    expect(screen.getByText('当前快照暂未包含利润真相深拆字段')).toBeInTheDocument()
    expect(
      screen.getByText('等待后台同步升级全量财报字段，或进入「风险排雷 / 财务分析」查看基础科目。'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：利润含金量深度鉴真' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '查看财务分析' }))
    fireEvent.click(screen.getByRole('button', { name: '前往风险排雷' }))
    expect(onSwitchTab).toHaveBeenNthCalledWith(1, 'financials')
    expect(onSwitchTab).toHaveBeenNthCalledWith(2, 'risks')

    const resyncBtn = screen.getByRole('button', { name: '立即重算并刷新利润真相' })
    fireEvent.click(resyncBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('上游财报源暂时超时')
    expect(screen.getByRole('button', { name: '立即重算并刷新利润真相' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '立即重算并刷新利润真相' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '重算同步中...' })).toBeDisabled()
    })

    if (!resolveSync) {
      throw new Error('Expected pending sync resolver')
    }
    resolveSync(jsonResponse(hydratedSnapshot, 200))

    expect(await screen.findByText('利润含金量深度鉴真')).toBeInTheDocument()
    expect(
      screen.getByText('盈利高度依赖对外投资', { selector: '.quality-badge' }),
    ).toBeInTheDocument()
    expect(requestedUrls.some((u) => u.endsWith('/api/stocks/600177/sync?force=true'))).toBe(true)
  })

  it('exempts financial_special banks from caution alerts and danger/warn bridge styling while keeping Chinese formula titles', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 390,
      configurable: true,
      writable: true,
    })

    const bankForensics: StockForensicsSection = {
      earnings_quality_tag: 'financial_special',
      earnings_quality_label: '金融特殊结构',
      verdict: '金融行业特殊结构：近5年平均 ROE 14.2%，已豁免工业主业剥离与资产周转率惩罚。',
      core_profit_share_3y_pct: 80.0,
      invest_profit_share_3y_pct: 55.0,
      non_recurring_share_3y_pct: 48.0,
      ocf_to_core_profit_3y_pct: null,
      interest_burden_pct: null,
      investment_assets_yuan: 3.1e12,
      investment_assets_ratio_pct: 52.0,
      dupont_roe_5y_avg_pct: 14.2,
      dupont_net_margin_5y_avg_pct: 42.0,
      dupont_asset_turnover_5y_avg: null,
      dupont_equity_multiplier_5y_avg: 11.2,
      findings: [],
      annual_decomposition: INVESTMENT_DRIVEN_FORENSICS.annual_decomposition,
      dupont_series: INVESTMENT_DRIVEN_FORENSICS.dupont_series,
      capital_allocation: null,
    }

    const financialSnapshot: StockSnapshotPayload = {
      ...BASE_SNAPSHOT,
      code: '600036',
      name: '招商银行',
      peer_metrics: {
        ...BASE_SNAPSHOT.peer_metrics,
        code: '600036',
        name: '招商银行',
        industry_sw1: '银行',
        is_financial: true,
      },
      forensics: bankForensics,
    }

    expect(getForensicCautionAlertState(bankForensics)).toEqual({
      show: false,
      highSeverity: false,
    })
    for (const kind of ['core', 'invest', 'subsidy', 'assets'] as const) {
      expect(getForensicBridgeStepClass(kind, 90, 'financial_special')).toBe('forensic-bridge-step')
    }
    expect(FORMULA_NOTE_TITLES.forensics).toBe('利润含金量与杜邦/资本配置口径')
    expect(FORMULA_NOTE_TITLES.financial_radar).toBe('金融业专项五维评价口径')

    const { container } = renderForensicsTab(<StockForensicsTab snapshot={financialSnapshot} />)

    expect(screen.getByText('金融特殊结构', { selector: '.quality-badge' })).toHaveClass(
      'quality-badge-blue',
    )
    expect(screen.getByText(/金融行业特殊结构/).closest('.discovery-verdict-box')).toHaveClass(
      'discovery-verdict-blue',
    )
    expect(screen.getByText('金融业豁免主业剥离')).toBeInTheDocument()
    expect(screen.getByText('金融业已豁免周转率对比')).toBeInTheDocument()
    expect(screen.getByText('暂无近5年资本配置画像')).toBeInTheDocument()

    expect(container.querySelectorAll('.forensic-bridge-danger')).toHaveLength(0)
    expect(container.querySelectorAll('.forensic-bridge-warn')).toHaveLength(0)
    expect(container.querySelectorAll('.forensic-bridge-core')).toHaveLength(0)

    expect(capturedChartOptions.get('年度利润构成拆解图')).toMatchObject({
      grid: { top: 72 },
      legend: { itemGap: 10, itemWidth: 14 },
    })
    expect(capturedChartOptions.get('杜邦三因子趋势图')).toMatchObject({
      grid: { top: 72 },
      legend: { itemGap: 10, itemWidth: 14 },
    })
  })
})
