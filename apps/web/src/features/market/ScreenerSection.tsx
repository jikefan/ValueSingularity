import { forwardRef, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { GlossaryLabel, InfoHint } from '../../components/ui/InfoHint'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { getEarningsQualityBadgeMeta } from '../../lib/earningsQuality'
import { formatForensicRatioPct, formatNum, formatPct, formatStockName } from '../../lib/format'
import type { GlossaryKey } from '../../lib/glossary'
import { useStockScreener } from '../../lib/useStockAnalysis'
import type {
  ScreenerQualityFilter,
  ScreenerSortDir,
  ScreenerSortField,
  StockScreenerFilters,
  StockScreenerItem,
} from '../../types/api'

const PE_PERCENTILE_OPTIONS: ReadonlyArray<{ label: string; value: number | undefined }> = [
  { label: '不限', value: undefined },
  { label: '< 30%', value: 30 },
  { label: '< 50%', value: 50 },
]

const ROE_OPTIONS: ReadonlyArray<{ label: string; value: number | undefined }> = [
  { label: '不限', value: undefined },
  { label: '>= 10%', value: 10 },
  { label: '>= 15%', value: 15 },
]

const DIVIDEND_OPTIONS: ReadonlyArray<{ label: string; value: number | undefined }> = [
  { label: '不限', value: undefined },
  { label: '>= 2%', value: 2 },
  { label: '>= 4%', value: 4 },
]

const QUALITY_FILTER_OPTIONS: ReadonlyArray<{
  label: string
  value: ScreenerQualityFilter | undefined
}> = [
  { label: '全部', value: undefined },
  { label: '主业现金牛', value: 'core_only' },
  { label: '剔除投资依赖', value: 'hide_investment_heavy' },
  { label: '红利堡垒', value: 'dividend_fortress' },
]

const SORT_OPTIONS: ReadonlyArray<{
  field: ScreenerSortField
  label: string
  defaultDir: ScreenerSortDir
}> = [
  { field: 'total_score', label: '雷达总分', defaultDir: 'desc' },
  { field: 'pe_percentile_10y', label: 'PE 10Y分位', defaultDir: 'asc' },
  { field: 'roe_5y_avg_pct', label: '5Y ROE', defaultDir: 'desc' },
  { field: 'dividend_yield_pct', label: '股息率', defaultDir: 'desc' },
  { field: 'pe_ttm', label: 'PE (TTM)', defaultDir: 'asc' },
  { field: 'total_mv_yuan', label: '总市值', defaultDir: 'desc' },
]

const MAX_COMPARE_SELECTION = 5
const DEFAULT_VISIBLE_ROWS = 12

function ctTagColor(item: StockScreenerItem): 'green' | 'amber' | 'rose' {
  if (item.ct_red_count > 0) return 'rose'
  if (item.ct_yellow_count > 0) return 'amber'
  return 'green'
}

function SegmentedFilterGroup<T extends string | number | undefined>({
  label,
  term,
  options,
  value,
  onChange,
}: {
  label: string
  term: GlossaryKey
  options: ReadonlyArray<{ label: string; value: T }>
  value: T
  onChange: (next: T) => void
}) {
  return (
    <div className="screener-filter-group">
      <span className="screener-filter-label">
        <GlossaryLabel label={label} term={term} />
      </span>
      <div className="seg-well" role="group" aria-label={label}>
        {options.map((opt) => {
          const active = value === opt.value
          return (
            <button
              key={opt.label}
              type="button"
              className={active ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'}
              aria-pressed={active}
              onClick={() => onChange(opt.value)}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export type ScreenerSectionProps = {
  industry: string
  onIndustryChange: (industry: string) => void
  qualityFilter: ScreenerQualityFilter | undefined
  onQualityFilterChange: (filter: ScreenerQualityFilter | undefined) => void
  poolIndustries?: readonly string[]
}

export const ScreenerSection = forwardRef<HTMLElement, ScreenerSectionProps>(
  function ScreenerSection(
    { industry, onIndustryChange, qualityFilter, onQualityFilterChange, poolIndustries },
    ref,
  ) {
    const [zeroRedOnly, setZeroRedOnly] = useState(false)
    const [maxPePercentile, setMaxPePercentile] = useState<number | undefined>(undefined)
    const [minRoe, setMinRoe] = useState<number | undefined>(undefined)
    const [minDividendYield, setMinDividendYield] = useState<number | undefined>(undefined)
    const [searchInput, setSearchInput] = useState('')
    const [debouncedSearch, setDebouncedSearch] = useState('')
    const [sortBy, setSortBy] = useState<ScreenerSortField>('total_score')
    const [sortDir, setSortDir] = useState<ScreenerSortDir>('desc')
    const [selectedCompareCodes, setSelectedCompareCodes] = useState<string[]>([])
    const [showAllRows, setShowAllRows] = useState(false)

    useEffect(() => {
      setShowAllRows(false)
    }, [
      zeroRedOnly,
      maxPePercentile,
      minRoe,
      minDividendYield,
      qualityFilter,
      industry,
      debouncedSearch,
      sortBy,
      sortDir,
    ])

    useEffect(() => {
      const trimmed = searchInput.trim()
      if (!trimmed) {
        setDebouncedSearch('')
        return
      }
      const timer = window.setTimeout(() => {
        setDebouncedSearch(trimmed)
      }, 150)
      return () => {
        window.clearTimeout(timer)
      }
    }, [searchInput])

    const screenerFilters = useMemo<StockScreenerFilters>(
      () => ({
        zeroRedOnly: zeroRedOnly || undefined,
        maxPePercentile,
        minRoe,
        minDividendYield,
        qualityFilter,
        industry: industry || undefined,
        q: debouncedSearch || undefined,
        sortBy,
        sortDir,
        limit: 50,
      }),
      [
        zeroRedOnly,
        maxPePercentile,
        minRoe,
        minDividendYield,
        qualityFilter,
        industry,
        debouncedSearch,
        sortBy,
        sortDir,
      ],
    )
    const screenerQuery = useStockScreener(screenerFilters)

    const industryOptions = useMemo(() => {
      const base = poolIndustries ?? screenerQuery.data?.industries ?? []
      if (industry && !base.includes(industry)) {
        return [industry, ...base]
      }
      return base
    }, [poolIndustries, screenerQuery.data?.industries, industry])

    function resetScreenerFilters() {
      setZeroRedOnly(false)
      setMaxPePercentile(undefined)
      setMinRoe(undefined)
      setMinDividendYield(undefined)
      onQualityFilterChange(undefined)
      onIndustryChange('')
      setSearchInput('')
      setDebouncedSearch('')
      setSortBy('total_score')
      setSortDir('desc')
      setShowAllRows(false)
    }

    function toggleCompareCode(code: string) {
      setSelectedCompareCodes((prev) => {
        if (prev.includes(code)) {
          return prev.filter((item) => item !== code)
        }
        if (prev.length >= MAX_COMPARE_SELECTION) {
          return prev
        }
        return [...prev, code]
      })
    }

    const screenerData = screenerQuery.data
    const screenerItems = screenerData?.items ?? []
    const visibleItems = showAllRows ? screenerItems : screenerItems.slice(0, DEFAULT_VISIBLE_ROWS)
    const topCandidates = screenerItems.slice(0, 3)
    const hasActiveFilter =
      zeroRedOnly ||
      maxPePercentile !== undefined ||
      minRoe !== undefined ||
      minDividendYield !== undefined ||
      qualityFilter !== undefined ||
      industry.length > 0 ||
      searchInput.trim().length > 0 ||
      sortBy !== 'total_score' ||
      sortDir !== 'desc'

    return (
      <section
        ref={ref}
        className="card-machined bento-pad stack screener-deck"
        style={{ gap: 18 }}
        aria-label="价值击球区精选雷达"
      >
        <div className="sec-head" style={{ marginBottom: 0 }}>
          <div className="stack" style={{ gap: 6 }}>
            <div
              className="row"
              style={{ justifyContent: 'flex-start', gap: 10, flexWrap: 'wrap' }}
            >
              <span className="eyebrow-pill">
                <span className="live-beacon" />
                VALUE SCREENER
              </span>
              <h2 className="sec-title">
                <GlossaryLabel label="价值击球区精选雷达" term="screener_radar" size="md" />
              </h2>
              {screenerQuery.isFetching && screenerData ? (
                <Tag color="blue">筛选更新中...</Tag>
              ) : null}
            </div>
            <p className="sec-sub">
              {screenerData
                ? `已同步全量财报标的池 ${screenerData.total_synced} 支 · 当前命中 ${screenerData.filtered_count} 支`
                : '基于已同步全量财报快照的多维价值筛查与排雷雷达'}
            </p>
          </div>

          <div className="screener-compare-bar">
            <Tag color={selectedCompareCodes.length > 0 ? 'green' : 'gray'}>
              {`已选对比 ${selectedCompareCodes.length} / ${MAX_COMPARE_SELECTION}`}
            </Tag>
            {selectedCompareCodes.length > 0 ? (
              <>
                <Link
                  className="btn-cta-sm"
                  to={`/compare?codes=${selectedCompareCodes.join(',')}`}
                >
                  {`发起对比 (${selectedCompareCodes.length})`}
                </Link>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setSelectedCompareCodes([])}
                >
                  清空勾选
                </button>
              </>
            ) : (
              <span className="small muted">勾选下方最多 5 支发起横向对比</span>
            )}
          </div>
        </div>

        <div className="screener-filters">
          <div className="screener-filter-row">
            <div className="screener-filter-group">
              <span className="screener-filter-label">
                <GlossaryLabel label="排雷过滤" term="filter_zero_red" />
              </span>
              <div className="seg-well" role="group" aria-label="排雷过滤">
                <button
                  type="button"
                  className={zeroRedOnly ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'}
                  aria-pressed={zeroRedOnly}
                  onClick={() => setZeroRedOnly((prev) => !prev)}
                >
                  仅看零红灯
                </button>
              </div>
            </div>

            <SegmentedFilterGroup
              label="PE 10Y 分位"
              term="filter_pe_percentile_max"
              options={PE_PERCENTILE_OPTIONS}
              value={maxPePercentile}
              onChange={setMaxPePercentile}
            />

            <SegmentedFilterGroup
              label="5Y ROE"
              term="filter_roe_min"
              options={ROE_OPTIONS}
              value={minRoe}
              onChange={setMinRoe}
            />

            <SegmentedFilterGroup
              label="股息率"
              term="filter_dividend_yield_min"
              options={DIVIDEND_OPTIONS}
              value={minDividendYield}
              onChange={setMinDividendYield}
            />

            <SegmentedFilterGroup
              label="盈利成色"
              term="quality_filter"
              options={QUALITY_FILTER_OPTIONS}
              value={qualityFilter}
              onChange={onQualityFilterChange}
            />
          </div>

          <div className="screener-control-row">
            <select
              className="input screener-select"
              aria-label="行业筛选"
              value={industry}
              onChange={(event) => onIndustryChange(event.target.value)}
            >
              <option value="">全部行业</option>
              {industryOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>

            <input
              type="search"
              className="input screener-search-input"
              aria-label="筛选代码或名称"
              placeholder="筛选代码或名称..."
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setDebouncedSearch(searchInput.trim())
                }
              }}
            />

            <div className="screener-sort-group">
              <select
                className="input screener-select"
                aria-label="排序方式"
                value={sortBy}
                onChange={(event) => {
                  const nextField = event.target.value as ScreenerSortField
                  const preset = SORT_OPTIONS.find((opt) => opt.field === nextField)
                  setSortBy(nextField)
                  if (preset) {
                    setSortDir(preset.defaultDir)
                  }
                }}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.field} value={opt.field}>
                    {`按${opt.label}`}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="btn-ghost screener-dir-btn"
                aria-label="切换排序方向"
                onClick={() => setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
              >
                {sortDir === 'desc' ? '降序 ↓' : '升序 ↑'}
              </button>
            </div>

            <button
              type="button"
              className="btn-ghost"
              disabled={!hasActiveFilter}
              onClick={resetScreenerFilters}
            >
              重置筛选
            </button>
          </div>
        </div>

        {screenerQuery.isPending && !screenerData ? (
          <LoadingBlock lines={5} />
        ) : screenerQuery.isError ? (
          <ErrorBlock
            title="精选雷达加载失败"
            message={
              screenerQuery.error instanceof Error ? screenerQuery.error.message : '未知错误'
            }
            onRetry={() => {
              void screenerQuery.refetch()
            }}
          />
        ) : screenerItems.length === 0 ? (
          <div className="stack" style={{ gap: 12, alignItems: 'center' }}>
            <EmptyBlock
              title="当前筛选条件下暂无匹配标的"
              hint={
                industry
                  ? `当前行业「${industry}」或复合阈值下无已同步标的，可放宽条件或重置筛选。`
                  : '可尝试放宽 PE 分位、5Y ROE 或股息率条件。'
              }
            />
            {hasActiveFilter ? (
              <button type="button" className="btn-primary" onClick={resetScreenerFilters}>
                恢复默认筛选
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="screener-top-grid" aria-label="精选候选前三名">
              {topCandidates.map((item) => {
                const isSelected = selectedCompareCodes.includes(item.code)
                const atLimit = !isSelected && selectedCompareCodes.length >= MAX_COMPARE_SELECTION
                return (
                  <div
                    key={item.code}
                    className={
                      isSelected ? 'tk-card screener-top-card active' : 'tk-card screener-top-card'
                    }
                  >
                    <div className="row" style={{ width: '100%', alignItems: 'flex-start' }}>
                      <div className="stack" style={{ gap: 4 }}>
                        <div
                          className="row"
                          style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}
                        >
                          <Link
                            className="link-accent screener-card-name"
                            to={`/stock/${item.code}`}
                          >
                            {formatStockName(item.name)}
                          </Link>
                          <span className="code-pill">{item.code}</span>
                        </div>
                        <span className="small muted">{item.industry_sw1 ?? '未分类'}</span>
                      </div>
                      <span className="label-with-hint">
                        <Tag color={ctTagColor(item)}>
                          {`${item.ct_red_count} 红 / ${item.ct_yellow_count} 黄`}
                        </Tag>
                        <InfoHint term="ct_lights" />
                      </span>
                    </div>

                    {item.earnings_quality_label ||
                    (!item.is_financial &&
                      item.invest_profit_share_3y_pct !== null &&
                      item.invest_profit_share_3y_pct !== undefined) ? (
                      <div
                        className="row"
                        style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}
                      >
                        {item.earnings_quality_label ? (
                          <span
                            className={
                              getEarningsQualityBadgeMeta(
                                item.earnings_quality_tag,
                                item.earnings_quality_label,
                              ).badgeClass
                            }
                          >
                            {item.earnings_quality_label}
                          </span>
                        ) : null}
                        {!item.is_financial &&
                        item.invest_profit_share_3y_pct !== null &&
                        item.invest_profit_share_3y_pct !== undefined ? (
                          <span
                            className={`small tnum ${item.invest_profit_share_3y_pct >= 30 && Math.abs(item.invest_profit_share_3y_pct) < 900 ? 'tone-bad' : 'muted'}`}
                          >
                            {`投资占比 ${formatForensicRatioPct(item.invest_profit_share_3y_pct)}`}
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="screener-top-metrics">
                      <div className="screener-top-stat">
                        <span className="small muted">
                          <GlossaryLabel label="雷达总分" term="radar_total_score" />
                        </span>
                        <span className="tnum screener-top-score">{item.total_score}</span>
                      </div>
                      <div className="screener-top-stat">
                        <span className="small muted">
                          <GlossaryLabel label="PE分位" term="pe_ttm_and_pct" />
                        </span>
                        <span className="tnum">{formatPct(item.pe_percentile_10y, 1)}</span>
                      </div>
                      <div className="screener-top-stat">
                        <span className="small muted">
                          <GlossaryLabel label="5Y ROE" term="roe_5y_avg" />
                        </span>
                        <span className="tnum">{formatPct(item.roe_5y_avg_pct, 1)}</span>
                      </div>
                      <div className="screener-top-stat">
                        <span className="small muted">
                          <GlossaryLabel label="股息率" term="dividend_yield" />
                        </span>
                        <span className="tnum">{formatPct(item.dividend_yield_pct, 2)}</span>
                      </div>
                    </div>

                    <div className="row" style={{ width: '100%' }}>
                      <Link className="small link-accent" to={`/stock/${item.code}`}>
                        查看深度分析 →
                      </Link>
                      <button
                        type="button"
                        className={isSelected ? 'filter-pill active' : 'filter-pill'}
                        disabled={atLimit}
                        onClick={() => toggleCompareCode(item.code)}
                      >
                        {isSelected ? '已选对比' : '加入对比'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="table-wrap">
              <table className="pro-table screener-table" aria-label="价值筛选结果明细表">
                <thead>
                  <tr>
                    <th>
                      <span className="label-with-hint">
                        <span>对比</span>
                        <InfoHint
                          title="横向对比勾选"
                          entry={{
                            summary:
                              '勾选最多 5 支股票加入对比篮，点击上方「发起对比」即可进入同业横向对比矩阵。',
                            reading:
                              '适合把同行业龙头或高分候选标的并排对照估值安全垫与排雷红黄灯。',
                          }}
                        />
                      </span>
                    </th>
                    <th>
                      <span className="label-with-hint">
                        <span>代码 / 名称</span>
                        <InfoHint
                          title="证券代码与简称"
                          entry={{
                            summary:
                              'A 股 6 位证券代码、股票名称及金融业标识（金融业适用资本与分红耐力及 PB-ROE 口径）。',
                            reading: '点击股票名称可进入个股深度排雷、逆向 DCF 估值与决策工作台。',
                          }}
                        />
                      </span>
                    </th>
                    <th>
                      <GlossaryLabel label="行业" term="industry_sw1" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="雷达总分" term="radar_total_score" />
                    </th>
                    <th>
                      <GlossaryLabel label="排雷灯" term="ct_lights" />
                    </th>
                    <th>
                      <GlossaryLabel label="盈利成色" term="forensic_profit_truth" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="PE(TTM) / 10Y分位" term="pe_ttm_and_pct" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="5Y ROE" term="roe_5y_avg" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="股息率" term="dividend_yield" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => {
                    const displayName = formatStockName(item.name)
                    const isChecked = selectedCompareCodes.includes(item.code)
                    const isDisabled =
                      !isChecked && selectedCompareCodes.length >= MAX_COMPARE_SELECTION
                    return (
                      <tr key={item.code}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`选择对比 ${item.code} ${displayName}`}
                            checked={isChecked}
                            disabled={isDisabled}
                            onChange={() => toggleCompareCode(item.code)}
                          />
                        </td>
                        <td>
                          <div className="screener-stock-cell">
                            <Link
                              className="link-accent screener-stock-name"
                              to={`/stock/${item.code}`}
                            >
                              {displayName}
                            </Link>
                            <span className="mono small muted">{item.code}</span>
                            {item.is_financial ? <Tag color="blue">金融</Tag> : null}
                          </div>
                        </td>
                        <td className="soft">{item.industry_sw1 ?? '—'}</td>
                        <td className="text-right tnum">
                          <Tag
                            color={
                              item.total_score >= 70
                                ? 'green'
                                : item.total_score >= 45
                                  ? 'blue'
                                  : 'amber'
                            }
                          >
                            {item.total_score}
                          </Tag>
                        </td>
                        <td>
                          <Tag color={ctTagColor(item)}>
                            {`${item.ct_red_count} 红 / ${item.ct_yellow_count} 黄`}
                          </Tag>
                        </td>
                        <td>
                          {item.earnings_quality_label ? (
                            <div
                              className="row"
                              style={{ justifyContent: 'flex-start', gap: 6, flexWrap: 'wrap' }}
                            >
                              <span
                                className={
                                  getEarningsQualityBadgeMeta(
                                    item.earnings_quality_tag,
                                    item.earnings_quality_label,
                                  ).badgeClass
                                }
                              >
                                {item.earnings_quality_label}
                              </span>
                              {!item.is_financial &&
                              item.invest_profit_share_3y_pct !== null &&
                              item.invest_profit_share_3y_pct !== undefined ? (
                                <span
                                  className={`small tnum ${item.invest_profit_share_3y_pct >= 30 && Math.abs(item.invest_profit_share_3y_pct) < 900 ? 'tone-bad' : 'muted'}`}
                                >
                                  {`投资 ${formatForensicRatioPct(item.invest_profit_share_3y_pct)}`}
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="text-right tnum">
                          {`${formatNum(item.pe_ttm, 1)} / ${formatPct(item.pe_percentile_10y, 1)}`}
                        </td>
                        <td className="text-right tnum">{formatPct(item.roe_5y_avg_pct, 2)}</td>
                        <td className="text-right tnum">{formatPct(item.dividend_yield_pct, 2)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {screenerItems.length > DEFAULT_VISIBLE_ROWS ? (
              <div className="row" style={{ justifyContent: 'center' }}>
                <button
                  type="button"
                  className="btn-ghost"
                  aria-expanded={showAllRows}
                  onClick={() => setShowAllRows((prev) => !prev)}
                >
                  {showAllRows
                    ? `收起至前 ${DEFAULT_VISIBLE_ROWS} 条`
                    : `展开全部 ${screenerItems.length} 条`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    )
  },
)
