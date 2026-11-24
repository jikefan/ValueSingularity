import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../lib/AuthProvider'
import { setAccessToken } from '../../lib/api'
import type { ChartOption } from '../../lib/charts'
import { GLOSSARY } from '../../lib/glossary'
import { createQueryClient } from '../../lib/queryClient'
import type {
  AiPreferences,
  AuthConfigResponse,
  DecisionLedgerReport,
  MarketOverview,
  NotificationPreferences,
  StockScreenerResponse,
  TokenResponse,
  UserProfile,
  WatchlistItem,
} from '../../types/api'
import { MePage } from '../me/MePage'
import { MarketPage } from './MarketPage'

vi.mock('../../lib/charts', () => ({
  Chart: ({ ariaLabel }: { ariaLabel?: string; option: ChartOption }) => (
    <div role="img" aria-label={ariaLabel} />
  ),
}))

const SAMPLE_OVERVIEW: MarketOverview = {
  schema_version: 1,
  as_of: '2026-11-18',
  data_source: 'akshare',
  generated_at: '2026-11-18T10:00:00Z',
  indices: [
    { code: '000001', name: '上证指数', price: 3218.42, change_pct: 0.62 },
    { code: '399001', name: '深证成指', price: 10142.07, change_pct: -0.34 },
  ],
  temperature: {
    score: 38.0,
    level: 'cool',
    pe_median: 24.6,
    pe_percentile: 31.0,
    bond_yield: 2.18,
    equity_bond_spread: 1.89,
    comment: '估值处于近十年偏低区间，股债性价比偏向股票。',
  },
  hot_industries: [
    { name: '食品饮料', change_pct: 2.41, net_inflow: 3.12e9, companies: 168 },
    { name: '银行', change_pct: -0.35, net_inflow: -6.1e8, companies: 42 },
  ],
}

const SAMPLE_SCREENER: StockScreenerResponse = {
  total_synced: 1,
  filtered_count: 1,
  industries: ['食品饮料'],
  items: [
    {
      code: '600519',
      name: '贵州茅台',
      exchange: 'SH',
      industry_sw1: '食品饮料',
      as_of: '2026-11-18',
      close: 1520,
      total_mv_yuan: 1.91e12,
      pe_ttm: 22.1,
      pe_percentile_10y: 26.5,
      pb: 7.8,
      pb_percentile_10y: 22.0,
      roe_5y_avg_pct: 31.8,
      dividend_yield_pct: 3.66,
      shareholder_yield_pct: 3.66,
      implied_fcf_cagr_pct: 8.4,
      ct_red_count: 0,
      ct_yellow_count: 1,
      ct_green_count: 10,
      total_score: 89,
      valuation_margin: 74,
      is_financial: false,
    },
  ],
}

const SAMPLE_USER: UserProfile = {
  id: '22222222-2222-2222-2222-222222222222',
  email: 'pro@example.com',
  phone: null,
  display_name: '长坡厚雪',
  email_verified: true,
  plan_tier: 'pro',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
}

const DEFAULT_AUTH_CONFIG: AuthConfigResponse = {
  email_verification_required: false,
  smtp_configured: false,
  code_ttl_minutes: 10,
  code_cooldown_seconds: 60,
}

const SAMPLE_WATCHLIST: WatchlistItem[] = [
  {
    code: '600519',
    name: '贵州茅台',
    industry: '白酒',
    note: '批价观察',
    target_price: 1400,
    target_pe_percentile: 20,
    target_dividend_yield: 3.5,
    alert_enabled: true,
    added_at: '2026-11-22T00:00:00Z',
    updated_at: '2026-11-22T00:00:00Z',
  },
]

const SAMPLE_AI_PREFS: AiPreferences = {
  prefer_rule_only: false,
  byok_enabled: false,
  byok_base_url_masked: null,
  byok_api_key_configured: false,
  byok_api_key_masked: null,
  byok_model: 'gpt-4o-mini',
  quota: {
    plan_tier: 'pro',
    daily_limit: 30,
    used_today: 2,
    remaining_today: 28,
    byok_active: false,
    resets_at_shanghai: '2026-11-23 24:00 CST',
  },
}

const SAMPLE_ALERT_PREFS: NotificationPreferences = {
  in_app_enabled: true,
  webhook_enabled: false,
  channel_type: 'feishu',
  webhook_url_configured: false,
  webhook_url_masked: null,
}

const SAMPLE_LEDGER: DecisionLedgerReport = {
  total_entries: 1,
  comparable_count: 1,
  win_count: 1,
  win_rate_pct: 100.0,
  avg_stock_return_pct: 12.5,
  avg_excess_return_pct: 8.2,
  pass_count: 0,
  pass_avoided_loss_count: 0,
  current_benchmark_code: '000300',
  current_benchmark_price: 3980.5,
  benchmark_as_of: '2026-11-22',
  by_emotion: [
    {
      emotion: '冷静',
      total_count: 1,
      comparable_count: 1,
      win_count: 1,
      win_rate_pct: 100.0,
      avg_stock_return_pct: 12.5,
      avg_excess_return_pct: 8.2,
    },
  ],
  by_action: [],
  items: [
    {
      id: 501,
      code: '600519',
      name: '贵州茅台',
      action: 'buy',
      emotion: '冷静',
      created_at: '2026-10-01T09:00:00Z',
      entry_price: 1400,
      current_price: 1575,
      stock_return_pct: 12.5,
      entry_benchmark_price: 3816.3,
      current_benchmark_price: 3980.5,
      benchmark_return_pct: 4.3,
      excess_return_pct: 8.2,
      entry_pe_ttm: 20.5,
      current_pe_ttm: 22.1,
      entry_score: 86,
      current_score: 89,
      days_held: 52,
      falsify_triggered: false,
      falsify_triggers: [],
    },
  ],
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
  for (const button of container.querySelectorAll('button')) {
    expect(button.querySelector('button')).toBeNull()
  }
  for (const label of container.querySelectorAll('label')) {
    expect(label.querySelector('button.info-hint-btn')).toBeNull()
  }
}

describe('MarketPage & MePage glossary tooltips', () => {
  afterEach(() => {
    cleanup()
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('wires all MarketPage glossary and custom ? triggers, opens hover popovers, and keeps buttons non-nested', async () => {
    let screenerCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/stocks/screener') {
        screenerCalls += 1
        return Promise.resolve(jsonResponse(SAMPLE_SCREENER))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    const client = createQueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<MarketPage />} />
            <Route path="/stock/:code" element={<div>个股详情</div>} />
            <Route path="/compare" element={<div>对比页</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('上证指数')).toBeInTheDocument()
    expect(await screen.findByRole('table', { name: '价值筛选结果明细表' })).toBeInTheDocument()
    assertNoNestedInteractiveTriggers(container)

    const expectedSingleLabels = [
      '解释：三步价值投资工作流',
      '解释：市场温度',
      '解释：全市场 PE 中位数',
      '解释：历史分位',
      '解释：十年国债收益率',
      '解释：股债性价比 (ERP)',
      '解释：上证指数',
      '解释：深证成指',
      '解释：行业资金流',
      '解释：净流入排行',
      '解释：行业涨跌幅',
      '解释：行业净流入',
      '解释：行业公司数',
      '解释：价值击球区精选雷达',
      '解释：仅看零红灯',
      '解释：PE 10Y 分位筛选',
      '解释：5Y ROE 筛选',
      '解释：股息率筛选',
      '解释：横向对比勾选',
      '解释：证券代码与简称',
    ]

    for (const label of expectedSingleLabels) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }

    expect(screen.getAllByRole('button', { name: '解释：申万一级行业' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：综合雷达评分' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：CT 排雷红黄灯' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：PE(TTM) / 10Y 分位' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：5年平均 ROE' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：股息率' })).toHaveLength(2)

    const erpTrigger = screen.getByRole('button', { name: '解释：股债性价比 (ERP)' })
    fireEvent.mouseEnter(erpTrigger)
    const erpTooltip = screen.getByRole('tooltip')
    expect(erpTooltip).toHaveTextContent(GLOSSARY.equity_bond_spread.summary)
    expect(erpTooltip).toHaveTextContent(GLOSSARY.equity_bond_spread.formula)
    expect(erpTooltip).toHaveTextContent(GLOSSARY.equity_bond_spread.reading)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    const netFlowTrigger = screen.getByRole('button', { name: '解释：净流入排行' })
    fireEvent.mouseEnter(netFlowTrigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('申万行业主力资金净流入金额排序')
    fireEvent.keyDown(document, { key: 'Escape' })

    const zeroRedFilterBtn = screen.getByRole('button', { name: '仅看零红灯' })
    const zeroRedHintBtn = screen.getByRole('button', { name: '解释：仅看零红灯' })
    const callsBeforeHintClick = screenerCalls
    fireEvent.click(zeroRedHintBtn)
    expect(screen.getByRole('tooltip')).toHaveTextContent(GLOSSARY.filter_zero_red.summary)
    expect(zeroRedFilterBtn).toHaveAttribute('aria-pressed', 'false')
    expect(screenerCalls).toBe(callsBeforeHintClick)
  })

  it('wires all MePage, AI Prefs, Sentinel Alerts, and Decision Ledger ? triggers without toggling checkboxes or controls', async () => {
    const tokenResponse: TokenResponse = {
      access_token: 'glossary-me-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return Promise.resolve(jsonResponse(tokenResponse, 200))
      }
      if (pathname === '/api/auth/config') {
        return Promise.resolve(jsonResponse(DEFAULT_AUTH_CONFIG, 200))
      }
      if (pathname === '/api/watchlist') {
        return Promise.resolve(jsonResponse(SAMPLE_WATCHLIST, 200))
      }
      if (pathname === '/api/journal') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/journal/ledger') {
        return Promise.resolve(jsonResponse(SAMPLE_LEDGER, 200))
      }
      if (pathname === '/api/alerts') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/alerts/preferences') {
        return Promise.resolve(jsonResponse(SAMPLE_ALERT_PREFS, 200))
      }
      if (pathname === '/api/ai/preferences') {
        return Promise.resolve(jsonResponse(SAMPLE_AI_PREFS, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const client = createQueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/me']}>
            <Routes>
              <Route path="/me" element={<MePage />} />
              <Route path="/stock/:code" element={<div>个股详情</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('贵州茅台')).toBeInTheDocument()
    expect(await screen.findByText('时间胶囊对照明细')).toBeInTheDocument()
    assertNoNestedInteractiveTriggers(container)

    const expectedSingleLabels = [
      '解释：投资账户与套餐额度',
      '解释：套餐与平台额度',
      '解释：平台每日调用配额',
      '解释：今日剩余额度',
      '解释：每日额度重置机制',
      '解释：纯规则兜底引擎',
      '解释：BYOK 模型名称',
      '解释：BYOK Base URL',
      '解释：BYOK API Key',
      '解释：股票代码',
      '解释：目标价',
      '解释：目标 PE 分位',
      '解释：目标股息率',
      '解释：站内提醒记录',
      '解释：推送渠道类型',
      '解释：Webhook URL 安全约束',
      '解释：决策质量账本',
      '解释：可比记录数',
      '解释：Pass 观察池避险',
      '解释：情绪胜率归因',
      '解释：记录数 / 可比数',
      '解释：时间胶囊',
      '解释：决策标的',
      '解释：记录天数',
      '解释：记录价 → 现价',
      '解释：区间绝对涨跌幅',
      '解释：PE / 评分变化',
      '解释：否证状态',
      '解释：决策日记',
      '解释：动作筛选与 Pass 观察池',
    ]

    for (const label of expectedSingleLabels) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }

    expect(screen.getAllByRole('button', { name: '解释：BYOK 自备密钥推理' })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: '解释：击球区阈值' })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: '解释：击球区哨兵' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：Webhook 外部推送' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：可比胜率' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：平均绝对收益' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：超额 Alpha' })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: '解释：沪深 300 基准' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '解释：决策情绪标签' })).toHaveLength(2)

    const quotaTrigger = screen.getByRole('button', { name: '解释：套餐与平台额度' })
    fireEvent.mouseEnter(quotaTrigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('FREE / PRO / AI_PLUS')
    fireEvent.keyDown(document, { key: 'Escape' })

    const targetPeTrigger = screen.getByRole('button', { name: '解释：目标 PE 分位' })
    fireEvent.mouseEnter(targetPeTrigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('当前 10Y PE 分位 ≤ 目标 PE 分位')
    fireEvent.keyDown(document, { key: 'Escape' })

    const sentinelCheckbox = screen.getByLabelText('开启击球区哨兵')
    expect(sentinelCheckbox).toBeChecked()
    const sentinelHints = screen.getAllByRole('button', { name: '解释：击球区哨兵' })
    const formSentinelHint = sentinelHints[0]
    expect(formSentinelHint).toBeDefined()
    if (formSentinelHint) {
      fireEvent.click(formSentinelHint)
    }
    expect(screen.getByRole('tooltip')).toHaveTextContent(GLOSSARY.strike_zone_sentinel.summary)
    expect(sentinelCheckbox).toBeChecked()
    fireEvent.keyDown(document, { key: 'Escape' })

    const inAppCheckbox = screen.getByLabelText('开启站内提醒记录')
    expect(inAppCheckbox).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '解释：站内提醒记录' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('作为最可靠的审计记录兜底')
    expect(inAppCheckbox).toBeChecked()
    fireEvent.keyDown(document, { key: 'Escape' })

    const ruleOnlyCheckbox = screen.getByLabelText('默认仅用纯规则引擎（不消耗额度）')
    expect(ruleOnlyCheckbox).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '解释：纯规则兜底引擎' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('本地确定性规则引擎')
    expect(ruleOnlyCheckbox).not.toBeChecked()
    fireEvent.keyDown(document, { key: 'Escape' })

    const prefsToggleBtn = screen.getByRole('button', { name: /推送渠道设置/ })
    expect(prefsToggleBtn).toHaveAttribute('aria-expanded', 'true')
    const webhookHints = screen.getAllByRole('button', { name: '解释：Webhook 外部推送' })
    const toggleSiblingHint = webhookHints[0]
    expect(toggleSiblingHint).toBeDefined()
    if (toggleSiblingHint) {
      fireEvent.click(toggleSiblingHint)
    }
    expect(screen.getByRole('tooltip')).toHaveTextContent(GLOSSARY.webhook_push.summary)
    expect(prefsToggleBtn).toHaveAttribute('aria-expanded', 'true')
  })
})
