import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { JournalEntryCard } from '../../components/ui/JournalEntryCard'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { ApiError, api } from '../../lib/api'
import { useAuth } from '../../lib/authContext'
import { JOURNAL_ACTION_META } from '../../lib/journalLabels'
import { queryKeys } from '../../lib/queryKeys'
import { useCreateJournal, useJournal, useRemoveJournal } from '../../lib/useJournal'
import { useAddWatchlist, useWatchlist } from '../../lib/useWatchlist'
import { parseOptionalNumber } from '../../lib/validation'
import type { JournalAction, JournalCreate, StockDetail } from '../../types/api'

const TABS = [
  {
    key: 'overview',
    label: '公司画像',
    roadmap: '主营收入构成、管理层履历与经营摘要将在 Phase 2 接通财务快照后呈现。',
  },
  {
    key: 'financials',
    label: '财务分析',
    roadmap: '十年 ROE、自由现金流、毛利率与周转率趋势将在 Phase 2 财报引擎上线后计算。',
  },
  {
    key: 'moat',
    label: '护城河',
    roadmap: '竞争壁垒、定价权与超额资本回报模型将在 Phase 2 护城河模块上线。',
  },
  {
    key: 'valuation',
    label: '估值',
    roadmap: '历史 PE/PB 分位、股息率与安全边际区间将在 Phase 2 接通日线行情后计算。',
  },
  {
    key: 'growth',
    label: '增长引擎',
    roadmap: '营收复合增速、产能扩张与研发投入追踪将在 Phase 2 增长分析模块上线。',
  },
  {
    key: 'institutions',
    label: '机构视角',
    roadmap: '机构持仓变动、北向资金与一致预期将在 Phase 2 机构数据接入后展示。',
  },
  {
    key: 'governance',
    label: '治理',
    roadmap: '分红回购比例、股权激励与关联交易排查将在 Phase 2 公司治理模块呈现。',
  },
  {
    key: 'risks',
    label: '风险排雷',
    roadmap: '商誉占比、股权质押与现金流背离预警将在 Phase 2 风险排雷引擎上线。',
  },
  {
    key: 'decision',
    label: '投资决策',
    roadmap: '',
  },
] as const

type TabKey = (typeof TABS)[number]['key']

const ACTION_OPTIONS: JournalAction[] = ['buy', 'add', 'trim', 'sell', 'pass']

function isJournalAction(value: string): value is JournalAction {
  return (
    value === 'buy' || value === 'add' || value === 'trim' || value === 'sell' || value === 'pass'
  )
}

function StockDecisionTab({ stock }: { stock: StockDetail }) {
  const { user, isAuthLoading } = useAuth()
  const journalQuery = useJournal(stock.code, Boolean(user))
  const createJournal = useCreateJournal()
  const removeJournal = useRemoveJournal()

  const [action, setAction] = useState<JournalAction>('buy')
  const [reason, setReason] = useState('')
  const [falsifyCondition, setFalsifyCondition] = useState('')
  const [price, setPrice] = useState('')
  const [maxDrawdown, setMaxDrawdown] = useState('')
  const [emotion, setEmotion] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  function handleSubmit() {
    const trimmedReason = reason.trim()
    const trimmedFalsify = falsifyCondition.trim()
    const trimmedEmotion = emotion.trim()

    if (!trimmedReason) {
      setFormError('请填写投资理由')
      return
    }
    if (trimmedReason.length > 5000) {
      setFormError('投资理由不能超过 5000 个字符')
      return
    }
    if (!trimmedFalsify) {
      setFormError('请填写否证条件')
      return
    }
    if (trimmedFalsify.length > 5000) {
      setFormError('否证条件不能超过 5000 个字符')
      return
    }
    if (trimmedEmotion.length > 32) {
      setFormError('当前情绪不能超过 32 个字符')
      return
    }

    const parsedPrice = parseOptionalNumber(price, '参考价格', {
      min: 0.001,
      max: 999_999_999.999,
    })
    if (!parsedPrice.ok) {
      setFormError(parsedPrice.error)
      return
    }

    const parsedDrawdown = parseOptionalNumber(maxDrawdown, '最大可承受回撤', {
      min: 0,
      max: 100,
    })
    if (!parsedDrawdown.ok) {
      setFormError(parsedDrawdown.error)
      return
    }

    setFormError(null)
    const payload: JournalCreate = {
      code: stock.code,
      name: stock.name,
      action,
      reason: trimmedReason,
      falsify_condition: trimmedFalsify,
      price: parsedPrice.value,
      max_drawdown: parsedDrawdown.value,
      emotion: trimmedEmotion || null,
      benchmark_code: '000300',
    }

    createJournal.mutate(payload, {
      onSuccess: () => {
        setReason('')
        setFalsifyCondition('')
        setPrice('')
        setMaxDrawdown('')
        setEmotion('')
      },
    })
  }

  if (isAuthLoading) {
    return (
      <Card title="投资决策日记">
        <LoadingBlock lines={3} />
      </Card>
    )
  }

  if (!user) {
    return (
      <Card title="投资决策日记" extra={<Tag color="gray">未登录</Tag>}>
        <EmptyBlock
          title="登录后记录你的投资决策与否证红线"
          hint={
            <Link
              className="btn-primary mt-16"
              to="/login"
              state={{ from: `/stock/${stock.code}` }}
            >
              前往登录 / 注册
            </Link>
          }
        />
      </Card>
    )
  }

  const mutationError = createJournal.isError
    ? createJournal.error instanceof Error
      ? createJournal.error.message
      : '记录保存失败，请稍后重试'
    : null
  const activeError = formError ?? mutationError

  const removeError = removeJournal.isError
    ? removeJournal.error instanceof Error
      ? removeJournal.error.message
      : '删除失败，请稍后重试'
    : null

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={`新建决策记录 · ${stock.name}`} extra={<Tag color="green">强制写否证红线</Tag>}>
        <form
          className="stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            handleSubmit()
          }}
        >
          <div className="form-grid">
            <div className="field">
              <label htmlFor="journal-action">决策动作</label>
              <select
                id="journal-action"
                className="input"
                value={action}
                onChange={(event) => {
                  const next = event.target.value
                  if (isJournalAction(next)) {
                    setAction(next)
                  }
                }}
              >
                {ACTION_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {JOURNAL_ACTION_META[option].label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="journal-emotion">当前情绪</label>
              <input
                id="journal-emotion"
                className="input"
                type="text"
                maxLength={32}
                placeholder="例如 冷静 / 贪婪 / 谨慎（可选）"
                value={emotion}
                onChange={(event) => setEmotion(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="journal-price">参考价格（元）</label>
              <input
                id="journal-price"
                className="input mono"
                type="number"
                step="0.001"
                min="0.001"
                max="999999999.999"
                placeholder="例如 1450（可选）"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="journal-drawdown">最大可承受回撤（%）</label>
              <input
                id="journal-drawdown"
                className="input mono"
                type="number"
                step="0.1"
                min="0"
                max="100"
                placeholder="0 – 100（可选）"
                value={maxDrawdown}
                onChange={(event) => setMaxDrawdown(event.target.value)}
              />
            </div>

            <div className="field field-full">
              <label htmlFor="journal-reason">投资理由</label>
              <textarea
                id="journal-reason"
                className="input textarea"
                maxLength={5000}
                placeholder="写下估值锚点、护城河变化或放弃买入的原因（必填）"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>

            <div className="field field-full">
              <label htmlFor="journal-falsify">否证条件</label>
              <textarea
                id="journal-falsify"
                className="input textarea"
                maxLength={5000}
                placeholder="明确什么变化会证伪当前判断，例如：连续两季现金流转负（必填）"
                value={falsifyCondition}
                onChange={(event) => setFalsifyCondition(event.target.value)}
              />
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={createJournal.isPending}>
              {createJournal.isPending ? '保存中...' : '记录决策'}
            </button>
          </div>

          {activeError ? (
            <div className="inline-error" role="alert">
              {activeError}
            </div>
          ) : null}
        </form>
      </Card>

      <Card
        title={`${stock.code} 历史决策日记`}
        extra={
          journalQuery.data ? (
            <span className="small muted mono">{journalQuery.data.length} 条记录</span>
          ) : null
        }
      >
        {removeError ? (
          <div className="inline-error" style={{ marginBottom: 12 }} role="alert">
            {removeError}
          </div>
        ) : null}

        {journalQuery.isPending || (!journalQuery.data && journalQuery.isFetching) ? (
          <LoadingBlock lines={3} />
        ) : journalQuery.isError ? (
          <ErrorBlock
            title="决策日记加载失败"
            message={journalQuery.error instanceof Error ? journalQuery.error.message : '未知错误'}
            onRetry={() => {
              void journalQuery.refetch()
            }}
          />
        ) : !journalQuery.data || journalQuery.data.length === 0 ? (
          <EmptyBlock
            title="暂无该标的决策记录"
            hint="在上方写下本次买入、卖出或 Pass 的理由与否证条件。"
          />
        ) : (
          <div className="journal-list">
            {journalQuery.data.map((entry) => (
              <JournalEntryCard
                key={entry.id}
                entry={entry}
                isDeleting={removeJournal.isPending && removeJournal.variables === entry.id}
                onDelete={(entryId) => removeJournal.mutate(entryId)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function StockPageContent({ code }: { code: string }) {
  const { user, isAuthLoading } = useAuth()
  const [activeTab, setActiveTab] = useState<TabKey>('decision')

  const stockQuery = useQuery({
    queryKey: queryKeys.stocks.detail(code),
    queryFn: ({ signal }) => api.getStock(code, signal),
  })

  const watchlistQuery = useWatchlist(Boolean(user))
  const addWatchlistMutation = useAddWatchlist()

  if (stockQuery.isPending || (!stockQuery.data && stockQuery.isFetching)) {
    return (
      <div className="container stack" style={{ gap: 16 }}>
        <Card title={`${code} · 个股分析`}>
          <LoadingBlock lines={5} />
        </Card>
      </div>
    )
  }

  if (stockQuery.isError) {
    if (stockQuery.error instanceof ApiError && stockQuery.error.status === 404) {
      return (
        <div className="container stack" style={{ gap: 16 }}>
          <Card title={`${code} · 个股分析`} extra={<Tag color="amber">未收录</Tag>}>
            <EmptyBlock
              title={`未找到股票 ${code}`}
              hint={
                <span className="stack" style={{ gap: 10, alignItems: 'center' }}>
                  <span>
                    本地元数据表 <code className="mono">stock_meta</code> 尚未收录该代码，请运行{' '}
                    <code className="mono">python -m app.cli.sync</code> 同步全市场基础信息。
                  </span>
                  <Link className="btn-ghost" to="/">
                    返回市场概览
                  </Link>
                </span>
              }
            />
          </Card>
        </div>
      )
    }

    return (
      <div className="container stack" style={{ gap: 16 }}>
        <Card title={`${code} · 个股分析`}>
          <ErrorBlock
            title="个股信息加载失败"
            message={stockQuery.error instanceof Error ? stockQuery.error.message : '未知错误'}
            onRetry={() => {
              void stockQuery.refetch()
            }}
          />
        </Card>
      </div>
    )
  }

  const stock = stockQuery.data
  if (!stock) {
    return null
  }

  const currentTabMeta = TABS.find((tab) => tab.key === activeTab) ?? TABS[0]
  const industryText = [stock.industry_sw1, stock.industry_sw2].filter(Boolean).join(' / ') || '—'
  const isWatchlistChecking = Boolean(user) && watchlistQuery.isPending
  const isInWatchlist = Boolean(watchlistQuery.data?.some((item) => item.code === stock.code))
  const watchlistError = addWatchlistMutation.isError
    ? addWatchlistMutation.error instanceof Error
      ? addWatchlistMutation.error.message
      : '加入自选失败'
    : null

  return (
    <div className="container stack" style={{ gap: 16 }}>
      <Card>
        <div className="stock-header-top">
          <div className="stack" style={{ gap: 8 }}>
            <div className="stock-title-row">
              <h1 className="stock-name">{stock.name}</h1>
              <span className="mono soft">{stock.code}</span>
              <Tag color="blue">{stock.exchange}</Tag>
              {stock.is_st ? <Tag color="amber">ST</Tag> : null}
              {!stock.is_active ? <Tag color="rose">已退市</Tag> : null}
              <Tag color={stock.snapshot_available ? 'green' : 'gray'}>
                {stock.snapshot_available ? '已预计算快照' : '基础元数据'}
              </Tag>
            </div>
            <div className="small muted">申万行业：{industryText}</div>
          </div>

          <div className="stack" style={{ gap: 8, alignItems: 'flex-end' }}>
            {user ? (
              isWatchlistChecking ? (
                <span className="small muted">加载自选状态...</span>
              ) : isInWatchlist ? (
                <div className="row" style={{ gap: 8 }}>
                  <Tag color="green">已在自选</Tag>
                  <Link className="link-accent small" to="/me">
                    前往配置哨兵
                  </Link>
                </div>
              ) : (
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={addWatchlistMutation.isPending}
                    onClick={() =>
                      addWatchlistMutation.mutate({
                        code: stock.code,
                        name: stock.name,
                        industry: stock.industry_sw1 ?? null,
                        alert_enabled: false,
                      })
                    }
                  >
                    {addWatchlistMutation.isPending ? '加入中...' : '加入自选愿望单'}
                  </button>
                </div>
              )
            ) : !isAuthLoading ? (
              <Link className="btn-ghost" to="/login" state={{ from: `/stock/${stock.code}` }}>
                登录后加入自选
              </Link>
            ) : null}

            {watchlistError ? (
              <div className="inline-error" role="alert">
                {watchlistError}
              </div>
            ) : null}
          </div>
        </div>

        <div className="stock-meta-grid">
          <div>
            <div className="metric-label">申万一级</div>
            <div className="metric-sub">{stock.industry_sw1 ?? '—'}</div>
          </div>
          <div>
            <div className="metric-label">申万二级</div>
            <div className="metric-sub">{stock.industry_sw2 ?? '—'}</div>
          </div>
          <div>
            <div className="metric-label">上市日期</div>
            <div className="metric-sub mono">{stock.list_date ?? '—'}</div>
          </div>
          <div>
            <div className="metric-label">交易状态</div>
            <div className="metric-sub">{stock.is_active ? '正常交易' : '已退市'}</div>
          </div>
        </div>
      </Card>

      <div className="tab-bar" role="tablist" aria-label="个股分析维度">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={activeTab === tab.key ? 'tab-btn active' : 'tab-btn'}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'decision' ? (
        <StockDecisionTab stock={stock} />
      ) : (
        <Card title={currentTabMeta.label} extra={<Tag color="blue">Phase 2 规划中</Tag>}>
          <div className="stack">
            {activeTab === 'overview' ? (
              <div className="small soft">
                当前已接入股票基础元数据：{stock.name}（<span className="mono">{stock.code}</span>，
                {stock.exchange}，行业 {industryText}）。
              </div>
            ) : null}
            <EmptyBlock title={`${currentTabMeta.label}模块规划中`} hint={currentTabMeta.roadmap} />
          </div>
        </Card>
      )}
    </div>
  )
}

export function StockPage() {
  const { code = '' } = useParams<{ code: string }>()
  const normalizedCode = code.trim()
  const isValidCode = /^[0-9]{6}$/.test(normalizedCode)

  if (!isValidCode) {
    return (
      <div className="container stack" style={{ gap: 16 }}>
        <Card title="个股分析" extra={<Tag color="rose">代码无效</Tag>}>
          <ErrorBlock
            title="股票代码格式无效"
            message={`“${normalizedCode || '空'}” 不是有效的 6 位 A 股代码，请输入如 600519。`}
          />
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link className="btn-ghost" to="/">
              返回市场概览
            </Link>
          </div>
        </Card>
      </div>
    )
  }

  return <StockPageContent key={normalizedCode} code={normalizedCode} />
}
