import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { useAuth } from '../../lib/authContext'
import { fmtNum } from '../../lib/format'
import type { PlanTier, WatchlistItem, WatchlistUpsert } from '../../types/api'
import { useRemoveWatchlist, useUpsertWatchlist, useWatchlist } from './useWatchlist'

const PLAN_COLOR: Record<PlanTier, 'gray' | 'blue' | 'green'> = {
  free: 'gray',
  pro: 'blue',
  ai_plus: 'green',
}

type ParsedNumber = { ok: true; value: number | null } | { ok: false; error: string }

function parseOptionalNumber(
  raw: string,
  label: string,
  constraints: { min?: number; max?: number },
): ParsedNumber {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: true, value: null }
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `${label}须为有效数字` }
  }
  if (constraints.min !== undefined && parsed < constraints.min) {
    return { ok: false, error: `${label}不能小于 ${constraints.min}` }
  }
  if (constraints.max !== undefined && parsed > constraints.max) {
    return { ok: false, error: `${label}不能大于 ${constraints.max}` }
  }
  return { ok: true, value: parsed }
}

function renderThresholdBadges(item: WatchlistItem) {
  const items: string[] = []
  if (item.target_price !== null && item.target_price !== undefined) {
    items.push(`目标价 ≤ ${fmtNum(item.target_price, 2)}`)
  }
  if (item.target_pe_percentile !== null && item.target_pe_percentile !== undefined) {
    items.push(`PE 分位 ≤ ${fmtNum(item.target_pe_percentile, 0)}%`)
  }
  if (item.target_dividend_yield !== null && item.target_dividend_yield !== undefined) {
    items.push(`股息率 ≥ ${fmtNum(item.target_dividend_yield, 2)}%`)
  }

  return (
    <div className="sentinel-list">
      <Tag color={item.alert_enabled ? 'green' : 'gray'}>
        {item.alert_enabled ? '哨兵开启' : '哨兵关闭'}
      </Tag>
      {items.length > 0 ? (
        items.map((text) => (
          <Tag key={text} color="blue">
            {text}
          </Tag>
        ))
      ) : (
        <span className="small muted">未设置阈值</span>
      )}
    </div>
  )
}

export function MePage() {
  const { user, isAuthLoading } = useAuth()
  const watchlistQuery = useWatchlist(Boolean(user))
  const upsertMutation = useUpsertWatchlist()
  const removeMutation = useRemoveWatchlist()

  const [editingCode, setEditingCode] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState('')
  const [note, setNote] = useState('')
  const [targetPrice, setTargetPrice] = useState('')
  const [targetPePercentile, setTargetPePercentile] = useState('')
  const [targetDividendYield, setTargetDividendYield] = useState('')
  const [alertEnabled, setAlertEnabled] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)

  function resetForm() {
    setEditingCode(null)
    setCode('')
    setName('')
    setIndustry('')
    setNote('')
    setTargetPrice('')
    setTargetPePercentile('')
    setTargetDividendYield('')
    setAlertEnabled(true)
    setFormError(null)
    upsertMutation.reset()
  }

  function startEdit(item: WatchlistItem) {
    setEditingCode(item.code)
    setCode(item.code)
    setName(item.name)
    setIndustry(item.industry ?? '')
    setNote(item.note ?? '')
    setTargetPrice(
      item.target_price !== null && item.target_price !== undefined
        ? String(item.target_price)
        : '',
    )
    setTargetPePercentile(
      item.target_pe_percentile !== null && item.target_pe_percentile !== undefined
        ? String(item.target_pe_percentile)
        : '',
    )
    setTargetDividendYield(
      item.target_dividend_yield !== null && item.target_dividend_yield !== undefined
        ? String(item.target_dividend_yield)
        : '',
    )
    setAlertEnabled(item.alert_enabled)
    setFormError(null)
    upsertMutation.reset()
  }

  function handleSubmit() {
    const trimmedCode = code.trim()
    const trimmedName = name.trim()
    const trimmedIndustry = industry.trim()

    if (!/^\d{6}$/.test(trimmedCode)) {
      setFormError('股票代码须为 6 位数字')
      return
    }
    if (!trimmedName || trimmedName.length > 64) {
      setFormError('请输入 1–64 个字符的股票名称')
      return
    }
    if (trimmedIndustry.length > 64) {
      setFormError('行业名称不能超过 64 个字符')
      return
    }

    const parsedPrice = parseOptionalNumber(targetPrice, '目标价', {
      min: 0.001,
      max: 999_999_999.999,
    })
    if (!parsedPrice.ok) {
      setFormError(parsedPrice.error)
      return
    }

    const parsedPe = parseOptionalNumber(targetPePercentile, '目标 PE 分位', { min: 0, max: 100 })
    if (!parsedPe.ok) {
      setFormError(parsedPe.error)
      return
    }

    const parsedDividend = parseOptionalNumber(targetDividendYield, '目标股息率', {
      min: 0,
      max: 100,
    })
    if (!parsedDividend.ok) {
      setFormError(parsedDividend.error)
      return
    }

    setFormError(null)
    const payload: WatchlistUpsert = {
      code: trimmedCode,
      name: trimmedName,
      industry: trimmedIndustry || null,
      note: note.trim() || null,
      target_price: parsedPrice.value,
      target_pe_percentile: parsedPe.value,
      target_dividend_yield: parsedDividend.value,
      alert_enabled: alertEnabled,
    }

    upsertMutation.mutate(payload, {
      onSuccess: () => {
        resetForm()
      },
    })
  }

  if (isAuthLoading) {
    return (
      <div className="container">
        <Card title="我的">
          <LoadingBlock lines={4} />
        </Card>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="container">
        <Card title="我的" extra={<Tag color="gray">未登录</Tag>}>
          <EmptyBlock
            title="登录后同步你的自选愿望单与投资日记"
            hint={
              <Link className="btn-primary mt-16" to="/login" state={{ from: '/me' }}>
                前往登录 / 注册
              </Link>
            }
          />
        </Card>
      </div>
    )
  }

  const mutationErrorMessage = upsertMutation.isError
    ? upsertMutation.error instanceof Error
      ? upsertMutation.error.message
      : '保存失败，请稍后重试'
    : null
  const activeFormError = formError ?? mutationErrorMessage

  const removeErrorMessage = removeMutation.isError
    ? removeMutation.error instanceof Error
      ? removeMutation.error.message
      : '删除失败，请稍后重试'
    : null

  return (
    <div className="container stack" style={{ gap: 16 }}>
      <Card
        title="投资账户"
        extra={<Tag color={PLAN_COLOR[user.plan_tier]}>{user.plan_tier.toUpperCase()}</Tag>}
      >
        <div className="row">
          <div className="stack" style={{ gap: 2 }}>
            <strong>{user.display_name}</strong>
            <span className="small muted mono">{user.email ?? user.phone ?? '—'}</span>
          </div>
          <span className="small muted">多租户隔离 · 击球区哨兵已就绪</span>
        </div>
      </Card>

      <Card
        title={editingCode ? `编辑自选 · ${editingCode}` : '添加自选与击球区哨兵'}
        extra={<Tag color="blue">{editingCode ? '编辑模式' : '新增 / 覆盖'}</Tag>}
      >
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
              <label htmlFor="wl-code">股票代码</label>
              <input
                id="wl-code"
                className="input mono"
                type="text"
                maxLength={6}
                readOnly={editingCode !== null}
                placeholder="例如 600519"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="wl-name">股票名称</label>
              <input
                id="wl-name"
                className="input"
                type="text"
                maxLength={64}
                placeholder="例如 贵州茅台"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="wl-industry">行业</label>
              <input
                id="wl-industry"
                className="input"
                type="text"
                maxLength={64}
                placeholder="例如 白酒（可选）"
                value={industry}
                onChange={(event) => setIndustry(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="wl-target-price">目标价（元）</label>
              <input
                id="wl-target-price"
                className="input mono"
                type="number"
                step="0.001"
                min="0.001"
                max="999999999.999"
                placeholder="例如 1400"
                value={targetPrice}
                onChange={(event) => setTargetPrice(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="wl-target-pe">目标 PE 分位（%）</label>
              <input
                id="wl-target-pe"
                className="input mono"
                type="number"
                step="0.1"
                min="0"
                max="100"
                placeholder="0 – 100"
                value={targetPePercentile}
                onChange={(event) => setTargetPePercentile(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="wl-target-dividend">目标股息率（%）</label>
              <input
                id="wl-target-dividend"
                className="input mono"
                type="number"
                step="0.1"
                min="0"
                max="100"
                placeholder="0 – 100"
                value={targetDividendYield}
                onChange={(event) => setTargetDividendYield(event.target.value)}
              />
            </div>

            <div className="field field-full">
              <label htmlFor="wl-note">备注</label>
              <input
                id="wl-note"
                className="input"
                type="text"
                placeholder="击球条件、护城河观察或估值假设（可选）"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="checkbox-row" htmlFor="wl-alert">
              <input
                id="wl-alert"
                type="checkbox"
                checked={alertEnabled}
                onChange={(event) => setAlertEnabled(event.target.checked)}
              />
              <span>开启击球区哨兵</span>
            </label>

            <div className="form-actions">
              {editingCode !== null ? (
                <button type="button" className="btn-ghost" onClick={resetForm}>
                  重置
                </button>
              ) : null}
              <button type="submit" className="btn-primary" disabled={upsertMutation.isPending}>
                {editingCode ? '更新愿望单' : '保存自选'}
              </button>
            </div>
          </div>

          {activeFormError ? (
            <div className="inline-error" role="alert">
              {activeFormError}
            </div>
          ) : null}
        </form>
      </Card>

      <Card
        title="我的自选愿望单"
        extra={
          watchlistQuery.data ? (
            <span className="small muted mono">{watchlistQuery.data.length} 只标的</span>
          ) : null
        }
      >
        {removeErrorMessage ? (
          <div className="inline-error" style={{ marginBottom: 12 }} role="alert">
            {removeErrorMessage}
          </div>
        ) : null}

        {watchlistQuery.isPending || (!watchlistQuery.data && watchlistQuery.isFetching) ? (
          <LoadingBlock lines={4} />
        ) : watchlistQuery.isError ? (
          <ErrorBlock
            title="自选加载失败"
            message={
              watchlistQuery.error instanceof Error ? watchlistQuery.error.message : '未知错误'
            }
            onRetry={() => {
              void watchlistQuery.refetch()
            }}
          />
        ) : !watchlistQuery.data || watchlistQuery.data.length === 0 ? (
          <EmptyBlock
            title="还没有自选标的"
            hint="在上方录入股票代码和击球区阈值，建立自己的观察愿望单。"
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>代码</th>
                <th>名称 / 行业</th>
                <th>击球区阈值</th>
                <th>备注</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {watchlistQuery.data.map((item) => (
                <tr key={item.code}>
                  <td>
                    <Link className="mono link-accent" to={`/stock/${item.code}`}>
                      {item.code}
                    </Link>
                  </td>
                  <td>
                    <div>{item.name}</div>
                    {item.industry ? <div className="small muted">{item.industry}</div> : null}
                  </td>
                  <td>{renderThresholdBadges(item)}</td>
                  <td className="soft">
                    {item.note ? item.note : <span className="muted">—</span>}
                  </td>
                  <td>
                    <div className="table-actions">
                      <button type="button" className="btn-ghost" onClick={() => startEdit(item)}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={
                          removeMutation.isPending && removeMutation.variables === item.code
                        }
                        onClick={() => {
                          removeMutation.mutate(item.code, {
                            onSuccess: () => {
                              if (editingCode === item.code) {
                                resetForm()
                              }
                            },
                          })
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
