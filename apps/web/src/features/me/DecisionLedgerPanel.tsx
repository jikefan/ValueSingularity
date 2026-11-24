import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { GlossaryLabel, InfoHint, type CustomGlossaryEntry } from '../../components/ui/InfoHint'
import { Metric } from '../../components/ui/Metric'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { formatNum, formatPct, formatSignedPct, qualityTone } from '../../lib/format'
import { JOURNAL_ACTION_META } from '../../lib/journalLabels'
import { useJournalLedger } from '../../lib/useJournal'
import type { JournalEntryComparison } from '../../types/api'

const AVG_ABSOLUTE_RETURN_ENTRY: CustomGlossaryEntry = {
  summary:
    '各可比决策记录自时间胶囊创建日起至最新交易日的个股算术平均绝对涨跌幅（未扣除沪深 300 基准 Beta 波动）。',
  formula: '平均绝对收益 = ∑[(最新收盘价 − 入场记录价) ÷ 入场记录价] ÷ 可比记录数 × 100%。',
  reading: '需结合「超额 Alpha」共同审视，辨别收益究竟来自大盘普涨还是选股本身的能力。',
}

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
      hint="decision_ledger"
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
              label={
                <span className="label-with-hint">
                  <span>可比记录数</span>
                  <InfoHint
                    title="可比记录数"
                    entry={{
                      summary:
                        '全部决策日记中，既包含入场记录价、又已匹配到当前最新交易日行情快照的有效复盘样本数。',
                      reading:
                        '若早期记录未填写/缺失入场价或标的最新行情暂缺，该记录不计入胜率与平均收益分母。',
                    }}
                  />
                </span>
              }
              value={`${report.comparable_count} / ${report.total_entries}`}
              sub="已匹配入场价与当前快照"
            />
            <Metric
              label={
                <>
                  {winRateLabel} <InfoHint term="win_rate" />
                </>
              }
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
              label={
                <span className="label-with-hint">
                  <span>平均标的收益</span>
                  <InfoHint title="平均绝对收益" entry={AVG_ABSOLUTE_RETURN_ENTRY} />
                </span>
              }
              value={formatSignedPct(report.avg_stock_return_pct, 2)}
              tone={qualityTone(report.avg_stock_return_pct)}
              sub="记录价至最新收盘价"
            />
            <Metric
              label="平均超额 Alpha"
              hint="excess_alpha"
              value={formatSignedPct(report.avg_excess_return_pct, 2)}
              tone={qualityTone(report.avg_excess_return_pct)}
              sub={`相对基准 ${report.current_benchmark_code}`}
            />
            <Metric
              label={
                <>
                  Pass 观察池避险{' '}
                  <InfoHint
                    title="Pass 观察池避险"
                    entry={{
                      summary:
                        '统计主动标注为 Pass（放弃买入/观望）的记录中，后续标的股价下跌从而成功避开回撤的占比。',
                      formula:
                        '避险成功数 = Pass 记录中入场观察日至最新收盘价跌破入场参考价的条数。',
                      reading: '管住手回避价值陷阱或高估回调，同样是对组合净值的重要正贡献。',
                    }}
                  />
                </>
              }
              value={`${report.pass_avoided_loss_count} / ${report.pass_count}`}
              tone={report.pass_count > 0 && report.pass_avoided_loss_count > 0 ? 'tone-good' : ''}
              sub="Pass 后标的下跌避开回撤"
            />
            <Metric
              label="当前沪深 300 点位"
              hint="hs300_benchmark"
              value={formatNum(report.current_benchmark_price, 2)}
              sub={report.benchmark_as_of ? `基准日 ${report.benchmark_as_of}` : '基准 000300'}
            />
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <h3 className="ledger-section-title">
              <GlossaryLabel label="情绪胜率归因" term="emotion_win_rate" />
            </h3>
            {report.by_emotion.length === 0 ? (
              <p className="small muted">暂无情绪分组数据。</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>
                        <GlossaryLabel label="情绪" term="decision_emotion" />
                      </th>
                      <th style={{ textAlign: 'right' }}>
                        <span className="label-with-hint">
                          <span>记录数 / 可比数</span>
                          <InfoHint
                            title="记录数 / 可比数"
                            entry={{
                              summary:
                                '该情绪标签下累计决策日记总条数，以及已匹配入场价与当前快照的可比统计样本数。',
                              reading:
                                '样本数量过少时单笔极端波动会放大胜率偏差，长期记录更具统计学意义。',
                            }}
                          />
                        </span>
                      </th>
                      <th style={{ textAlign: 'right' }}>
                        <GlossaryLabel label="胜率" term="win_rate" />
                      </th>
                      <th style={{ textAlign: 'right' }}>
                        <span className="label-with-hint">
                          <span>平均绝对收益</span>
                          <InfoHint title="平均绝对收益" entry={AVG_ABSOLUTE_RETURN_ENTRY} />
                        </span>
                      </th>
                      <th style={{ textAlign: 'right' }}>
                        <GlossaryLabel label="平均超额 Alpha" term="excess_alpha" />
                      </th>
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
            <h3 className="ledger-section-title">
              <GlossaryLabel label="时间胶囊对照明细" term="time_capsule" />
            </h3>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>
                      <span className="label-with-hint">
                        <span>标的</span>
                        <InfoHint
                          title="决策标的"
                          entry={{
                            summary:
                              '该笔决策日记对应的 A 股代码与公司名称，点击代码可进入个股工作台复盘。',
                          }}
                        />
                      </span>
                    </th>
                    <th>
                      <GlossaryLabel label="动作 / 情绪" term="decision_emotion" />
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <span className="label-with-hint">
                        <span>记录天数</span>
                        <InfoHint
                          title="记录天数"
                          entry={{
                            summary:
                              '从提交该笔决策日记并封存时间胶囊当天起，至当前最新快照基准日已历经的自然天数。',
                            formula: '记录天数 = 最新快照日期 − 决策日记创建日期。',
                            reading:
                              '深度价值投资常需数个季度乃至数年兑现，避免因几天内的短期价格噪音过早怀疑研究逻辑。',
                          }}
                        />
                      </span>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <span className="label-with-hint">
                        <span>记录价 → 现价</span>
                        <InfoHint
                          title="记录价 → 现价"
                          entry={{
                            summary:
                              '时间胶囊封存当天的入场参考价（元）与最新交易日收盘价（元）的直接对比。',
                            reading:
                              'Pass 观察池记录亦会对比观察起点价与现价，方便事后验证避险效果。',
                          }}
                        />
                      </span>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <span className="label-with-hint">
                        <span>涨跌幅</span>
                        <InfoHint
                          title="区间绝对涨跌幅"
                          entry={{
                            summary:
                              '自该笔决策记录日起至最新收盘价的个股累计绝对涨跌幅（未扣除大盘影响）。',
                            formula: '涨跌幅 = (现价 − 记录价) ÷ 记录价 × 100%。',
                            reading: '需与右侧「沪深 300 基准」和「超额 Alpha」联动比较。',
                          }}
                        />
                      </span>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <GlossaryLabel label="沪深 300 基准" term="hs300_benchmark" />
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <GlossaryLabel label="超额 Alpha" term="excess_alpha" />
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <GlossaryLabel label="PE / 评分变化" term="pe_score_delta" />
                    </th>
                    <th>
                      <GlossaryLabel label="否证状态" term="falsify_status" />
                    </th>
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
