import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { formatNum, formatPct, formatSignedPct, qualityTone } from '../../lib/format'
import { JOURNAL_ACTION_META } from '../../lib/journalLabels'
import { useJournalLedger } from '../../lib/useJournal'
import type { JournalEntryComparison } from '../../types/api'

function winRateTone(value: number | null | undefined): 'tone-good' | 'tone-bad' | '' {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return ''
  }
  return value >= 50 ? 'tone-good' : 'tone-bad'
}

function isFirstDayFlatItem(item: JournalEntryComparison): boolean {
  return (
    item.days_held === 0 &&
    (item.stock_return_pct ?? 0) === 0 &&
    (item.excess_return_pct === null ||
      item.excess_return_pct === undefined ||
      item.excess_return_pct === 0)
  )
}

export function DecisionLedgerPanel({ enabled }: { enabled: boolean }) {
  const ledgerQuery = useJournalLedger(enabled)
  const report = ledgerQuery.data
  const comparableItems =
    report?.items.filter(
      (item) => item.stock_return_pct !== null && item.stock_return_pct !== undefined,
    ) ?? []
  const isFirstDayFlatOnly =
    report !== undefined &&
    report.comparable_count > 0 &&
    report.win_rate_pct === 0 &&
    comparableItems.length > 0 &&
    comparableItems.every(isFirstDayFlatItem)
  const winRateLabel =
    report?.avg_excess_return_pct === null || report?.avg_excess_return_pct === undefined
      ? '绝对收益胜率'
      : '跑赢沪深 300 胜率'

  return (
    <Card
      title="决策质量账本与沪深 300 Beta 归因"
      extra={
        report ? (
          <span className="small muted mono">
            {`可比 ${report.comparable_count} / ${report.total_entries} 条`}
          </span>
        ) : null
      }
    >
      {ledgerQuery.isPending || (!report && ledgerQuery.isFetching) ? (
        <LoadingBlock lines={4} />
      ) : ledgerQuery.isError ? (
        <ErrorBlock
          title="决策质量账本加载失败"
          message={ledgerQuery.error instanceof Error ? ledgerQuery.error.message : '未知错误'}
          onRetry={() => {
            void ledgerQuery.refetch()
          }}
        />
      ) : !report || report.total_entries === 0 ? (
        <EmptyBlock
          title="暂无决策质量账本数据"
          hint="前往个股投资决策页写下决策日记与时间胶囊后，系统将自动对比沪深 300 基准并统计情绪胜率。"
        />
      ) : (
        <div className="stack" style={{ gap: 18 }}>
          <div className="ledger-kpi-grid">
            <Metric
              label="可比记录数"
              value={`${report.comparable_count} / ${report.total_entries}`}
              sub="已匹配入场价与当前快照"
            />
            <Metric
              label={winRateLabel}
              value={
                report.win_rate_pct !== null && report.win_rate_pct !== undefined
                  ? formatPct(report.win_rate_pct, 1)
                  : '—'
              }
              tone={isFirstDayFlatOnly ? '' : winRateTone(report.win_rate_pct)}
              sub={
                isFirstDayFlatOnly
                  ? '首日平价入库，待下一交易日收市后计算胜负'
                  : `胜 ${report.win_count} / 可比 ${report.comparable_count}`
              }
            />
            <Metric
              label="平均标的收益"
              value={formatSignedPct(report.avg_stock_return_pct, 2)}
              tone={qualityTone(report.avg_stock_return_pct)}
              sub="记录价至最新收盘价"
            />
            <Metric
              label="平均超额 Alpha"
              value={formatSignedPct(report.avg_excess_return_pct, 2)}
              tone={qualityTone(report.avg_excess_return_pct)}
              sub={`相对基准 ${report.current_benchmark_code}`}
            />
            <Metric
              label="Pass 观察池避险"
              value={`${report.pass_avoided_loss_count} / ${report.pass_count}`}
              tone={report.pass_count > 0 && report.pass_avoided_loss_count > 0 ? 'tone-good' : ''}
              sub="Pass 后标的下跌避开回撤"
            />
            <Metric
              label="当前沪深 300 点位"
              value={formatNum(report.current_benchmark_price, 2)}
              sub={report.benchmark_as_of ? `基准日 ${report.benchmark_as_of}` : '基准 000300'}
            />
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <h3 className="ledger-section-title">情绪胜率归因</h3>
            {report.by_emotion.length === 0 ? (
              <p className="small muted">暂无情绪分组数据。</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>情绪</th>
                      <th style={{ textAlign: 'right' }}>记录数 / 可比数</th>
                      <th style={{ textAlign: 'right' }}>胜率</th>
                      <th style={{ textAlign: 'right' }}>平均绝对收益</th>
                      <th style={{ textAlign: 'right' }}>平均超额 Alpha</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.by_emotion.map((row) => {
                      const emotionItems = comparableItems.filter(
                        (item) => (item.emotion?.trim() || '未标注') === row.emotion,
                      )
                      const isRowFirstDayFlat =
                        row.comparable_count > 0 &&
                        row.win_rate_pct === 0 &&
                        emotionItems.length > 0 &&
                        emotionItems.every(isFirstDayFlatItem)
                      return (
                        <tr key={row.emotion}>
                          <td>
                            <Tag color={row.emotion === '未标注' ? 'gray' : 'blue'}>
                              {row.emotion}
                            </Tag>
                          </td>
                          <td className="num">{`${row.total_count} / ${row.comparable_count}`}</td>
                          <td
                            className={`num ${isRowFirstDayFlat ? '' : winRateTone(row.win_rate_pct)}`}
                          >
                            {row.win_rate_pct !== null && row.win_rate_pct !== undefined
                              ? formatPct(row.win_rate_pct, 1)
                              : '—'}
                          </td>
                          <td className={`num ${qualityTone(row.avg_stock_return_pct)}`}>
                            {formatSignedPct(row.avg_stock_return_pct, 2)}
                          </td>
                          <td className={`num ${qualityTone(row.avg_excess_return_pct)}`}>
                            {formatSignedPct(row.avg_excess_return_pct, 2)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <h3 className="ledger-section-title">时间胶囊对照明细</h3>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>标的</th>
                    <th>动作 / 情绪</th>
                    <th style={{ textAlign: 'right' }}>记录天数</th>
                    <th style={{ textAlign: 'right' }}>记录价 → 现价</th>
                    <th style={{ textAlign: 'right' }}>涨跌幅</th>
                    <th style={{ textAlign: 'right' }}>沪深 300 基准</th>
                    <th style={{ textAlign: 'right' }}>超额 Alpha</th>
                    <th style={{ textAlign: 'right' }}>PE / 评分变化</th>
                    <th>否证状态</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((item) => {
                    const actionMeta = JOURNAL_ACTION_META[item.action]
                    const triggers = item.falsify_triggers ?? []
                    return (
                      <tr key={item.id}>
                        <td>
                          <div className="stack" style={{ gap: 2 }}>
                            <Link className="mono link-accent" to={`/stock/${item.code}`}>
                              {item.code}
                            </Link>
                            {item.name ? <span className="small soft">{item.name}</span> : null}
                          </div>
                        </td>
                        <td>
                          <div className="sentinel-list">
                            <Tag color={actionMeta.color}>{actionMeta.label}</Tag>
                            {item.emotion ? <Tag color="gray">{item.emotion}</Tag> : null}
                          </div>
                        </td>
                        <td className="num">{`${item.days_held} 天`}</td>
                        <td className="num">
                          {`${formatNum(item.entry_price, 2)} → ${formatNum(item.current_price, 2)}`}
                        </td>
                        <td className={`num ${qualityTone(item.stock_return_pct)}`}>
                          {formatSignedPct(item.stock_return_pct, 2)}
                        </td>
                        <td className="num">{formatSignedPct(item.benchmark_return_pct, 2)}</td>
                        <td className={`num ${qualityTone(item.excess_return_pct)}`}>
                          {formatSignedPct(item.excess_return_pct, 2)}
                        </td>
                        <td className="num">
                          <div className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
                            <span className="small mono">
                              {`PE ${formatNum(item.entry_pe_ttm, 1)} → ${formatNum(item.current_pe_ttm, 1)}`}
                            </span>
                            <span className="small muted mono">
                              {`评分 ${item.entry_score ?? '—'} → ${item.current_score ?? '—'}`}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="stack" style={{ gap: 4, alignItems: 'flex-start' }}>
                            <Tag color={item.falsify_triggered ? 'rose' : 'green'}>
                              {item.falsify_triggered ? '已触发否证' : '未触发'}
                            </Tag>
                            {triggers.length > 0 ? (
                              <span className="small soft">{triggers.join('；')}</span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
