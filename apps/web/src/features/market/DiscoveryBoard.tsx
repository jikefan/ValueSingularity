import { useState } from 'react'
import { Link } from 'react-router-dom'
import { GlossaryLabel, InfoHint } from '../../components/ui/InfoHint'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { getEarningsQualityBadgeMeta } from '../../lib/earningsQuality'
import {
  formatForensicRatioPct,
  formatNum,
  formatPct,
  formatSignedPct,
  formatStockName,
} from '../../lib/format'
import type { GlossaryKey } from '../../lib/glossary'
import type {
  CrossAssetMacroSnapshot,
  DiscoveryStockPick,
  DiscoveryThemeCard,
  DiscoveryThemeId,
  DiscoveryThemeMetric,
  ScreenerQualityFilter,
  StyleRegimeIndex,
} from '../../types/api'
import { useMarketDiscovery } from './useMarketOverview'

function themeGlossaryKey(themeId: DiscoveryThemeId): GlossaryKey {
  switch (themeId) {
    case 'gold_fed_cycle':
      return 'gold_fed_signal'
    case 'tech_vs_dividend_rotation':
      return 'style_rotation_signal'
    case 'earnings_quality_radar':
      return 'earnings_quality_contrast'
    case 'deep_value_fortress':
      return 'deep_value_fortress'
    default: {
      const _exhaustive: never = themeId
      return _exhaustive
    }
  }
}

function themeSignalMeta(
  signal: DiscoveryThemeCard['signal'],
  themeId: DiscoveryThemeId,
): { label: string; color: 'green' | 'amber' | 'rose' | 'blue' } {
  switch (signal) {
    case 'green':
      return {
        label: themeId === 'earnings_quality_radar' ? '主业造血' : '赔率占优',
        color: 'green',
      }
    case 'yellow':
      return {
        label: themeId === 'gold_fed_cycle' ? '中性跟踪' : '结构分化',
        color: 'amber',
      }
    case 'red':
      return { label: '警惕风险', color: 'rose' }
    case 'na':
      return { label: '数据完善中', color: 'blue' }
    default: {
      const _exhaustive: never = signal
      return _exhaustive
    }
  }
}

function metricToneClass(tone: DiscoveryThemeMetric['tone']): string {
  switch (tone) {
    case 'green':
      return 'tone-good'
    case 'red':
      return 'tone-bad'
    case 'yellow':
    case 'na':
      return ''
    default: {
      const _exhaustive: never = tone
      return _exhaustive
    }
  }
}

function styleBarFillClass(idx: StyleRegimeIndex): string {
  switch (idx.style) {
    case 'dividend':
      return 'style-bar-fill style-bar-fill-green'
    case 'tech':
      return (idx.drawdown_60d_pct ?? 0) <= -10
        ? 'style-bar-fill style-bar-fill-red'
        : 'style-bar-fill style-bar-fill-amber'
    case 'broad':
      return 'style-bar-fill style-bar-fill-blue'
    default: {
      const _exhaustive: never = idx.style
      return _exhaustive
    }
  }
}

function styleBarWidthPct(idx: StyleRegimeIndex): number {
  const drawdownMag =
    idx.drawdown_60d_pct !== null &&
    idx.drawdown_60d_pct !== undefined &&
    Number.isFinite(idx.drawdown_60d_pct)
      ? Math.abs(idx.drawdown_60d_pct)
      : 0
  const changeMag =
    idx.change_20d_pct !== null &&
    idx.change_20d_pct !== undefined &&
    Number.isFinite(idx.change_20d_pct)
      ? Math.abs(idx.change_20d_pct)
      : 0
  const magnitude = drawdownMag > 0 ? drawdownMag * 3.5 : changeMag * 4
  return Math.min(100, Math.max(8, Math.round(magnitude)))
}

const DEFAULT_VISIBLE_PICKS = 3

function sanitizeForensicText(text: string): string {
  // Replace legacy >=900% sentinel percentages emitted when core operating profit nears zero.
  return text.replace(/[+-]?(?:9\d{2}|[1-9]\d{3,})(?:\.\d+)?%/g, '主业微利(不适用)')
}

function formatSignedBps(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—'
  }
  const sign = value > 0 ? '+' : ''
  const numText = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${sign}${numText} bps`
}

function computeStylePulse(styles: readonly StyleRegimeIndex[]): {
  styleSpread20d: number | null
  worstTechDrawdown: number | null
} {
  const techIndices = styles.filter((idx) => idx.style === 'tech')
  const dividendIndices = styles.filter((idx) => idx.style === 'dividend')
  const tech20dVals = techIndices
    .map((idx) => idx.change_20d_pct)
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
  const div20dVals = dividendIndices
    .map((idx) => idx.change_20d_pct)
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
  const avgTech20d =
    tech20dVals.length > 0 ? tech20dVals.reduce((sum, v) => sum + v, 0) / tech20dVals.length : null
  const avgDiv20d =
    div20dVals.length > 0 ? div20dVals.reduce((sum, v) => sum + v, 0) / div20dVals.length : null
  const styleSpread20d = avgDiv20d !== null && avgTech20d !== null ? avgDiv20d - avgTech20d : null
  const techDrawdowns = techIndices
    .map((idx) => idx.drawdown_60d_pct)
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
  const worstTechDrawdown = techDrawdowns.length > 0 ? Math.min(...techDrawdowns) : null
  return { styleSpread20d, worstTechDrawdown }
}

function quickFilterForTheme(
  themeId: DiscoveryThemeId,
): { label: string; filter: ScreenerQualityFilter } | null {
  switch (themeId) {
    case 'earnings_quality_radar':
      return { label: '在雷达中仅看主业现金牛', filter: 'core_only' }
    case 'tech_vs_dividend_rotation':
      return { label: '在雷达中筛选红利堡垒', filter: 'dividend_fortress' }
    case 'deep_value_fortress':
      return { label: '在雷达中剔除投资依赖', filter: 'hide_investment_heavy' }
    case 'gold_fed_cycle':
      return null
    default: {
      const _exhaustive: never = themeId
      return _exhaustive
    }
  }
}

function MacroPulseStrip({
  crossAsset,
}: {
  crossAsset: CrossAssetMacroSnapshot | null | undefined
}) {
  const styleIndices = crossAsset?.style_indices ?? []
  const { styleSpread20d, worstTechDrawdown } = computeStylePulse(styleIndices)

  const us2yBps = crossAsset?.us_2y_change_20d_bps
  const us2yTone =
    us2yBps !== null && us2yBps !== undefined && Number.isFinite(us2yBps)
      ? us2yBps <= -15
        ? 'macro-pulse-green'
        : us2yBps >= 15
          ? 'macro-pulse-red'
          : ''
      : ''

  const realYield = crossAsset?.us_real_yield_proxy_pct
  const realYieldTone =
    realYield !== null && realYield !== undefined && Number.isFinite(realYield)
      ? realYield <= 1.2
        ? 'macro-pulse-green'
        : realYield >= 2.0
          ? 'macro-pulse-red'
          : 'macro-pulse-amber'
      : ''

  const spreadTone =
    crossAsset?.us_10y_2y_spread !== null &&
    crossAsset?.us_10y_2y_spread !== undefined &&
    Number.isFinite(crossAsset.us_10y_2y_spread)
      ? 'macro-pulse-blue'
      : ''

  const goldPct = crossAsset?.gold_percentile_1y
  const goldTone =
    goldPct !== null && goldPct !== undefined && Number.isFinite(goldPct) && goldPct >= 85
      ? 'macro-pulse-amber'
      : crossAsset?.gold_price_cny !== null && crossAsset?.gold_price_cny !== undefined
        ? 'macro-pulse-green'
        : ''

  const etfTonnesText =
    crossAsset?.gold_etf_tonnes !== null &&
    crossAsset?.gold_etf_tonnes !== undefined &&
    Number.isFinite(crossAsset.gold_etf_tonnes)
      ? `${formatNum(crossAsset.gold_etf_tonnes, 1)}t`
      : '—'
  const etfDelta = crossAsset?.gold_etf_delta_tonnes
  const etfDeltaSuffix =
    etfDelta !== null && etfDelta !== undefined && Number.isFinite(etfDelta)
      ? ` (${etfDelta > 0 ? '+' : ''}${etfDelta.toFixed(1)}t)`
      : ''

  const styleTone =
    styleSpread20d !== null ? (styleSpread20d > 0 ? 'macro-pulse-green' : 'macro-pulse-amber') : ''

  const us2yPlain =
    us2yBps === null || us2yBps === undefined || !Number.isFinite(us2yBps)
      ? '100 基点(bps)=1%，反映美联储利率预期'
      : us2yBps <= -15
        ? '100 基点(bps)=1%；利率明显回落，利好估值与黄金'
        : us2yBps >= 15
          ? '100 基点(bps)=1%；利率走高，高估值成长易承压'
          : '100 基点(bps)=1%；海外加息/降息预期暂时平稳'

  const realYieldPlain =
    realYield === null || realYield === undefined || !Number.isFinite(realYield)
      ? '扣掉通胀后的真实利率，越低越利于黄金'
      : realYield <= 1.2
        ? '实际利率偏低，买黄金等保值资产不吃利息亏'
        : realYield >= 2.0
          ? '实际利率偏高，美债生息更有吸引力，压制高估值'
          : '实际利率在中等区间，重点看公司自身赚钱能力'

  const us10y2ySpread = crossAsset?.us_10y_2y_spread
  const spreadPlain =
    us10y2ySpread === null || us10y2ySpread === undefined || !Number.isFinite(us10y2ySpread)
      ? '长短美债和中美利差，看海外经济和外资风向'
      : us10y2ySpread < 0
        ? '美债长短利率倒挂，说明市场担心海外经济降温'
        : '美债恢复长高短低，中美利差影响外资回流节奏'

  const goldPlain =
    goldPct === null || goldPct === undefined || !Number.isFinite(goldPct)
      ? 'SPDR 吨位看大资金有没有持续买黄金避险'
      : goldPct >= 85
        ? '金价处在近一年高位区，追高要注意短期波动'
        : '金价未到极端过热区，可跟着持仓变化看避险风向'

  const stylePlain =
    styleSpread20d === null
      ? '看最近 20 天高分红大盘股还是科技股更抗跌'
      : styleSpread20d > 0
        ? '近期“高分红防守股”跑赢科技，资金偏好稳健'
        : '近期科技成长跑赢红利，市场更愿意追求弹性'

  return (
    <div className="macro-pulse-strip" role="region" aria-label="跨资产宏观脉搏">
      <div className={`macro-pulse-cell ${us2yTone}`.trim()}>
        <div className="macro-pulse-head">
          <span className="macro-pulse-label">
            <GlossaryLabel label="美债 2Y 利率锚" term="us_2y_fed_anchor" />
          </span>
        </div>
        <div className="macro-pulse-value">{formatPct(crossAsset?.us_2y_yield, 2)}</div>
        <div className="macro-pulse-sub">{`近20日 ${formatSignedBps(us2yBps)}`}</div>
        <div className="small muted">{us2yPlain}</div>
      </div>

      <div className={`macro-pulse-cell ${realYieldTone}`.trim()}>
        <div className="macro-pulse-head">
          <span className="macro-pulse-label">
            <GlossaryLabel label="美国实际利率代理" term="us_10y_real_yield" />
          </span>
        </div>
        <div className="macro-pulse-value">{formatPct(realYield, 2)}</div>
        <div className="macro-pulse-sub">
          {`10Y ${formatPct(crossAsset?.us_10y_yield, 2)} − CPI ${formatPct(crossAsset?.us_cpi_yoy, 1)}`}
        </div>
        <div className="small muted">{realYieldPlain}</div>
      </div>

      <div className={`macro-pulse-cell ${spreadTone}`.trim()}>
        <div className="macro-pulse-head">
          <span className="macro-pulse-label label-with-hint">
            <span>美债期限 / 中美利差</span>
            <InfoHint term="us_10y_2y_spread" />
            <InfoHint term="us_cn_10y_spread" />
          </span>
        </div>
        <div className="macro-pulse-value">
          {`10Y-2Y ${formatPct(crossAsset?.us_10y_2y_spread, 2)}`}
        </div>
        <div className="macro-pulse-sub">
          {`中美10Y利差 ${formatPct(crossAsset?.us_cn_10y_spread, 2)} (CN ${formatPct(crossAsset?.cn_10y_yield, 2)})`}
        </div>
        <div className="small muted">{spreadPlain}</div>
      </div>

      <div className={`macro-pulse-cell ${goldTone}`.trim()}>
        <div className="macro-pulse-head">
          <span className="macro-pulse-label">
            <GlossaryLabel
              label={`${crossAsset?.gold_symbol || 'Au99.99'} 金价 / SPDR`}
              term="gold_au9999_sge"
            />
          </span>
        </div>
        <div className="macro-pulse-value">
          {crossAsset?.gold_price_cny !== null &&
          crossAsset?.gold_price_cny !== undefined &&
          Number.isFinite(crossAsset.gold_price_cny)
            ? `${formatNum(crossAsset.gold_price_cny, 2)} 元/克`
            : '—'}
        </div>
        <div className="macro-pulse-sub">
          {`1Y分位 ${formatPct(goldPct, 0)} · SPDR ${etfTonnesText}${etfDeltaSuffix}`}
        </div>
        <div className="small muted">{goldPlain}</div>
      </div>

      <div className={`macro-pulse-cell ${styleTone}`.trim()}>
        <div className="macro-pulse-head">
          <span className="macro-pulse-label">
            <GlossaryLabel label="科技 vs 红利风格差" term="style_rotation_signal" />
          </span>
        </div>
        <div className="macro-pulse-value">
          {styleSpread20d !== null ? `红利 ${formatSignedPct(styleSpread20d, 1)}` : '—'}
        </div>
        <div className="macro-pulse-sub">
          {`科创50 / 创业板 vs 上证红利 · 60D最大回撤 ${formatPct(worstTechDrawdown, 1)}`}
        </div>
        <div className="small muted">{stylePlain}</div>
      </div>
    </div>
  )
}

function DiscoveryPickRow({
  pick,
  isCaution = false,
}: {
  pick: DiscoveryStockPick
  isCaution?: boolean
}) {
  const stats: string[] = []
  if (pick.dividend_yield_pct !== null && pick.dividend_yield_pct !== undefined) {
    const spreadTxt =
      pick.dividend_spread_over_bond_pct !== null &&
      pick.dividend_spread_over_bond_pct !== undefined
        ? ` (超国债 ${formatSignedPct(pick.dividend_spread_over_bond_pct, 2)})`
        : ''
    stats.push(`股息率 ${formatPct(pick.dividend_yield_pct, 2)}${spreadTxt}`)
  }
  if (pick.roe_5y_avg_pct !== null && pick.roe_5y_avg_pct !== undefined) {
    stats.push(`5Y ROE ${formatPct(pick.roe_5y_avg_pct, 1)}`)
  }
  if (pick.pe_percentile_10y !== null && pick.pe_percentile_10y !== undefined) {
    stats.push(`PE分位 ${formatPct(pick.pe_percentile_10y, 1)}`)
  }
  if (
    !pick.is_financial &&
    pick.invest_profit_share_3y_pct !== null &&
    pick.invest_profit_share_3y_pct !== undefined
  ) {
    stats.push(`投资占比 ${formatForensicRatioPct(pick.invest_profit_share_3y_pct)}`)
  }
  if (
    !pick.is_financial &&
    pick.net_cash_to_mv_pct !== null &&
    pick.net_cash_to_mv_pct !== undefined
  ) {
    stats.push(`净现金/市值 ${formatPct(pick.net_cash_to_mv_pct, 1)}`)
  }

  const sanitizedBadgeLabel = pick.earnings_quality_label
    ? sanitizeForensicText(pick.earnings_quality_label)
    : null
  const sanitizedReason = sanitizeForensicText(pick.reason)

  return (
    <div className="discovery-pick-item">
      <div className="discovery-pick-head">
        <div className="discovery-pick-title">
          <Link className="link-accent" to={`/stock/${pick.code}`}>
            {formatStockName(pick.name)}
          </Link>
          <span className="code-pill">{pick.code}</span>
          {pick.industry_sw1 ? <span className="small muted">{pick.industry_sw1}</span> : null}
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {sanitizedBadgeLabel ? (
            <span
              className={
                isCaution
                  ? 'quality-badge quality-badge-red'
                  : getEarningsQualityBadgeMeta(pick.earnings_quality_tag, sanitizedBadgeLabel)
                      .badgeClass
              }
            >
              {sanitizedBadgeLabel}
            </span>
          ) : isCaution &&
            pick.invest_profit_share_3y_pct !== null &&
            pick.invest_profit_share_3y_pct !== undefined ? (
            <span className="quality-badge quality-badge-red">
              {`投资占比 ${formatForensicRatioPct(pick.invest_profit_share_3y_pct)}`}
            </span>
          ) : null}
          <Tag color={pick.total_score >= 70 ? 'green' : pick.total_score >= 45 ? 'blue' : 'amber'}>
            {`${pick.total_score} 分`}
          </Tag>
        </div>
      </div>
      {stats.length > 0 ? (
        <div className="discovery-pick-stats tnum">
          {stats.map((stat) => (
            <span key={stat}>{stat}</span>
          ))}
        </div>
      ) : null}
      <p className="discovery-pick-reason">{sanitizedReason}</p>
    </div>
  )
}

function DiscoveryThemeCardView({
  theme,
  styleIndices,
  onQuickFilter,
}: {
  theme: DiscoveryThemeCard
  styleIndices: readonly StyleRegimeIndex[]
  onQuickFilter?: (filter: ScreenerQualityFilter) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const signalMeta = themeSignalMeta(theme.signal, theme.theme_id)
  const metrics = theme.metrics ?? []
  const picks = theme.picks ?? []
  const cautionPicks = theme.caution_picks ?? []
  const visiblePicks = expanded ? picks : picks.slice(0, DEFAULT_VISIBLE_PICKS)
  const visibleCautionPicks = expanded ? cautionPicks : cautionPicks.slice(0, DEFAULT_VISIBLE_PICKS)
  const hasOverflow =
    picks.length > DEFAULT_VISIBLE_PICKS || cautionPicks.length > DEFAULT_VISIBLE_PICKS
  const totalPickCount = picks.length + cautionPicks.length
  const compareCodes = theme.compare_codes ?? []
  const quickAction = onQuickFilter ? quickFilterForTheme(theme.theme_id) : null
  const showFooter = compareCodes.length >= 2 || quickAction !== null

  return (
    <article className="discovery-card" aria-label={theme.title}>
      <div className="discovery-card-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 className="discovery-card-title label-with-hint">
            <span>{theme.title}</span>
            <InfoHint term={themeGlossaryKey(theme.theme_id)} />
          </h3>
          <p className="discovery-card-sub">{theme.subtitle}</p>
        </div>
        <Tag color={signalMeta.color}>{signalMeta.label}</Tag>
      </div>

      <div
        className={`discovery-verdict-box discovery-verdict-${theme.signal === 'na' ? 'blue' : theme.signal}`}
      >
        <strong>{sanitizeForensicText(theme.verdict)}</strong>
        <span>{sanitizeForensicText(theme.regime_summary)}</span>
      </div>

      {metrics.length > 0 ? (
        <div className="discovery-metrics-grid">
          {metrics.map((metric) => (
            <div key={metric.label} className="discovery-metric-tile">
              <span className="discovery-metric-label">{metric.label}</span>
              <span className={`discovery-metric-val ${metricToneClass(metric.tone)}`.trim()}>
                {metric.value_text}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {theme.theme_id === 'tech_vs_dividend_rotation' && styleIndices.length > 0 ? (
        <div className="discovery-style-bars" aria-label="风格指数近20日涨跌与60日回撤">
          {styleIndices.map((idx) => (
            <div key={idx.code} className="discovery-style-row">
              <div className="discovery-style-head" style={{ flexWrap: 'wrap' }}>
                <span className="row" style={{ justifyContent: 'flex-start', gap: 6 }}>
                  <strong>{idx.name}</strong>
                  <Tag color={idx.market === 'US' ? 'blue' : 'gray'}>{idx.market}</Tag>
                </span>
                <span className="tnum small">
                  {`20D ${formatSignedPct(idx.change_20d_pct, 1)} · 60D回撤 ${formatPct(idx.drawdown_60d_pct, 1)}`}
                </span>
              </div>
              <div className="style-bar-track" aria-hidden="true">
                <div
                  className={styleBarFillClass(idx)}
                  style={{ width: `${styleBarWidthPct(idx)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {visiblePicks.length > 0 ? (
        <div className="discovery-picks-list">
          {visiblePicks.map((pick) => (
            <DiscoveryPickRow key={pick.code} pick={pick} />
          ))}
        </div>
      ) : (
        <p className="small muted">当前同步池内暂无符合该主题阈值的候选标的。</p>
      )}

      {visibleCautionPicks.length > 0 ? (
        <div
          className="discovery-caution-strip discovery-caution-strip-red"
          role="region"
          aria-label="高投资收益依赖 / 盈利失真警示标的"
        >
          <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
            <strong>高投资收益依赖 / 盈利失真警示标的</strong>
            <InfoHint term="invest_profit_share" />
          </div>
          <div className="discovery-picks-list">
            {visibleCautionPicks.map((pick) => (
              <DiscoveryPickRow key={pick.code} pick={pick} isCaution />
            ))}
          </div>
        </div>
      ) : null}

      {hasOverflow ? (
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          <button
            type="button"
            className="btn-ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? '收起' : `展开更多（共 ${totalPickCount} 只）`}
          </button>
        </div>
      ) : null}

      {showFooter ? (
        <div className="discovery-card-actions">
          {compareCodes.length >= 2 ? (
            <Link className="btn-cta-sm" to={`/compare?codes=${compareCodes.join(',')}`}>
              {`一键同池对比 (${compareCodes.length})`}
            </Link>
          ) : (
            <span />
          )}
          {quickAction && onQuickFilter ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => onQuickFilter(quickAction.filter)}
            >
              {quickAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

export function DiscoveryBoard({
  onQuickFilter,
}: {
  onQuickFilter?: (filter: ScreenerQualityFilter) => void
}) {
  const { data: discovery, isPending, isFetching, isError, error, refetch } = useMarketDiscovery()
  const crossAsset = discovery?.cross_asset
  const themes = discovery?.themes ?? []
  const styleIndices = crossAsset?.style_indices ?? []
  const warnings = crossAsset?.warnings ?? []

  return (
    <section
      className="card-machined bento-pad stack"
      style={{ gap: 18 }}
      aria-label="价值奇点机会挖掘看板"
    >
      <div className="sec-head" style={{ marginBottom: 0 }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ justifyContent: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <span className="eyebrow-pill">
              <span className="live-beacon" />
              跨资产机会 · 财报排雷看板
            </span>
            <h2 className="sec-title">
              <GlossaryLabel
                label="价值奇点 · 跨资产与风格机会看板"
                term="macro_discovery_board"
                size="md"
              />
            </h2>
            {isFetching && discovery ? <Tag color="blue">更新中...</Tag> : null}
          </div>
          <p className="sec-sub">
            {discovery
              ? `美债利率锚、黄金与风格轮动 × 本地全量快照利润鉴真（已追踪 ${discovery.synced_stock_count} 支）`
              : '美债利率锚、黄金与风格轮动 × 本地全量快照利润鉴真发现看板'}
          </p>
        </div>

        {discovery ? (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Tag color="blue">{`已追踪 ${discovery.synced_stock_count} 支深度快照`}</Tag>
            <Tag color="gray">{discovery.as_of}</Tag>
          </div>
        ) : null}
      </div>

      {isPending && !discovery ? (
        <LoadingBlock lines={4} />
      ) : isError ? (
        <ErrorBlock
          title="跨资产发现看板暂不可用"
          message={error instanceof Error ? error.message : '未知错误'}
          onRetry={() => {
            void refetch()
          }}
        />
      ) : !discovery ? (
        <EmptyBlock title="暂无跨资产发现数据" hint="请稍后刷新重试。" />
      ) : (
        <>
          <MacroPulseStrip crossAsset={crossAsset} />
          {warnings.length > 0 ? (
            <p className="small muted">{`部分跨资产指标提示：${warnings.join('；')}`}</p>
          ) : null}
          {themes.length > 0 ? (
            <div className="discovery-grid">
              {themes.map((theme) => (
                <DiscoveryThemeCardView
                  key={theme.theme_id}
                  theme={theme}
                  styleIndices={styleIndices}
                  onQuickFilter={onQuickFilter}
                />
              ))}
            </div>
          ) : (
            <EmptyBlock
              title="暂无跨资产发现主题线索"
              hint="同步跨资产行情与个股快照后将自动生成机会卡片。"
            />
          )}
        </>
      )}
    </section>
  )
}
