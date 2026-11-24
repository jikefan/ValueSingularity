import { useState } from 'react'
import { Card } from '../../components/ui/Card'
import { type CustomGlossaryEntry, InfoHint } from '../../components/ui/InfoHint'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import type { GlossaryKey } from '../../lib/glossary'
import type { CtCheckItem, StockSnapshotPayload } from '../../types/api'
import { StockMdaDiffPanel } from './StockMdaDiffPanel'
import {
  formatEvidenceMetric,
  getCtCheckStatusMeta,
  getEvidenceMetricLabel,
  SIGNAL_META,
} from './stockHelpers'

const CT_RULE_GLOSSARY_KEYS: Readonly<Record<string, GlossaryKey>> = {
  dual_high_cash_debt: 'ct_cash_debt_high',
  stalled_cip: 'ct_cip_bloat',
  ocf_profit_divergence: 'ct_ocf_divergence',
  receivable_inventory_bloat: 'ct_ar_inventory_bloat',
  goodwill_overhang: 'ct_goodwill_risk',
  shareholder_pledge: 'ct_pledge_risk',
  equity_pledge: 'ct_pledge_risk',
  audit_opinion: 'ct_audit_opinion',
}

type EvidenceMetricHint =
  { kind: 'glossary'; term: GlossaryKey } | { kind: 'custom'; entry: CustomGlossaryEntry }

const CT_EVIDENCE_METRIC_HINTS: Readonly<Record<string, EvidenceMetricHint>> = {
  monetary_funds_yuan: {
    kind: 'custom',
    entry: {
      summary:
        '资产负债表期末货币资金余额（含现金、银行存款等），用于与有息负债对照核查“存贷双高”风险。',
      reading: '若高货币资金长期与高有息负债并存但利息收益率偏低，需警惕受限资金或虚增存款。',
    },
  },
  interest_debt_yuan: { kind: 'glossary', term: 'interest_bearing_debt' },
  cash_to_assets_pct: {
    kind: 'custom',
    entry: {
      summary: '货币资金占期末总资产的比重，衡量账面现金资产在资产结构中的体量。',
      formula: '货币资金/总资产 = 货币资金 ÷ 总资产 × 100%。',
      reading: '当达到或超过 25% 且同时伴随高比例有息负债时，将触发存贷双高重点排查。',
    },
  },
  debt_to_assets_pct: {
    kind: 'custom',
    entry: {
      summary: '刚性有息负债占期末总资产的比重，衡量付息债务杠杆水平。',
      formula: '有息负债/总资产 = 有息负债 ÷ 总资产 × 100%。',
      reading:
        '比率越高财务费用与偿债压力越大；若同时货币资金/总资产也高于阈值，即构成存贷双高特征。',
    },
  },
  cip_yuan: {
    kind: 'custom',
    entry: {
      summary: '报告期末尚未完工转固的在建工程账面余额（亿元）。',
      reading: '需追踪主要工程预算投入与实际完工进度，警惕长期停工或刻意延迟转固规避折旧。',
    },
  },
  fixed_asset_yuan: {
    kind: 'custom',
    entry: {
      summary: '已达到预定可使用状态并按期计提折旧的厂房、机器设备等固定资产账面净值（亿元）。',
      reading: '用于与在建工程规模对比，检验资本开支是否正常转固投产。',
    },
  },
  cip_to_assets_pct: {
    kind: 'custom',
    entry: {
      summary: '在建工程占总资产的比重，用于识别在建项目长期占款而不转固的异常。',
      formula: '在建工程/总资产 = 在建工程 ÷ 总资产 × 100%。',
      reading: '连续多年处于高位（如 ≥ 10%）却不见固定资产同步转固或营收放量时，需重点核查。',
    },
  },
  cip_to_fixed_pct: {
    kind: 'custom',
    entry: {
      summary: '在建工程余额相对存量固定资产净值的比率，刻画扩产强度与潜在待转固折旧压力。',
      formula: '在建工程/固定资产 = 在建工程 ÷ 固定资产 × 100%。',
      reading: '显著高于同业常态且久未下降时，需警惕未来集中转固后的折旧吞噬利润。',
    },
  },
  ocf_yuan: { kind: 'glossary', term: 'ocf' },
  net_profit_yuan: { kind: 'glossary', term: 'net_profit' },
  ocf_to_profit: { kind: 'glossary', term: 'cash_profit_ratio' },
  receivable_yuan: {
    kind: 'custom',
    entry: {
      summary: '企业因销售商品或提供劳务而尚未收回的应收票据与应收账款账面余额（亿元）。',
      reading: '持续快于营收增长通常代表向下游放宽信用赊销或回款质量恶化。',
    },
  },
  inventory_yuan: {
    kind: 'custom',
    entry: {
      summary: '期末库存商品、原材料、在产品等存货账面余额（亿元）。',
      reading: '需区分主动备货扩产与下游滞销积压，关注后续跌价准备计提风险。',
    },
  },
  tied_to_revenue_pct: {
    kind: 'custom',
    entry: {
      summary: '“两金”（应收票据及账款 + 存货）合计占当期营业收入的比重，衡量营运资金占款压力。',
      formula: '两金/营收 = (应收票据及账款 + 存货) ÷ 营业收入 × 100%。',
      reading: '占比持续抬升说明做同样生意需要垫付更多运营资金，自由现金流易受挤压。',
    },
  },
  tied_to_assets_pct: {
    kind: 'custom',
    entry: {
      summary: '应收票据及账款与存货合计占期末总资产的比例。',
      formula: '两金/总资产 = (应收票据及账款 + 存货) ÷ 总资产 × 100%。',
      reading: '比例过高时，资产质量更容易受下游坏账和存货跌价波动冲击。',
    },
  },
  growth_gap_pct: {
    kind: 'custom',
    entry: {
      summary: '“两金”（应收与存货合计）同比增速减去同期营业收入同比增速的差值（百分点）。',
      formula: '两金增速−营收增速 = 两金同比增长率 − 营业收入同比增长率。',
      reading: '正值越大说明应收和存货膨胀越快于真实销售增长，常为渠道压货或回款转弱的领先信号。',
    },
  },
  goodwill_yuan: {
    kind: 'custom',
    entry: {
      summary: '公司历史高溢价并购形成的商誉账面净额（亿元），不参与常规摊销而需每年减值测试。',
      reading: '并购标的业绩一旦不达预期，大额商誉减值会直接击穿当期净利润。',
    },
  },
  parent_equity_yuan: {
    kind: 'custom',
    entry: {
      summary: '归属于上市公司母公司股东的所有者权益（账面净资产）总额（亿元）。',
      reading: '用作计算商誉减值风险对净资产缓冲垫冲击程度的分母基准。',
    },
  },
  goodwill_to_equity_pct: {
    kind: 'glossary',
    term: 'ct_goodwill_risk',
  },
  goodwill_to_assets_pct: {
    kind: 'custom',
    entry: {
      summary: '账面商誉占期末总资产的百分比。',
      formula: '商誉/总资产 = 商誉 ÷ 总资产 × 100%。',
      reading: '比例越高说明资产负债表对过往外延并购的依赖度越高。',
    },
  },
  pledge_ratio_pct: { kind: 'glossary', term: 'pledge_ratio' },
  pledge_market_cap_yuan: {
    kind: 'custom',
    entry: {
      summary: '按当前质押股数与最新参考股价估算的全市场质押股份总市值（亿元）。',
      reading: '反映一旦触发平仓线可能面临的潜在二级市场抛压体量。',
    },
  },
  audit_opinion: { kind: 'glossary', term: 'audit_opinion' },
}

function renderEvidenceMetricHint(key: string, label: string) {
  const mapped = CT_EVIDENCE_METRIC_HINTS[key]
  if (!mapped) {
    return (
      <InfoHint
        title={label}
        entry={{
          summary: `ClearTruth 财务排雷钻取明细字段「${label}」，用于交叉印证对应风险规则的原始财报读数。`,
        }}
      />
    )
  }
  return mapped.kind === 'glossary' ? (
    <InfoHint term={mapped.term} title={label} />
  ) : (
    <InfoHint title={label} entry={mapped.entry} />
  )
}

function collectEvidenceKeys(check: CtCheckItem): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const evidence of check.evidences) {
    for (const key of Object.keys(evidence.metrics)) {
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
  }
  return keys
}

export function StockCtTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const { financial_ct: ct, formula_notes: formulaNotes } = snapshot
  const [expandedRules, setExpandedRules] = useState<Record<string, boolean>>({})
  const overallMeta = SIGNAL_META[ct.overall_status]
  const exemptCount = ct.checks.filter(
    (check) =>
      check.status === 'na' &&
      (check.na_reason === 'industry_exempt' || check.summary.includes('金融行业结构特殊')),
  ).length

  function toggleRule(ruleId: string) {
    setExpandedRules((prev) => ({
      ...prev,
      [ruleId]: !prev[ruleId],
    }))
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title="风险排雷 · 财务 CT 机"
        hint="ct_scanner"
        extra={
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Tag color={overallMeta.color}>总评：{overallMeta.label}</Tag>
            <Tag color="rose">{ct.red_count} 红灯</Tag>
            <Tag color="amber">{ct.yellow_count} 黄灯</Tag>
            <Tag color="green">{ct.green_count} 绿灯</Tag>
            {exemptCount > 0 ? <Tag color="blue">{exemptCount} 项行业不适用</Tag> : null}
          </span>
        }
      >
        {formulaNotes.ct_scanner ? (
          <p className="small muted">{formulaNotes.ct_scanner}</p>
        ) : (
          <p className="small muted">
            自动扫描存贷双高、在建工程长期挂账、现金流背离、两金膨胀、商誉减值、股权质押与审计意见 7
            大风险维度。
          </p>
        )}
      </Card>

      {ct.checks.length === 0 ? (
        <Card title="CT 排雷规则列表" hint="ct_scanner">
          <EmptyBlock title="暂无财务 CT 检查项" />
        </Card>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {ct.checks.map((check) => {
            const statusMeta = getCtCheckStatusMeta(check)
            const isExpanded = Boolean(expandedRules[check.rule_id])
            const metricKeys = collectEvidenceKeys(check)
            const evidencesDesc = [...check.evidences].sort((a, b) => b.year - a.year)
            const ctRuleTerm = CT_RULE_GLOSSARY_KEYS[check.rule_id]

            return (
              <Card key={check.rule_id}>
                <div className="ct-rule-header">
                  <div className="stack" style={{ gap: 6 }}>
                    <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
                      <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
                      <span className="label-with-hint">
                        <strong>{check.title}</strong>
                        {ctRuleTerm ? (
                          <InfoHint term={ctRuleTerm} />
                        ) : (
                          <InfoHint
                            title={check.title}
                            entry={{
                              summary: check.summary,
                              formula: check.threshold,
                            }}
                          />
                        )}
                      </span>
                      <span className="mono soft small">{check.value_text}</span>
                    </div>
                    <p className="small soft">{check.summary}</p>
                    <div className="small muted">判定阈值：{check.threshold}</div>
                  </div>

                  {check.evidences.length > 0 ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      aria-expanded={isExpanded}
                      onClick={() => toggleRule(check.rule_id)}
                    >
                      {isExpanded ? '收起历年证据' : `展开历年证据 (${check.evidences.length})`}
                    </button>
                  ) : (
                    <Tag color="gray">暂无历年明细</Tag>
                  )}
                </div>

                {isExpanded && evidencesDesc.length > 0 ? (
                  <div className="table-wrap mt-16">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>年份</th>
                          <th>
                            <span className="label-with-hint">
                              <span>摘要口径</span>
                              <InfoHint
                                title="摘要口径"
                                entry={{
                                  summary: '对应年度年报或排雷规则所提取证据记录的科目口径说明。',
                                }}
                              />
                            </span>
                          </th>
                          {metricKeys.map((key) => {
                            const label = getEvidenceMetricLabel(key)
                            return (
                              <th key={key} style={{ textAlign: 'right' }}>
                                <span className="label-with-hint">
                                  <span>{label}</span>
                                  {renderEvidenceMetricHint(key, label)}
                                </span>
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {evidencesDesc.map((evidence, idx) => (
                          <tr key={`${evidence.year}-${evidence.label}-${idx}`}>
                            <td className="mono">{evidence.year}</td>
                            <td>{evidence.label}</td>
                            {metricKeys.map((key) => (
                              <td key={key} className="num">
                                {formatEvidenceMetric(key, evidence.metrics[key])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </Card>
            )
          })}
        </div>
      )}

      <StockMdaDiffPanel code={snapshot.code} stockName={snapshot.name} snapshotAvailable />
    </div>
  )
}
