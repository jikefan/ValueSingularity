import type { CustomGlossaryEntry } from '../../components/ui/InfoHint'
import { formatStockName } from '../../lib/format'
import type { MarketTemperature, StockScreenerItem, TemperatureLevel } from '../../types/api'

export const LEVEL_META: Record<
  TemperatureLevel,
  { label: string; color: 'gray' | 'green' | 'blue' | 'amber' | 'rose' }
> = {
  cold: { label: '冰点', color: 'blue' },
  cool: { label: '偏冷', color: 'green' },
  neutral: { label: '中性', color: 'gray' },
  warm: { label: '偏热', color: 'amber' },
  hot: { label: '过热', color: 'rose' },
}

export const INDEX_HINT_BY_CODE: Record<string, CustomGlossaryEntry> = {
  '000001': {
    summary: '上海证券交易所综合指数，覆盖上交所全部上市股票，按总市值加权反映沪市大盘整体表现。',
    reading: '受银行、能源、央企权重股影响较大；用于对照全市场大盘温度与权重走势。',
  },
  '399001': {
    summary: '深圳证券交易所成份指数，选取深市最具代表性的 500 家上市公司按自由流通市值加权编制。',
    reading: '先进制造、消费电子与成长蓝筹占比较高，常与上证指数交叉观察市场风格分化。',
  },
  '399006': {
    summary: '创业板核心宽基指数，聚焦深市创业板高成长创新与科技医药类头部企业。',
    reading: '弹性与波动率通常高于主板指数，可侧面反映市场风险偏好与成长赛道情绪。',
  },
  '000300': {
    summary:
      '沪深 300 指数，汇集沪深两市市值大、流动性好的 300 只核心蓝筹龙头，是机构与本系统决策账本的默认基准。',
    reading: '代表 A 股核心资产 Beta 基准，个股决策日记超额 Alpha 均以此指数同期涨跌作对照。',
  },
}

export function getIndexHintEntry(name: string): CustomGlossaryEntry {
  return {
    summary: `${name}的实时点位与当日涨跌幅快照，用于观察 A 股核心宽基市场的整体方向与 Beta 风险偏好。`,
    reading: '红色上涨、绿色下跌（符合 A 股红涨绿跌习惯）；指数短期涨跌不改变个股安全边际锚点。',
  }
}

const CURATED_FEATURED_TARGETS: ReadonlyArray<{ code: string; name: string; roleTag: string }> = [
  { code: '600519', name: '贵州茅台', roleTag: '现金牛' },
  { code: '600900', name: '长江电力', roleTag: '红利防守' },
  { code: '600177', name: '雅戈尔', roleTag: '投资依赖反例' },
  { code: '600036', name: '招商银行', roleTag: '高息银行' },
  { code: '300750', name: '宁德时代', roleTag: '制造龙头' },
]

export type FeaturedQuickLink = {
  code: string
  name: string
  badgeText: string | null
}

const REAL_POOL_MIN_SYNCED = 50

export function pickFeaturedSyncedStocks(
  items: readonly StockScreenerItem[],
  limit = 5,
  totalSynced = items.length,
): FeaturedQuickLink[] {
  if (limit <= 0 || (items.length === 0 && totalSynced < REAL_POOL_MIN_SYNCED)) {
    return []
  }

  const byCode = new Map(items.map((item) => [item.code, item]))
  const picked: FeaturedQuickLink[] = []
  const pickedCodes = new Set<string>()
  const seenIndustries = new Set<string>()
  const allowCuratedFallback = totalSynced >= REAL_POOL_MIN_SYNCED

  for (const target of CURATED_FEATURED_TARGETS) {
    if (picked.length >= limit) break
    const matched = byCode.get(target.code)
    if (!matched) {
      if (!allowCuratedFallback) continue
      picked.push({ code: target.code, name: target.name, badgeText: target.roleTag })
      pickedCodes.add(target.code)
      continue
    }
    picked.push({
      code: matched.code,
      name: formatStockName(matched.name),
      badgeText: target.roleTag,
    })
    pickedCodes.add(matched.code)
    const industryKey = matched.industry_sw1?.trim() ?? ''
    if (industryKey) seenIndustries.add(industryKey)
  }

  if (picked.length >= limit) {
    return picked
  }

  const remaining = items.filter((item) => !pickedCodes.has(item.code))
  const cleanFirst = [
    ...remaining.filter((item) => item.ct_red_count === 0),
    ...remaining.filter((item) => item.ct_red_count > 0),
  ]

  // Fill leftover slots with industry diversity before repeating industries.
  for (const item of cleanFirst) {
    if (picked.length >= limit) break
    const industryKey = item.industry_sw1?.trim() ?? ''
    if (industryKey && seenIndustries.has(industryKey)) continue
    if (industryKey) seenIndustries.add(industryKey)
    picked.push({
      code: item.code,
      name: formatStockName(item.name),
      badgeText: industryKey || null,
    })
    pickedCodes.add(item.code)
  }

  for (const item of cleanFirst) {
    if (picked.length >= limit) break
    if (pickedCodes.has(item.code)) continue
    const industryKey = item.industry_sw1?.trim() ?? ''
    picked.push({
      code: item.code,
      name: formatStockName(item.name),
      badgeText: industryKey || null,
    })
    pickedCodes.add(item.code)
  }

  return picked
}

export function plainMarketTemperatureTakeaway(temperature: MarketTemperature): string {
  const percentile = Math.max(0, Math.min(100, Math.round(temperature.pe_percentile)))
  const cheaperThanPct = Math.max(0, 100 - percentile)

  if (temperature.pe_percentile <= 40) {
    return temperature.equity_bond_spread > 0
      ? `全市场估值比历史上 ${cheaperThanPct}% 的时候都便宜，买股票相比存十年国债明显更有性价比，适合耐心挑便宜好公司。`
      : `全市场估值比历史上 ${cheaperThanPct}% 的时候都便宜，整体处在偏冷打折区间，重点看主业现金流稳健的低估标的。`
  }

  if (temperature.pe_percentile <= 70) {
    return temperature.equity_bond_spread > 0
      ? `全市场估值排在历史第 ${percentile}% 分位（不贵也不算极低），股票整体仍有一定性价比，但更要挑质地过硬的公司、不盲目追高。`
      : `全市场估值排在历史第 ${percentile}% 分位（温中性区间），股债收益差不算宽裕，买入更要盯紧价格安全垫。`
  }

  return `全市场估值比历史上 ${percentile}% 的时候都贵，市场情绪偏热，动手前务必留足安全边际、别在热闹处追涨。`
}
