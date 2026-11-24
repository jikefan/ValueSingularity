import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { GlossaryLabel } from '../../components/ui/InfoHint'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { api } from '../../lib/api'
import { getEarningsQualityBadgeMeta } from '../../lib/earningsQuality'
import { formatNum, formatPct, formatSignedPct, formatYi, qualityTone } from '../../lib/format'
import type { GlossaryKey } from '../../lib/glossary'
import { queryKeys } from '../../lib/queryKeys'
import {
  normalizeCompareCodes,
  useStockCompare,
  useStockScreener,
} from '../../lib/useStockAnalysis'
import type { StockCompareItem } from '../../types/api'

type ComparePreset = {
  label: string
  title: string
  subtitle: string
  codes: readonly [string, ...string[]]
}

const COMPARE_PRESETS: readonly ComparePreset[] = [
  {
    label: '白酒龙头对比 (600519/000858/000568)',
    title: '白酒龙头对比',
    subtitle: '高端消费与现金流标杆',
    codes: ['600519', '000858', '000568'],
  },
  {
    label: '高股息银行 (600036/601398/000001)',
    title: '高股息银行',
    subtitle: '低估值高分红红利代表',
    codes: ['600036', '601398', '000001'],
  },
  {
    label: '制造消费蓝筹 (000333/002594/600887)',
    title: '制造消费蓝筹',
    subtitle: '跨行业龙头护城河对照',
    codes: ['000333', '002594', '600887'],
  },
]
const MAX_COMPARE_CODES = 5
const CODE_PATTERN = /^[0-9]{6}$/

const FINANCIAL_SW1_INDUSTRIES = new Set(['银行', '非银金融', '保险', '证券', '多元金融'])

function isFinancialCompareItem(item: StockCompareItem): boolean {
  if (item.metrics) {
    return item.metrics.is_financial
  }
  const sw1 = item.meta.industry_sw1?.trim() ?? ''
  return FINANCIAL_SW1_INDUSTRIES.has(sw1)
}

function renderExemptibleMetric(
  item: StockCompareItem,
  value: number | null | undefined,
  renderValue: (val: number | null | undefined) => ReactNode,
  { forceExemptOnFinancial = false }: { forceExemptOnFinancial?: boolean } = {},
): ReactNode {
  if (
    item.metrics &&
    isFinancialCompareItem(item) &&
    (forceExemptOnFinancial || value === null || value === undefined)
  ) {
    return <span className="small muted">行业不适用</span>
  }
  return renderValue(value)
}

type CompareSyncStatus = 'syncing' | 'done' | 'failed'

type CompareMetricRow = {
  key: string
  label: string
  glossaryKey: GlossaryKey
  render: (item: StockCompareItem, syncStatus?: CompareSyncStatus) => ReactNode
}

const COMPARE_METRIC_ROWS: readonly CompareMetricRow[] = [
  {
    key: 'snapshot_status',
    label: '快照状态',
    glossaryKey: 'snapshot_status',
    render: (item, syncStatus) => {
      if (item.snapshot_available) {
        return (
          <Tag color="green">
            {item.snapshot_as_of ? `已同步 ${item.snapshot_as_of}` : '已同步'}
          </Tag>
        )
      }
      if (syncStatus === 'syncing') {
        return <Tag color="blue">自动拉取中…</Tag>
      }
      if (syncStatus === 'failed') {
        return <Tag color="amber">同步失败（暂缺）</Tag>
      }
      return <Tag color="gray">未同步快照</Tag>
    },
  },
  {
    key: 'industry',
    label: '申万一级行业',
    glossaryKey: 'industry_sw1',
    render: (item) => item.metrics?.industry_sw1 ?? item.meta.industry_sw1 ?? '—',
  },
  {
    key: 'total_score',
    label: '五维综合评分',
    glossaryKey: 'radar_total_score',
    render: (item) =>
      item.metrics ? (
        <Tag
          color={
            item.metrics.total_score >= 70
              ? 'green'
              : item.metrics.total_score >= 45
                ? 'blue'
                : 'amber'
          }
        >
          {item.metrics.total_score} / 100
        </Tag>
      ) : (
        '—'
      ),
  },
  {
    key: 'close',
    label: '最新收盘价（元）',
    glossaryKey: 'latest_close',
    render: (item) => <span className="mono">{formatNum(item.metrics?.close, 2)}</span>,
  },
  {
    key: 'total_mv_yuan',
    label: '总市值',
    glossaryKey: 'market_cap',
    render: (item) => <span className="mono">{formatYi(item.metrics?.total_mv_yuan)}</span>,
  },
  {
    key: 'pe_ttm',
    label: 'PE (TTM)',
    glossaryKey: 'pe_ttm',
    render: (item) => <span className="mono">{formatNum(item.metrics?.pe_ttm, 2)}</span>,
  },
  {
    key: 'pe_percentile_10y',
    label: 'PE 10年历史分位',
    glossaryKey: 'valuation_pct_10y',
    render: (item) => <span className="mono">{formatPct(item.metrics?.pe_percentile_10y, 1)}</span>,
  },
  {
    key: 'pb',
    label: 'PB (市净率)',
    glossaryKey: 'pb',
    render: (item) => <span className="mono">{formatNum(item.metrics?.pb, 2)}</span>,
  },
  {
    key: 'roe_5y_avg_pct',
    label: '5年平均 ROE',
    glossaryKey: 'roe_5y_avg',
    render: (item) => <span className="mono">{formatPct(item.metrics?.roe_5y_avg_pct, 2)}</span>,
  },
  {
    key: 'gross_margin_latest_pct',
    label: '最新毛利率',
    glossaryKey: 'gross_margin_latest',
    render: (item) =>
      renderExemptibleMetric(item, item.metrics?.gross_margin_latest_pct, (value) => (
        <span className="mono">{formatPct(value, 2)}</span>
      )),
  },
  {
    key: 'net_cash_to_mv_pct',
    label: '净现金 / 总市值',
    glossaryKey: 'net_cash_to_mv',
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.net_cash_to_mv_pct,
        (value) => <span className={`mono ${qualityTone(value)}`}>{formatPct(value, 2)}</span>,
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'ocf_to_profit_5y_pct',
    label: '5年 OCF / 净利润',
    glossaryKey: 'ocf_to_profit_5y',
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.ocf_to_profit_5y_pct,
        (value) => <span className="mono">{formatPct(value, 1)}</span>,
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'shareholder_yield_pct',
    label: '股东回报率',
    glossaryKey: 'net_cash_yield',
    render: (item) => (
      <span className={`mono ${qualityTone(item.metrics?.shareholder_yield_pct)}`}>
        {formatPct(item.metrics?.shareholder_yield_pct, 2)}
      </span>
    ),
  },
  {
    key: 'implied_fcf_cagr_pct',
    label: 'Reverse DCF 隐含 FCF 增速',
    glossaryKey: 'implied_fcf_cagr',
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.implied_fcf_cagr_pct,
        (value) => (
          <span className={`mono ${qualityTone(value, true)}`}>{formatSignedPct(value, 2)}</span>
        ),
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'earnings_quality',
    label: '盈利成色标签',
    glossaryKey: 'forensic_profit_truth',
    render: (item) =>
      item.metrics?.earnings_quality_label ? (
        <span
          className={
            getEarningsQualityBadgeMeta(
              item.metrics.earnings_quality_tag,
              item.metrics.earnings_quality_label,
            ).badgeClass
          }
        >
          {item.metrics.earnings_quality_label}
        </span>
      ) : (
        '—'
      ),
  },
  {
    key: 'invest_profit_share_3y_pct',
    label: '近3年投资收益占比',
    glossaryKey: 'invest_profit_share',
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.invest_profit_share_3y_pct,
        (value) => {
          const isHigh =
            value !== null && value !== undefined && Number.isFinite(value) && value >= 30
          return <span className={isHigh ? 'mono tone-bad' : 'mono'}>{formatPct(value, 1)}</span>
        },
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'investment_assets_ratio_pct',
    label: '表内投资类资产占比',
    glossaryKey: 'investment_assets_ratio',
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.investment_assets_ratio_pct,
        (value) => <span className="mono">{formatPct(value, 1)}</span>,
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'ct_alerts',
    label: 'CT 排雷 (红 / 黄灯)',
    glossaryKey: 'ct_lights',
    render: (item) => {
      if (!item.metrics) {
        return '—'
      }
      const { ct_red_count: redCount, ct_yellow_count: yellowCount } = item.metrics
      const color = redCount > 0 ? 'rose' : yellowCount > 0 ? 'amber' : 'green'
      return <Tag color={color}>{`${redCount} 红 / ${yellowCount} 黄`}</Tag>
    },
  },
]

export function ComparePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()

  const rawCodesParam = searchParams.get('codes') ?? ''
  const selectedCodes = useMemo(
    () => normalizeCompareCodes(rawCodesParam.split(',')),
    [rawCodesParam],
  )

  const [inputValue, setInputValue] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const pickerRef = useRef<HTMLFormElement>(null)

  const trimmedInput = inputValue.trim()
  const submitSeqRef = useRef(0)
  const latestInputRef = useRef(trimmedInput)
  latestInputRef.current = trimmedInput
  const latestCodesRef = useRef(selectedCodes)
  latestCodesRef.current = selectedCodes

  useEffect(() => {
    if (!trimmedInput || CODE_PATTERN.test(trimmedInput)) {
      setDebouncedQuery('')
      return
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(trimmedInput)
    }, 180)
    return () => {
      window.clearTimeout(timer)
    }
  }, [trimmedInput])

  useEffect(() => {
    function handleOutsideMouseDown(event: MouseEvent) {
      if (
        pickerRef.current &&
        event.target instanceof Node &&
        !pickerRef.current.contains(event.target)
      ) {
        setIsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideMouseDown)
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown)
    }
  }, [])

  const searchEnabled = debouncedQuery.length > 0
  const searchQuery = useQuery({
    queryKey: queryKeys.stocks.search(debouncedQuery),
    queryFn: ({ signal }) => api.searchStocks(debouncedQuery, 8, signal),
    enabled: searchEnabled,
  })

  const isDebouncing =
    trimmedInput.length > 0 && !CODE_PATTERN.test(trimmedInput) && debouncedQuery !== trimmedInput
  const isSearching = isDebouncing || (searchEnabled && searchQuery.isFetching)
  const searchResults = !isSearching && searchEnabled ? (searchQuery.data ?? []) : []
  const showDropdown = isDropdownOpen && trimmedInput.length > 0 && !CODE_PATTERN.test(trimmedInput)

  const compareQuery = useStockCompare(selectedCodes)
  const compareItems = compareQuery.data ?? []
  const [syncStatusByCode, setSyncStatusByCode] = useState<Record<string, CompareSyncStatus>>({})
  const attemptedCodesRef = useRef<Set<string>>(new Set())
  const inFlightControllersRef = useRef<Map<string, AbortController>>(new Map())
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    const controllers = inFlightControllersRef.current
    return () => {
      isMountedRef.current = false
      for (const controller of controllers.values()) {
        controller.abort()
      }
      controllers.clear()
    }
  }, [])

  useEffect(() => {
    const activeSet = new Set(selectedCodes)
    for (const [code, controller] of inFlightControllersRef.current.entries()) {
      if (!activeSet.has(code)) {
        controller.abort()
        inFlightControllersRef.current.delete(code)
      }
    }
    for (const code of attemptedCodesRef.current) {
      if (!activeSet.has(code)) {
        attemptedCodesRef.current.delete(code)
      }
    }
    setSyncStatusByCode((prev) => {
      let changed = false
      const next: Record<string, CompareSyncStatus> = {}
      for (const [code, status] of Object.entries(prev)) {
        if (activeSet.has(code)) {
          next[code] = status
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [selectedCodes])

  useEffect(() => {
    if (!compareQuery.data) {
      return
    }
    const codesToSync = compareQuery.data
      .filter(
        (item) =>
          latestCodesRef.current.includes(item.code) &&
          !item.snapshot_available &&
          !attemptedCodesRef.current.has(item.code) &&
          !inFlightControllersRef.current.has(item.code),
      )
      .map((item) => item.code)

    if (codesToSync.length === 0) {
      return
    }

    for (const code of codesToSync) {
      attemptedCodesRef.current.add(code)
    }
    setSyncStatusByCode((prev) => {
      const next = { ...prev }
      for (const code of codesToSync) {
        next[code] = 'syncing'
      }
      return next
    })

    for (const code of codesToSync) {
      const controller = new AbortController()
      inFlightControllersRef.current.set(code, controller)

      void api
        .syncStockSnapshot(code, controller.signal)
        .then(async () => {
          inFlightControllersRef.current.delete(code)
          if (!isMountedRef.current || controller.signal.aborted) {
            return
          }
          void queryClient.invalidateQueries({
            queryKey: queryKeys.stocks.detail(code),
          })
          void queryClient.invalidateQueries({
            queryKey: queryKeys.stocks.screenerPrefix(),
          })
          await queryClient.invalidateQueries({
            queryKey: queryKeys.stocks.comparePrefix(),
          })
          if (!isMountedRef.current || controller.signal.aborted) {
            return
          }
          setSyncStatusByCode((prev) => ({ ...prev, [code]: 'done' }))
        })
        .catch(() => {
          inFlightControllersRef.current.delete(code)
          if (!isMountedRef.current || controller.signal.aborted) {
            return
          }
          setSyncStatusByCode((prev) => ({ ...prev, [code]: 'failed' }))
        })
    }
  }, [compareQuery.data, queryClient])

  const screenerQuery = useStockScreener({ limit: 50 }, selectedCodes.length === 0)
  const syncedHotCodes = useMemo(
    () =>
      (screenerQuery.data?.items ?? [])
        .slice(0, 3)
        .map((item) => item.code)
        .filter((code) => CODE_PATTERN.test(code)),
    [screenerQuery.data],
  )

  function updateSelectedCodes(nextCodes: readonly string[]) {
    const normalized = normalizeCompareCodes(nextCodes)
    latestCodesRef.current = normalized
    if (normalized.length > 0) {
      setSearchParams({ codes: normalized.join(',') })
    } else {
      setSearchParams({})
    }
  }

  function addCode(code: string) {
    submitSeqRef.current += 1
    const normalized = code.trim()
    const currentCodes = latestCodesRef.current
    if (!CODE_PATTERN.test(normalized)) {
      setFormMessage('请输入 6 位数字股票代码')
      return
    }
    if (currentCodes.includes(normalized)) {
      setFormMessage(`${normalized} 已在对比列表中`)
      setIsDropdownOpen(false)
      return
    }
    if (currentCodes.length >= MAX_COMPARE_CODES) {
      setFormMessage(`横向对比最多支持 ${MAX_COMPARE_CODES} 支标的，请先移除部分标的`)
      setIsDropdownOpen(false)
      return
    }
    setFormMessage(null)
    latestInputRef.current = ''
    setInputValue('')
    setDebouncedQuery('')
    setIsDropdownOpen(false)
    updateSelectedCodes([...currentCodes, normalized])
  }

  function removeCode(code: string) {
    submitSeqRef.current += 1
    setFormMessage(null)
    updateSelectedCodes(latestCodesRef.current.filter((item) => item !== code))
  }

  async function handleSubmitAdd() {
    const submitted = latestInputRef.current
    const currentCodes = latestCodesRef.current
    if (!submitted) {
      setFormMessage('请输入 6 位股票代码或名称关键词')
      return
    }
    if (currentCodes.length >= MAX_COMPARE_CODES) {
      setFormMessage(`横向对比最多支持 ${MAX_COMPARE_CODES} 支标的，请先移除部分标的`)
      return
    }
    if (CODE_PATTERN.test(submitted)) {
      addCode(submitted)
      return
    }
    if (!isSearching && searchResults.length > 0 && searchResults[0]) {
      addCode(searchResults[0].code)
      return
    }
    const seq = ++submitSeqRef.current
    try {
      const matches = await queryClient.fetchQuery({
        queryKey: queryKeys.stocks.search(submitted),
        queryFn: ({ signal }) => api.searchStocks(submitted, 8, signal),
      })
      if (seq !== submitSeqRef.current || latestInputRef.current !== submitted) {
        return
      }
      const first = matches[0]
      if (!first) {
        setFormMessage(`未找到匹配“${submitted}”的股票`)
        return
      }
      addCode(first.code)
    } catch {
      if (seq !== submitSeqRef.current || latestInputRef.current !== submitted) {
        return
      }
      setFormMessage('搜索失败，请稍后重试或直接输入 6 位代码')
    }
  }

  const nameByCode = new Map(compareItems.map((item) => [item.code, item.meta.name]))
  const getEffectiveSyncStatus = (code: string): CompareSyncStatus | undefined => {
    const status = syncStatusByCode[code]
    if (status === 'done' && compareQuery.isFetching) {
      return 'syncing'
    }
    return status
  }
  const unsyncedItems = compareItems.filter((item) => !item.snapshot_available)
  const syncingCodes = unsyncedItems
    .filter((item) => getEffectiveSyncStatus(item.code) === 'syncing')
    .map((item) => item.code)
  const unavailableUnsyncedCodes = unsyncedItems
    .filter((item) => getEffectiveSyncStatus(item.code) !== 'syncing')
    .map((item) => item.code)

  return (
    <div className="container stack" style={{ gap: 16 }}>
      <Card
        title="PEER BENCHMARK · 多标的对照"
        extra={
          <span className="row" style={{ gap: 8 }}>
            <Tag color="blue">{`已选 ${selectedCodes.length} / ${MAX_COMPARE_CODES}`}</Tag>
            {selectedCodes.length > 0 ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  submitSeqRef.current += 1
                  setFormMessage(null)
                  updateSelectedCodes([])
                }}
              >
                清空列表
              </button>
            ) : null}
          </span>
        }
      >
        <div className="stack" style={{ gap: 14 }}>
          <div className="compare-intro">
            <h1 className="compare-title">同业横向对比</h1>
            <p className="small muted">
              选择 1–5 支标的，并排比较五维雷达评分、估值分位、ROE 稳定性与排雷信号。
            </p>
          </div>
          <form
            ref={pickerRef}
            className="compare-picker-form"
            onSubmit={(event) => {
              event.preventDefault()
              void handleSubmitAdd()
            }}
          >
            <div className="compare-search-wrap">
              <input
                type="text"
                className="input"
                aria-label="添加对比股票"
                placeholder="输入 6 位代码或股票名称添加对比，如 000858"
                value={inputValue}
                disabled={selectedCodes.length >= MAX_COMPARE_CODES}
                onFocus={() => {
                  if (trimmedInput && !CODE_PATTERN.test(trimmedInput)) {
                    setIsDropdownOpen(true)
                  }
                }}
                onChange={(event) => {
                  const next = event.target.value
                  submitSeqRef.current += 1
                  latestInputRef.current = next.trim()
                  setInputValue(next)
                  setFormMessage(null)
                  setIsDropdownOpen(next.trim().length > 0 && !CODE_PATTERN.test(next.trim()))
                }}
                onKeyDown={(event) => {
                  if (
                    event.nativeEvent.isComposing ||
                    event.key === 'Process' ||
                    event.keyCode === 229
                  ) {
                    return
                  }
                  if (event.key === 'Escape') {
                    setIsDropdownOpen(false)
                  }
                }}
              />

              {showDropdown ? (
                <div className="nav-search-dropdown" role="listbox" aria-label="对比候选股票">
                  {isSearching ? (
                    <div className="nav-search-status">搜索中...</div>
                  ) : searchQuery.isError ? (
                    <div className="nav-search-status">搜索失败，请稍后重试</div>
                  ) : searchResults.length === 0 ? (
                    <div className="nav-search-status">未找到匹配股票</div>
                  ) : (
                    searchResults.map((stock) => (
                      <button
                        key={stock.code}
                        type="button"
                        role="option"
                        aria-selected={selectedCodes.includes(stock.code)}
                        className="nav-search-item"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => addCode(stock.code)}
                      >
                        <span className="nav-search-item-main">
                          <span className="mono">{stock.code}</span>
                          <span>{stock.name}</span>
                        </span>
                        <span className="nav-search-item-tags">
                          <Tag color="blue">{stock.exchange}</Tag>
                          <Tag color={stock.snapshot_available ? 'green' : 'gray'}>
                            {stock.snapshot_available ? '已同步快照' : '仅基础信息'}
                          </Tag>
                          {stock.is_st ? <Tag color="amber">ST</Tag> : null}
                          {!stock.is_active ? <Tag color="rose">已退市</Tag> : null}
                          {selectedCodes.includes(stock.code) ? (
                            <Tag color="green">已选</Tag>
                          ) : null}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            <button
              type="submit"
              className="btn-primary"
              disabled={selectedCodes.length >= MAX_COMPARE_CODES}
            >
              添加对比
            </button>
          </form>

          {formMessage ? (
            <div className="inline-error" role="alert">
              {formMessage}
            </div>
          ) : null}

          {selectedCodes.length > 0 ? (
            <div className="compare-chip-row" aria-label="已选对比标的">
              {selectedCodes.map((code) => {
                const name = nameByCode.get(code)
                return (
                  <span key={code} className="compare-chip">
                    <Link className="mono link-accent" to={`/stock/${code}`}>
                      {code}
                    </Link>
                    {name ? <span>{name}</span> : null}
                    <button
                      type="button"
                      className="compare-chip-remove"
                      aria-label={`移除 ${code}`}
                      onClick={() => removeCode(code)}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
            </div>
          ) : null}
        </div>
      </Card>

      {selectedCodes.length === 0 ? (
        <Card title="对比矩阵">
          <EmptyBlock
            title="请添加 1–5 支标的开始同业横向对比"
            hint={
              <div className="compare-empty-body">
                <p className="compare-empty-sub">
                  支持直接输入 6 位代码或搜索股票名称，URL 参数可分享保存。
                </p>
                {syncedHotCodes.length > 0 ? (
                  <div className="compare-empty-primary">
                    <button
                      type="button"
                      className="btn-primary compare-hot-btn"
                      title={`载入已同步标的: ${syncedHotCodes.join(', ')}`}
                      onClick={() => {
                        submitSeqRef.current += 1
                        updateSelectedCodes(syncedHotCodes)
                      }}
                    >
                      对比已同步热门标的
                    </button>
                  </div>
                ) : null}
                <div className="compare-empty-deck">
                  <div className="compare-empty-divider">
                    <span>或选择精选行业对比方案</span>
                  </div>
                  <div className="compare-preset-grid">
                    {COMPARE_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className="tk-card compare-preset-card"
                        aria-label={preset.label}
                        onClick={() => {
                          submitSeqRef.current += 1
                          updateSelectedCodes(preset.codes)
                        }}
                      >
                        <span className="compare-preset-head">
                          <span className="compare-preset-title">{preset.title}</span>
                          <span className="small link-accent compare-preset-cta">一键对比 →</span>
                        </span>
                        <span className="small muted">{preset.subtitle}</span>
                        <span className="compare-preset-codes">
                          {preset.codes.map((code) => (
                            <span key={code} className="compare-preset-code mono">
                              {code}
                            </span>
                          ))}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            }
          />
        </Card>
      ) : compareQuery.isPending || (!compareQuery.data && compareQuery.isFetching) ? (
        <Card title="对比矩阵">
          <LoadingBlock lines={6} />
        </Card>
      ) : compareQuery.isError ? (
        <Card title="对比矩阵">
          <ErrorBlock
            title="同业对比加载失败"
            message={compareQuery.error instanceof Error ? compareQuery.error.message : '未知错误'}
            onRetry={() => {
              void compareQuery.refetch()
            }}
          />
        </Card>
      ) : (
        <Card
          title="基本面、估值与排雷横向对比"
          hint="compare_matrix"
          extra={<span className="small muted">左右对比最多 5 支标的</span>}
        >
          <div className="table-wrap">
            <table className="table compare-matrix-table">
              <thead>
                <tr>
                  <th className="compare-metric-col">指标维度</th>
                  {compareItems.map((item) => (
                    <th key={item.code} style={{ textAlign: 'right' }}>
                      <div className="compare-col-head">
                        <Link className="link-accent" to={`/stock/${item.code}`}>
                          {item.meta.name}
                        </Link>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          <span className="mono small muted">{item.code}</span>
                          <Tag color="blue">{item.meta.exchange}</Tag>
                          {item.meta.is_st ? <Tag color="amber">ST</Tag> : null}
                          {!item.meta.is_active ? <Tag color="rose">已退市</Tag> : null}
                        </div>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_METRIC_ROWS.map((row) => (
                  <tr key={row.key}>
                    <td className="soft compare-metric-col">
                      <GlossaryLabel label={row.label} term={row.glossaryKey} />
                    </td>
                    {compareItems.map((item) => (
                      <td key={`${row.key}-${item.code}`} style={{ textAlign: 'right' }}>
                        {row.render(item, getEffectiveSyncStatus(item.code))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {syncingCodes.length > 0 ? (
            <div className="notice-box mt-16" role="status">
              <span>
                正在为 <code className="mono">{syncingCodes.join(', ')}</code>{' '}
                自动拉取财报与估值快照（首次约需 5–8 秒），完成后将自动刷新对比指标…
              </span>
            </div>
          ) : null}

          {unavailableUnsyncedCodes.length > 0 ? (
            <div className="notice-box notice-warn mt-16" role="note">
              <span>
                标的 <code className="mono">{unavailableUnsyncedCodes.join(', ')}</code>{' '}
                深度财报快照同步暂不可用（可能因上游数据源异常或缺少连续年报）。你可以先对比其余已同步标的，或{' '}
                <Link className="link-accent" to="/">
                  前往首页浏览已覆盖全量财报的标的
                </Link>
                。
              </span>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  )
}
