import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { InfoHint } from '../../components/ui/InfoHint'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { formatNum, formatPct } from '../../lib/format'
import {
  useAlertPreferences,
  useAlerts,
  useScanAlerts,
  useUpdateAlertPreferences,
} from '../../lib/useAlerts'
import type { AlertSourceType, WebhookChannel } from '../../types/api'

const CHANNEL_OPTIONS: ReadonlyArray<{ value: WebhookChannel; label: string }> = [
  { value: 'feishu', label: '飞书 (Feishu)' },
  { value: 'wecom', label: '企业微信 (WeCom)' },
  { value: 'custom', label: '自定义 JSON' },
]

function isWebhookChannel(value: string): value is WebhookChannel {
  return value === 'feishu' || value === 'wecom' || value === 'custom'
}

function getSourceMeta(sourceType: AlertSourceType): { label: string; color: 'blue' | 'rose' } {
  switch (sourceType) {
    case 'watchlist_sentinel':
      return { label: '击球区命中', color: 'blue' }
    case 'journal_falsify':
      return { label: '否证红线', color: 'rose' }
    default: {
      const exhaustive: never = sourceType
      return exhaustive
    }
  }
}

function getChannelLabel(channel: string): string {
  switch (channel) {
    case 'in_app':
      return '站内'
    case 'feishu':
      return '飞书'
    case 'wecom':
      return '企业微信'
    case 'custom':
      return '自定义 JSON'
    default:
      return channel
  }
}

function getStatusMeta(status: string): {
  label: string
  color: 'green' | 'amber' | 'rose' | 'gray'
} {
  switch (status) {
    case 'sent':
      return { label: 'Webhook 已送达', color: 'green' }
    case 'recorded':
      return { label: '站内已记录', color: 'green' }
    case 'pending':
      return { label: '推送中', color: 'amber' }
    case 'webhook_failed':
      return { label: 'Webhook 失败', color: 'rose' }
    default:
      return { label: status, color: 'gray' }
  }
}

export function SentinelAlertsPanel({ enabled }: { enabled: boolean }) {
  const alertsQuery = useAlerts(enabled)
  const scanMutation = useScanAlerts()
  const preferencesQuery = useAlertPreferences(enabled)
  const updatePreferences = useUpdateAlertPreferences()

  const [prefsOpen, setPrefsOpen] = useState(true)
  const [draftInApp, setDraftInApp] = useState<boolean | null>(null)
  const [draftWebhookEnabled, setDraftWebhookEnabled] = useState<boolean | null>(null)
  const [draftChannelType, setDraftChannelType] = useState<WebhookChannel | null>(null)
  const [webhookUrlInput, setWebhookUrlInput] = useState('')
  const [prefNotice, setPrefNotice] = useState<string | null>(null)

  const prefs = preferencesQuery.data
  const inAppEnabled = draftInApp ?? prefs?.in_app_enabled ?? true
  const webhookEnabled = draftWebhookEnabled ?? prefs?.webhook_enabled ?? false
  const channelType = draftChannelType ?? prefs?.channel_type ?? 'feishu'

  function resetPrefDrafts(notice: string) {
    setDraftInApp(null)
    setDraftWebhookEnabled(null)
    setDraftChannelType(null)
    setWebhookUrlInput('')
    setPrefNotice(notice)
  }

  function handleSavePreferences() {
    setPrefNotice(null)
    const trimmedUrl = webhookUrlInput.trim()
    updatePreferences.mutate(
      {
        in_app_enabled: inAppEnabled,
        webhook_enabled: webhookEnabled,
        channel_type: channelType,
        ...(trimmedUrl ? { webhook_url: trimmedUrl } : {}),
      },
      {
        onSuccess: () => {
          resetPrefDrafts('推送渠道设置已保存')
        },
      },
    )
  }

  function handleClearWebhook() {
    setPrefNotice(null)
    updatePreferences.mutate(
      {
        in_app_enabled: inAppEnabled,
        webhook_enabled: false,
        channel_type: channelType,
        webhook_url: '',
      },
      {
        onSuccess: () => {
          resetPrefDrafts('已清空 Webhook 地址并关闭外部推送')
        },
      },
    )
  }

  const scanError = scanMutation.isError
    ? scanMutation.error instanceof Error
      ? scanMutation.error.message
      : '哨兵扫描失败，请稍后重试'
    : null

  const prefError = updatePreferences.isError
    ? updatePreferences.error instanceof Error
      ? updatePreferences.error.message
      : '推送设置保存失败，请检查配置'
    : null

  return (
    <Card
      title="击球区哨兵与否证雷达"
      hint="strike_zone_sentinel"
      extra={
        <div className="row" style={{ gap: 8 }}>
          {alertsQuery.data ? (
            <span className="small muted mono">{alertsQuery.data.length} 条提醒</span>
          ) : null}
          <button
            type="button"
            className="btn-primary"
            disabled={scanMutation.isPending}
            onClick={() => scanMutation.mutate()}
          >
            {scanMutation.isPending ? '扫描中...' : '立即扫描哨兵雷达'}
          </button>
        </div>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        {scanError ? (
          <div className="inline-error" role="alert">
            {scanError}
          </div>
        ) : null}

        {scanMutation.data ? (
          <div className="notice-box" role="status">
            <span>
              {`本次扫描完成：评估 ${scanMutation.data.evaluated_rules} 条 · 命中 ${scanMutation.data.matched_count} 条 · 新增 ${scanMutation.data.newly_triggered_count} 条`}
              {scanMutation.data.webhook_sent_count > 0 ||
              scanMutation.data.webhook_failed_count > 0
                ? ` · Webhook 成功 ${scanMutation.data.webhook_sent_count} / 失败 ${scanMutation.data.webhook_failed_count}`
                : ''}
              {scanMutation.data.as_of ? `（基准日 ${scanMutation.data.as_of}）` : ''}
            </span>
          </div>
        ) : null}

        {alertsQuery.isPending || (!alertsQuery.data && alertsQuery.isFetching) ? (
          <LoadingBlock lines={3} />
        ) : alertsQuery.isError ? (
          <ErrorBlock
            title="哨兵雷达加载失败"
            message={alertsQuery.error instanceof Error ? alertsQuery.error.message : '未知错误'}
            onRetry={() => {
              void alertsQuery.refetch()
            }}
          />
        ) : !alertsQuery.data || alertsQuery.data.length === 0 ? (
          <EmptyBlock
            title="暂无击球区命中或否证触发记录"
            hint="请在上方自选愿望单开启「击球区哨兵」，或在个股投资决策页添加量化否证红线后点击「立即扫描哨兵雷达」。"
          />
        ) : (
          <div className="alert-list">
            {alertsQuery.data.map((alert) => {
              const sourceMeta = getSourceMeta(alert.source_type)
              const statusMeta = getStatusMeta(alert.status)
              return (
                <article key={alert.id} className="alert-item">
                  <div className="alert-item-header">
                    <div className="journal-item-title">
                      <Tag color={sourceMeta.color}>{sourceMeta.label}</Tag>
                      <Link className="mono link-accent" to={`/stock/${alert.code}`}>
                        {alert.code}
                      </Link>
                      {alert.stock_name ? <strong>{alert.stock_name}</strong> : null}
                      <span className="small muted mono">{alert.trigger_date}</span>
                    </div>
                    <div className="sentinel-list">
                      <Tag color="gray">{getChannelLabel(alert.channel)}</Tag>
                      <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
                    </div>
                  </div>

                  <p className="small soft">{alert.detail}</p>

                  <div className="journal-meta-row">
                    {alert.matched_conditions.map((cond) => (
                      <Tag
                        key={cond}
                        color={alert.source_type === 'journal_falsify' ? 'rose' : 'blue'}
                      >
                        {cond}
                      </Tag>
                    ))}
                    {alert.current_price !== null && alert.current_price !== undefined ? (
                      <Tag color="gray">{`现价 ${formatNum(alert.current_price, 2)}`}</Tag>
                    ) : null}
                    {alert.current_pe_percentile !== null &&
                    alert.current_pe_percentile !== undefined ? (
                      <Tag color="gray">
                        {`PE分位 ${formatPct(alert.current_pe_percentile, 1)}`}
                      </Tag>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        )}

        <div className="subpanel">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="label-with-hint">
              <button
                type="button"
                className="prefs-toggle-btn"
                aria-expanded={prefsOpen}
                onClick={() => setPrefsOpen((open) => !open)}
              >
                <span>推送渠道设置</span>
                <span className="small muted">{prefsOpen ? '收起' : '展开'}</span>
              </button>
              <InfoHint term="webhook_push" />
            </div>

            {prefs ? (
              <Tag color={prefs.webhook_url_configured ? 'green' : 'gray'}>
                {prefs.webhook_url_configured
                  ? `已配置 · ${prefs.webhook_url_masked ?? '****'}`
                  : 'Webhook 未配置'}
              </Tag>
            ) : null}
          </div>

          {prefsOpen ? (
            <div className="mt-16">
              {preferencesQuery.isPending ||
              (!preferencesQuery.data && preferencesQuery.isFetching) ? (
                <LoadingBlock lines={2} />
              ) : preferencesQuery.isError ? (
                <ErrorBlock
                  title="推送渠道设置加载失败"
                  message={
                    preferencesQuery.error instanceof Error
                      ? preferencesQuery.error.message
                      : '未知错误'
                  }
                  onRetry={() => {
                    void preferencesQuery.refetch()
                  }}
                />
              ) : (
                <form
                  className="stack"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault()
                    handleSavePreferences()
                  }}
                >
                  <div className="form-grid">
                    <div className="field">
                      <div className="label-with-hint">
                        <label className="checkbox-row" htmlFor="pref-in-app">
                          <input
                            id="pref-in-app"
                            type="checkbox"
                            checked={inAppEnabled}
                            onChange={(event) => {
                              setDraftInApp(event.target.checked)
                              setPrefNotice(null)
                            }}
                          />
                          <span>开启站内提醒记录</span>
                        </label>
                        <InfoHint
                          title="站内提醒记录"
                          entry={{
                            summary:
                              '哨兵扫描命中击球区或触发否证红线时，将触发详情持久写入站内警报列表，作为最可靠的审计记录兜底。',
                            reading: '推荐长期保持开启，避免外部推送通道异常时遗漏重要风险信号。',
                          }}
                        />
                      </div>

                      <div className="label-with-hint">
                        <label className="checkbox-row" htmlFor="pref-webhook-enabled">
                          <input
                            id="pref-webhook-enabled"
                            type="checkbox"
                            checked={webhookEnabled}
                            onChange={(event) => {
                              setDraftWebhookEnabled(event.target.checked)
                              setPrefNotice(null)
                            }}
                          />
                          <span>开启 Webhook 外部推送</span>
                        </label>
                        <InfoHint term="webhook_push" />
                      </div>
                    </div>

                    <div className="field">
                      <div className="field-label-row">
                        <label htmlFor="pref-channel-type">推送渠道类型</label>
                        <InfoHint
                          title="推送渠道类型"
                          entry={{
                            summary:
                              '选择外部 Webhook 接收端消息体格式，支持飞书机器人、企业微信机器人或自定义 JSON 回调。',
                            reading:
                              '需与下方配置的 Webhook URL 所属平台匹配，以免消息签名或格式校验失败。',
                          }}
                        />
                      </div>
                      <select
                        id="pref-channel-type"
                        className="input"
                        value={channelType}
                        onChange={(event) => {
                          const next = event.target.value
                          if (isWebhookChannel(next)) {
                            setDraftChannelType(next)
                            setPrefNotice(null)
                          }
                        }}
                      >
                        {CHANNEL_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="field field-full">
                      <div className="field-label-row">
                        <label htmlFor="pref-webhook-url">新 Webhook URL（可选）</label>
                        <InfoHint
                          title="Webhook URL 安全约束"
                          entry={{
                            summary:
                              '接收击球区命中与否证触发通知的公网 HTTPS 回调地址；留空保存将保留当前已加密存储的地址。',
                            reading:
                              '出于 SSRF 安全隔离考虑，禁止填写 localhost、127.0.0.1 或内网保留 IP；点击「清空 Webhook」可彻底移除。',
                          }}
                        />
                      </div>
                      <input
                        id="pref-webhook-url"
                        className="input mono"
                        type="url"
                        maxLength={500}
                        placeholder={
                          prefs?.webhook_url_configured
                            ? '留空保留已配置地址，或输入新公网 Webhook URL 覆盖'
                            : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'
                        }
                        value={webhookUrlInput}
                        onChange={(event) => {
                          setWebhookUrlInput(event.target.value)
                          setPrefNotice(null)
                        }}
                      />
                    </div>
                  </div>

                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={!prefs?.webhook_url_configured || updatePreferences.isPending}
                      onClick={handleClearWebhook}
                    >
                      清空 Webhook
                    </button>
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={updatePreferences.isPending}
                    >
                      {updatePreferences.isPending ? '保存中...' : '保存推送设置'}
                    </button>
                  </div>

                  {prefError ? (
                    <div className="inline-error" role="alert">
                      {prefError}
                    </div>
                  ) : null}

                  {prefNotice ? (
                    <div className="notice-box" role="status">
                      {prefNotice}
                    </div>
                  ) : null}
                </form>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
