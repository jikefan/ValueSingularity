import {
  type EarningsQualityBadgeMeta as SharedEarningsQualityBadgeMeta,
  getEarningsQualityBadgeMeta as getSharedEarningsQualityBadgeMeta,
} from '../../lib/earningsQuality'
import { fmtNum, formatNum, formatPct, formatSignedPct, formatYi } from '../../lib/format'
import type {
  CtCheckItem,
  EarningsQualityTag,
  ReverseDcfSensitivityRow,
  SignalLight,
  StockDetail,
  StockForensicsSection,
  StockSnapshotPayload,
} from '../../types/api'

export type StatusBadgeMeta = {
  label: string
  color: 'green' | 'amber' | 'rose' | 'gray'
}

export const SIGNAL_META: Record<SignalLight, StatusBadgeMeta> = {
  green: { label: '绿灯', color: 'green' },
  yellow: { label: '黄灯', color: 'amber' },
  red: { label: '红灯', color: 'rose' },
  na: { label: '待补充', color: 'gray' },
}

export const SHAREHOLDER_STATUS_META: Record<SignalLight, StatusBadgeMeta> = {
  green: { label: '现金回馈充裕', color: 'green' },
  yellow: { label: '回报基本稳健', color: 'amber' },
  red: { label: '股权抽血 / 回报承压', color: 'rose' },
  na: { label: '数据不足', color: 'gray' },
}

export const FORMULA_NOTE_TITLES: Record<string, string> = {
  radar: '五维定量雷达模型',
  financial_radar: '金融业专项五维评价口径',
  valuation_percentiles: '估值历史分位与采样规则',
  graham: '格雷厄姆数字与安全边际',
  roic_approx: '近似投入资本回报率 (ROIC)',
  reverse_dcf: '逆向 DCF 反推边界说明',
  shareholder_return: '股东净回报与 FCF 覆盖倍数',
  ct_scanner: '财务排雷 CT 扫描口径',
  forensics: '利润含金量与杜邦/资本配置口径',
}

export const RADAR_DIMENSION_KEYS = [
  'profitability',
  'moat',
  'balance_sheet',
  'cashflow_quality',
  'valuation_margin',
] as const

export type RadarDimensionKey = (typeof RADAR_DIMENSION_KEYS)[number]

export type RadarDimensionItem = {
  key: RadarDimensionKey
  label: string
  score: number
}

const DEFAULT_RADAR_LABELS: Record<RadarDimensionKey, string> = {
  profitability: '盈利能力',
  moat: '护城河',
  balance_sheet: '资产负债',
  cashflow_quality: '现金流质量',
  valuation_margin: '估值安全边际',
}

export type StockVerdict = {
  badge: string
  tone: 'green' | 'amber' | 'rose' | 'blue'
  summary: string
}

export type EarningsQualityBadgeMeta = SharedEarningsQualityBadgeMeta

export type ForensicVerdictTone = EarningsQualityBadgeMeta['verdictTone']

export type ForensicBridgeKind = 'core' | 'invest' | 'subsidy' | 'assets'

/** Maps earnings quality tag and optional label to semantic badge class and display text. */
export function getEarningsQualityBadgeMeta(
  tag: EarningsQualityTag | null | undefined,
  customLabel?: string | null,
): EarningsQualityBadgeMeta {
  return getSharedEarningsQualityBadgeMeta(tag, customLabel)
}

/** Resolves discovery-verdict-box tone matching the earnings quality tag. */
export function getEarningsQualityVerdictTone(
  tag: EarningsQualityTag | null | undefined,
): ForensicVerdictTone {
  return getSharedEarningsQualityBadgeMeta(tag).verdictTone
}

/** Computes bridge step highlight class from forensic share thresholds. */
export function getForensicBridgeStepClass(
  kind: ForensicBridgeKind,
  pct: number | null | undefined,
  tag?: EarningsQualityTag | null,
): string {
  if (tag === 'financial_special') {
    return 'forensic-bridge-step'
  }
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return 'forensic-bridge-step'
  }
  switch (kind) {
    case 'core':
      return pct >= 75 ? 'forensic-bridge-step forensic-bridge-core' : 'forensic-bridge-step'
    case 'invest':
      if (pct >= 35) return 'forensic-bridge-step forensic-bridge-danger'
      if (pct >= 20) return 'forensic-bridge-step forensic-bridge-warn'
      return 'forensic-bridge-step'
    case 'subsidy':
      if (pct >= 45) return 'forensic-bridge-step forensic-bridge-danger'
      if (pct >= 25) return 'forensic-bridge-step forensic-bridge-warn'
      return 'forensic-bridge-step'
    case 'assets':
      if (pct >= 45) return 'forensic-bridge-step forensic-bridge-danger'
      if (pct >= 35) return 'forensic-bridge-step forensic-bridge-warn'
      return 'forensic-bridge-step'
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

/** Evaluates whether the workstation header should show a forensic profit-truth caution strip. */
export function getForensicCautionAlertState(forensics: StockForensicsSection | null | undefined): {
  show: boolean
  highSeverity: boolean
} {
  if (!forensics || forensics.earnings_quality_tag === 'financial_special') {
    return { show: false, highSeverity: false }
  }
  const tag = forensics.earnings_quality_tag
  const investShare = forensics.invest_profit_share_3y_pct ?? 0
  const assetsRatio = forensics.investment_assets_ratio_pct ?? 0
  const nonRecurringShare = forensics.non_recurring_share_3y_pct ?? 0

  const show =
    tag === 'investment_driven' ||
    tag === 'subsidy_inflated' ||
    tag === 'cashflow_divergent' ||
    investShare >= 25 ||
    assetsRatio >= 25

  const highSeverity =
    tag === 'investment_driven' ||
    tag === 'subsidy_inflated' ||
    investShare >= 50 ||
    nonRecurringShare >= 45 ||
    assetsRatio >= 50

  return { show, highSeverity }
}

export type FinancialPbRoeMetrics = {
  pb: number | null
  pbPercentile10y: number | null
  roe5yAvgPct: number | null
  roe10yMinPct: number | null
  impliedEarningsYieldPct: number | null
  dividendYieldPct: number | null
}

/** Resolves CT rule badge metadata, distinguishing financial industry exemptions from missing data. */
export function getCtCheckStatusMeta(check: CtCheckItem): StatusBadgeMeta {
  switch (check.status) {
    case 'na':
      if (check.na_reason === 'industry_exempt' || check.summary.includes('金融行业结构特殊')) {
        return { label: '行业不适用', color: 'gray' }
      }
      return { label: '待补充', color: 'gray' }
    case 'green':
    case 'yellow':
    case 'red':
      return SIGNAL_META[check.status]
    default: {
      const exhaustive: never = check.status
      return exhaustive
    }
  }
}

/** Detects financial-institution snapshot mode including legacy cached rows lacking scoring_profile. */
export function isFinancialSnapshot(snapshot: StockSnapshotPayload): boolean {
  if (snapshot.radar.scoring_profile === 'financial') {
    return true
  }
  if (snapshot.radar.dimension_labels?.cashflow_quality === '资本与分红耐力') {
    return true
  }
  if (snapshot.reverse_dcf.note.includes('金融行业')) {
    return true
  }
  return snapshot.financial_ct.checks.some(
    (check) =>
      check.status === 'na' &&
      (check.na_reason === 'industry_exempt' || check.summary.includes('金融行业结构特殊')),
  )
}

/** Returns ordered 5 radar dimensions with financial-sector label fallback for cached snapshots. */
export function getRadarDimensions(snapshot: StockSnapshotPayload): RadarDimensionItem[] {
  const isFinancial = isFinancialSnapshot(snapshot)
  const explicitLabels = snapshot.radar.dimension_labels

  return RADAR_DIMENSION_KEYS.map((key) => {
    const fallbackLabel =
      key === 'cashflow_quality' && isFinancial ? '资本与分红耐力' : DEFAULT_RADAR_LABELS[key]
    const label = explicitLabels?.[key]?.trim() || fallbackLabel
    return {
      key,
      label,
      score: snapshot.radar[key],
    }
  })
}

/** Derives PB / ROE implied earnings yield metrics for financial institutions. */
export function computeFinancialPbRoeMetrics(
  snapshot: StockSnapshotPayload,
): FinancialPbRoeMetrics {
  const pb = snapshot.valuation.pb ?? null
  const roe5yAvgPct = snapshot.moat.roe_5y_avg_pct ?? null
  const impliedEarningsYieldPct =
    pb !== null &&
    roe5yAvgPct !== null &&
    Number.isFinite(pb) &&
    Number.isFinite(roe5yAvgPct) &&
    pb > 0
      ? Number((roe5yAvgPct / pb).toFixed(2))
      : null

  return {
    pb,
    pbPercentile10y: snapshot.valuation.pb_percentile_10y ?? null,
    roe5yAvgPct,
    roe10yMinPct: snapshot.moat.roe_10y_min_pct ?? null,
    impliedEarningsYieldPct,
    dividendYieldPct:
      snapshot.valuation.dividend_yield_pct ??
      snapshot.shareholder_return.current_dividend_yield_pct ??
      null,
  }
}

/** Synthesizes a 5-second non-advisory quantitative conclusion from radar, CT alerts, and valuation percentiles. */
export function deriveStockVerdict(snapshot: StockSnapshotPayload): StockVerdict {
  const isFinancial = isFinancialSnapshot(snapshot)
  const { total_score: totalScore } = snapshot.radar
  const { red_count: redCount, yellow_count: yellowCount } = snapshot.financial_ct
  const pePct = snapshot.valuation.pe_percentile_10y ?? null
  const pbPct = snapshot.valuation.pb_percentile_10y ?? null
  const primaryPct = isFinancial ? (pbPct ?? pePct) : (pePct ?? pbPct)
  const pctLabel = isFinancial && pbPct !== null ? '10Y PB 分位' : '10Y PE 分位'
  const roe5y = snapshot.moat.roe_5y_avg_pct ?? null
  const divYield =
    snapshot.valuation.dividend_yield_pct ??
    snapshot.shareholder_return.current_dividend_yield_pct ??
    null

  let badge: string
  let tone: StockVerdict['tone']

  if (redCount >= 2 || (redCount >= 1 && totalScore < 55)) {
    tone = 'rose'
    badge = '排雷警示 · 审慎核查'
  } else if (redCount >= 1) {
    tone = 'amber'
    badge = '存在排雷红灯 · 重点排查'
  } else if (totalScore >= 70 && primaryPct !== null && primaryPct <= 35) {
    tone = 'green'
    badge = isFinancial ? '稳健高息 · 估值低分位' : '高质低估 · 击球区特征'
  } else if (totalScore >= 70) {
    tone = 'blue'
    badge = '基本面优异 · 关注估值水位'
  } else if (totalScore >= 50) {
    tone = 'amber'
    badge = '中性观察 · 均衡跟踪'
  } else {
    tone = 'rose'
    badge = '综合偏弱 · 待基本面改善'
  }

  const clauses: string[] = [
    `${isFinancial ? '金融专项口径' : '定量'}雷达 ${totalScore}/100`,
    `财务 CT ${redCount} 红 ${yellowCount} 黄`,
  ]
  if (primaryPct !== null) {
    clauses.push(`${pctLabel} ${formatPct(primaryPct, 1)}`)
  }
  if (roe5y !== null) {
    clauses.push(`5Y 平均 ROE ${formatPct(roe5y, 1)}`)
  }
  if (divYield !== null && (isFinancial || divYield >= 2)) {
    clauses.push(`股息率 ${formatPct(divYield, 2)}`)
  }

  return {
    badge,
    tone,
    summary: `${clauses.join('，')}。`,
  }
}

/** Exports a complete, objective Markdown research brief for local download. */
export function formatStockDossierMarkdown(
  stock: StockDetail,
  snapshot: StockSnapshotPayload,
): string {
  const isFinancial = isFinancialSnapshot(snapshot)
  const verdict = deriveStockVerdict(snapshot)
  const dimensions = getRadarDimensions(snapshot)
  const {
    valuation,
    reverse_dcf: reverseDcf,
    financial_ct: ct,
    shareholder_return: sReturn,
    moat,
  } = snapshot
  const industry = [stock.industry_sw1, stock.industry_sw2].filter(Boolean).join(' / ') || '未分类'
  const divYield = valuation.dividend_yield_pct ?? sReturn.current_dividend_yield_pct ?? null

  const lines: string[] = [
    `# ${stock.name} (${stock.code}) 定量研究简报`,
    '',
    `- 交易所：${stock.exchange} | 申万行业：${industry}`,
    `- 快照日期：${snapshot.as_of} | 数据源：${snapshot.data_source} | 评估口径：${isFinancial ? '金融业专项口径' : '通用企业口径'}`,
    '',
    '## 5 秒核心结论',
    `- **${verdict.badge}**：${verdict.summary}`,
    '',
    `## 五维定量雷达评分（总分 ${snapshot.radar.total_score} / 100）`,
    ...dimensions.map((dim) => `- ${dim.label}：${dim.score} / 100`),
    '',
    '## 估值坐标与隐含预期',
    `- 最新收盘价：${formatNum(valuation.close, 2)} | 总市值：${formatYi(valuation.total_mv_yuan)}`,
    `- PE(TTM)：${formatNum(valuation.pe_ttm, 2)}（5Y 分位 ${formatPct(valuation.pe_percentile_5y, 1)} · 10Y 分位 ${formatPct(valuation.pe_percentile_10y, 1)}）`,
    `- PB：${formatNum(valuation.pb, 2)}（10Y 分位 ${formatPct(valuation.pb_percentile_10y, 1)}） | 当前股息率：${formatPct(divYield, 2)}`,
    `- 格雷厄姆数字：${formatNum(valuation.graham_number, 2)}（安全边际 ${formatSignedPct(valuation.graham_margin_pct, 2)}）`,
  ]

  if (isFinancial) {
    const pbRoe = computeFinancialPbRoeMetrics(snapshot)
    lines.push(
      '',
      '### 金融业替代估值：PB-ROE 隐含长期回报参考',
      `- 当前 PB：${formatNum(pbRoe.pb, 2)} | 5年平均 ROE：${formatPct(pbRoe.roe5yAvgPct, 2)}`,
      `- 隐含当期盈利收益率 (ROE / PB)：${formatPct(pbRoe.impliedEarningsYieldPct, 2)}`,
      `- 当前股息率：${formatPct(pbRoe.dividendYieldPct, 2)}`,
      `- 口径说明：${reverseDcf.note}`,
    )
  } else {
    lines.push(
      '',
      '### Reverse DCF 逆向估值反推',
      `- 企业价值 EV：${formatYi(reverseDcf.enterprise_value_yuan)} | 基准 FCF（${reverseDcf.base_fcf_years} 年均值）：${formatYi(reverseDcf.base_fcf_yuan)}`,
      `- 默认假设：WACC ${fmtNum(reverseDcf.discount_rate_pct, 1)}% · 终值倍数 ${fmtNum(reverseDcf.terminal_multiple, 1)}x`,
      `- 市场隐含 10Y FCF CAGR：${reverseDcf.solvable ? formatSignedPct(reverseDcf.implied_fcf_cagr_pct, 2) : '不可求解'} | 历史营收 CAGR：${formatSignedPct(reverseDcf.historical_revenue_cagr_pct, 2)}`,
      `- 反推说明：${reverseDcf.note}`,
    )
  }

  lines.push(
    '',
    `## 财务排雷 CT 扫描（总评：${SIGNAL_META[ct.overall_status].label} · ${ct.red_count} 红 / ${ct.yellow_count} 黄 / ${ct.green_count} 绿）`,
    ...ct.checks.map((check) => {
      const meta = getCtCheckStatusMeta(check)
      return `- [${meta.label}] ${check.title}（${check.value_text}）：${check.summary}`
    }),
    '',
    '## 护城河与股东净回报',
    `- 5年平均 ROE：${formatPct(moat.roe_5y_avg_pct, 2)} | 10年最低 ROE：${formatPct(moat.roe_10y_min_pct, 2)} | 近似 ROIC：${formatPct(moat.roic_approx_pct, 2)}`,
    `- 近 ${sReturn.window_years} 年股东净回报：${formatYi(sReturn.net_return_yuan)}（FCF 覆盖倍数 ${sReturn.fcf_coverage_ratio !== null && sReturn.fcf_coverage_ratio !== undefined ? `${fmtNum(sReturn.fcf_coverage_ratio, 2)}x` : '—'}）`,
    `- 回报结论：${sReturn.verdict}`,
  )

  if (snapshot.forensics) {
    const forensics = snapshot.forensics
    const qualityMeta = getEarningsQualityBadgeMeta(
      forensics.earnings_quality_tag,
      forensics.earnings_quality_label,
    )
    const findingsLines =
      forensics.findings && forensics.findings.length > 0
        ? forensics.findings.map(
            (finding) =>
              `- [${SIGNAL_META[finding.status].label}] ${finding.title}（${finding.metric_text}）：${finding.headline}。${finding.detail}`,
          )
        : []
    lines.push(
      '',
      '## 利润真相与盈利成色深度鉴真',
      `- 盈利成色标签：${qualityMeta.label}`,
      `- 鉴真结论：${forensics.verdict}`,
      `- 近 3 年主业核心利润占比：${formatPct(forensics.core_profit_share_3y_pct, 1)} | 投资与公允价值占比：${formatPct(forensics.invest_profit_share_3y_pct, 1)} | 补贴及一次性占比：${formatPct(forensics.non_recurring_share_3y_pct, 1)}`,
      `- 表内投资类资产占比：${formatPct(forensics.investment_assets_ratio_pct, 1)}（规模 ${formatYi(forensics.investment_assets_yuan)}） | OCF / 主业核心利润：${formatPct(forensics.ocf_to_core_profit_3y_pct, 1)}`,
      ...findingsLines,
    )
  }

  lines.push(
    '',
    '## 空头视角与核心风险提示',
    ...(snapshot.radar.bear_cases.length > 0
      ? snapshot.radar.bear_cases.map((item) => `- ${item}`)
      : ['- 暂无显著警示']),
  )

  const formulaEntries = Object.entries(snapshot.formula_notes)
  if (formulaEntries.length > 0) {
    lines.push(
      '',
      '## 方法论与模型边界声明',
      ...formulaEntries.map(([key, note]) => `- **${FORMULA_NOTE_TITLES[key] ?? key}**：${note}`),
    )
  }

  lines.push(
    '',
    '---',
    '免责声明：本简报由本地定量快照数据确定性导出，仅供研究复盘参考，不构成任何证券投资建议或主观目标价预测。',
  )

  return lines.join('\n')
}

type EvidenceMetricMeta = {
  label: string
  kind: 'yuan' | 'pct' | 'ratio' | 'text'
}

const CT_EVIDENCE_METRIC_META: Record<string, EvidenceMetricMeta> = {
  monetary_funds_yuan: { label: '货币资金', kind: 'yuan' },
  interest_debt_yuan: { label: '有息负债', kind: 'yuan' },
  cash_to_assets_pct: { label: '货币资金/总资产', kind: 'pct' },
  debt_to_assets_pct: { label: '有息负债/总资产', kind: 'pct' },
  cip_yuan: { label: '在建工程', kind: 'yuan' },
  fixed_asset_yuan: { label: '固定资产', kind: 'yuan' },
  cip_to_assets_pct: { label: '在建工程/总资产', kind: 'pct' },
  cip_to_fixed_pct: { label: '在建工程/固定资产', kind: 'pct' },
  ocf_yuan: { label: '经营现金流', kind: 'yuan' },
  net_profit_yuan: { label: '归母净利润', kind: 'yuan' },
  ocf_to_profit: { label: '净现比 (OCF/净利)', kind: 'ratio' },
  receivable_yuan: { label: '应收票据及账款', kind: 'yuan' },
  inventory_yuan: { label: '存货', kind: 'yuan' },
  tied_to_revenue_pct: { label: '两金/营收', kind: 'pct' },
  tied_to_assets_pct: { label: '两金/总资产', kind: 'pct' },
  growth_gap_pct: { label: '两金增速−营收增速', kind: 'pct' },
  goodwill_yuan: { label: '商誉', kind: 'yuan' },
  parent_equity_yuan: { label: '归母净资产', kind: 'yuan' },
  goodwill_to_equity_pct: { label: '商誉/归母净资产', kind: 'pct' },
  goodwill_to_assets_pct: { label: '商誉/总资产', kind: 'pct' },
  pledge_ratio_pct: { label: '质押比例', kind: 'pct' },
  pledge_market_cap_yuan: { label: '质押市值', kind: 'yuan' },
  audit_opinion: { label: '审计意见', kind: 'text' },
}

export function getEvidenceMetricLabel(key: string): string {
  return CT_EVIDENCE_METRIC_META[key]?.label ?? key
}

export function formatEvidenceMetric(
  key: string,
  value: number | string | null | undefined,
): string {
  if (value === null || value === undefined) {
    return '—'
  }
  if (typeof value === 'string') {
    return value || '—'
  }
  if (!Number.isFinite(value)) {
    return '—'
  }
  const meta = CT_EVIDENCE_METRIC_META[key]
  if (meta?.kind === 'yuan' || key.endsWith('_yuan')) {
    return formatYi(value)
  }
  if (meta?.kind === 'pct' || key.endsWith('_pct')) {
    return formatPct(value, 2)
  }
  if (meta?.kind === 'ratio') {
    return `${fmtNum(value, 2)}x`
  }
  return fmtNum(value, 2)
}

export type SensitivityMatrix = {
  discountRates: number[]
  multiples: number[]
  values: Map<string, number | null>
}

export function buildSensitivityMatrix(
  rows: readonly ReverseDcfSensitivityRow[],
): SensitivityMatrix {
  const rateSet = new Set<number>()
  const multipleSet = new Set<number>()
  const values = new Map<string, number | null>()

  for (const row of rows) {
    rateSet.add(row.discount_rate_pct)
    multipleSet.add(row.terminal_multiple)
    values.set(
      `${row.discount_rate_pct}:${row.terminal_multiple}`,
      row.implied_fcf_cagr_pct ?? null,
    )
  }

  return {
    discountRates: Array.from(rateSet).sort((a, b) => a - b),
    multiples: Array.from(multipleSet).sort((a, b) => a - b),
    values,
  }
}
