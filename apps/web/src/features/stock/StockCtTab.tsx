import { useState } from 'react'
import { Card } from '../../components/ui/Card'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import type { CtCheckItem, StockSnapshotPayload } from '../../types/api'
import { StockMdaDiffPanel } from './StockMdaDiffPanel'
import {
  formatEvidenceMetric,
  getCtCheckStatusMeta,
  getEvidenceMetricLabel,
  SIGNAL_META,
} from './stockHelpers'

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
        <Card title="CT 排雷规则列表">
          <EmptyBlock title="暂无财务 CT 检查项" />
        </Card>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {ct.checks.map((check) => {
            const statusMeta = getCtCheckStatusMeta(check)
            const isExpanded = Boolean(expandedRules[check.rule_id])
            const metricKeys = collectEvidenceKeys(check)
            const evidencesDesc = [...check.evidences].sort((a, b) => b.year - a.year)

            return (
              <Card key={check.rule_id}>
                <div className="ct-rule-header">
                  <div className="stack" style={{ gap: 6 }}>
                    <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
                      <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
                      <strong>{check.title}</strong>
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
                          <th>摘要口径</th>
                          {metricKeys.map((key) => (
                            <th key={key} style={{ textAlign: 'right' }}>
                              {getEvidenceMetricLabel(key)}
                            </th>
                          ))}
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
