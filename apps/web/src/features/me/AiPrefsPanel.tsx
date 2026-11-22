import { useEffect, useState } from 'react'
import { Card } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { useAiPreferences, useUpdateAiPreferences } from '../../lib/useAi'
import type { AiPreferencesUpdate, PlanTier } from '../../types/api'

const PLAN_TIER_COLOR: Record<PlanTier, 'gray' | 'blue' | 'green'> = {
  free: 'gray',
  pro: 'blue',
  ai_plus: 'green',
}

export function AiPrefsPanel({ enabled }: { enabled: boolean }) {
  const preferencesQuery = useAiPreferences(enabled)
  const updatePreferences = useUpdateAiPreferences()

  const [draftPreferRuleOnly, setDraftPreferRuleOnly] = useState<boolean | null>(null)
  const [draftByokEnabled, setDraftByokEnabled] = useState<boolean | null>(null)
  const [draftByokModel, setDraftByokModel] = useState<string | null>(null)
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [clearBaseUrl, setClearBaseUrl] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [prefNotice, setPrefNotice] = useState<string | null>(null)

  const prefs = preferencesQuery.data
  const preferRuleOnly = draftPreferRuleOnly ?? prefs?.prefer_rule_only ?? false
  const byokEnabled = draftByokEnabled ?? prefs?.byok_enabled ?? false
  const byokModel = draftByokModel ?? prefs?.byok_model ?? 'gpt-4o-mini'
  const byokBaseUrlMasked = prefs?.byok_base_url_masked ?? null

  useEffect(() => {
    if (byokBaseUrlMasked === null) {
      setClearBaseUrl(false)
    }
  }, [byokBaseUrlMasked])

  const isDirty =
    prefs !== undefined &&
    (preferRuleOnly !== prefs.prefer_rule_only ||
      byokEnabled !== prefs.byok_enabled ||
      byokModel !== prefs.byok_model ||
      baseUrlInput.length > 0 ||
      clearBaseUrl ||
      apiKeyInput.length > 0)

  function clearFeedbackOnEdit() {
    setFormError(null)
    setPrefNotice(null)
    updatePreferences.reset()
  }

  function resetDrafts(notice: string | null) {
    setDraftPreferRuleOnly(null)
    setDraftByokEnabled(null)
    setDraftByokModel(null)
    setBaseUrlInput('')
    setClearBaseUrl(false)
    setApiKeyInput('')
    setFormError(null)
    setPrefNotice(notice)
  }

  function handleDiscardChanges() {
    updatePreferences.reset()
    resetDrafts(null)
  }

  function handleSavePreferences() {
    if (updatePreferences.isPending) {
      return
    }
    setPrefNotice(null)
    const trimmedModel = byokModel.trim()
    const trimmedBaseUrl = baseUrlInput.trim()
    const trimmedApiKey = apiKeyInput.trim()

    if (!trimmedModel || trimmedModel.length > 64) {
      setFormError('请输入 1–64 个字符的 BYOK 模型名称')
      return
    }
    if (trimmedBaseUrl.length > 500) {
      setFormError('BYOK Base URL 不能超过 500 个字符')
      return
    }
    if (trimmedApiKey.length > 300) {
      setFormError('BYOK API Key 不能超过 300 个字符')
      return
    }

    const hasResolvedUrl =
      !clearBaseUrl && (Boolean(trimmedBaseUrl) || Boolean(prefs?.byok_base_url_masked))
    const hasResolvedKey = Boolean(trimmedApiKey) || Boolean(prefs?.byok_api_key_configured)

    if (clearBaseUrl && byokEnabled) {
      setFormError('启用 BYOK 时不能同时清空 Base URL')
      return
    }
    if (byokEnabled && !hasResolvedUrl && !hasResolvedKey) {
      setFormError('启用 BYOK 自备密钥前，请先配置公网 Base URL 与 API Key')
      return
    }
    if (byokEnabled && !hasResolvedUrl) {
      setFormError('启用 BYOK 自备密钥前，请先填写公网 Base URL')
      return
    }
    if (byokEnabled && !hasResolvedKey) {
      setFormError('启用 BYOK 自备密钥前，请先填写 API Key')
      return
    }

    setFormError(null)
    const payload: AiPreferencesUpdate = {
      prefer_rule_only: preferRuleOnly,
      byok_enabled: byokEnabled,
      byok_model: trimmedModel,
      ...(clearBaseUrl
        ? { byok_base_url: '' }
        : trimmedBaseUrl
          ? { byok_base_url: trimmedBaseUrl }
          : {}),
      ...(trimmedApiKey ? { byok_api_key: trimmedApiKey } : {}),
    }

    updatePreferences.mutate(payload, {
      onSuccess: () => {
        resetDrafts('AI 偏好与 BYOK 设置已保存')
      },
    })
  }

  function handleClearApiKey() {
    if (updatePreferences.isPending) {
      return
    }
    setPrefNotice(null)
    setFormError(null)

    updatePreferences.mutate(
      {
        byok_enabled: false,
        byok_api_key: '',
      },
      {
        onSuccess: () => {
          resetDrafts('已清除已存 BYOK API Key 并关闭自备密钥接管')
        },
      },
    )
  }

  const mutationError = updatePreferences.isError
    ? updatePreferences.error instanceof Error
      ? updatePreferences.error.message
      : 'AI 设置保存失败，请检查配置'
    : null
  const activeError = formError ?? mutationError

  return (
    <Card
      title="AI 决策伙伴额度与 BYOK 设置"
      extra={
        prefs ? (
          <div className="sentinel-list">
            <Tag color={PLAN_TIER_COLOR[prefs.quota.plan_tier]}>
              {`套餐 ${prefs.quota.plan_tier.toUpperCase()}`}
            </Tag>
            <Tag color={prefs.quota.byok_active ? 'green' : 'blue'}>
              {prefs.quota.byok_active ? 'BYOK 已接管' : '平台托管额度'}
            </Tag>
          </div>
        ) : null
      }
    >
      {preferencesQuery.isPending || (!prefs && preferencesQuery.isFetching) ? (
        <LoadingBlock lines={3} />
      ) : preferencesQuery.isError ? (
        <ErrorBlock
          title="AI 额度与偏好设置加载失败"
          message={
            preferencesQuery.error instanceof Error ? preferencesQuery.error.message : '未知错误'
          }
          onRetry={() => {
            void preferencesQuery.refetch()
          }}
        />
      ) : !prefs ? null : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="ai-quota-grid">
            <Metric
              label="当前套餐等级"
              value={`套餐 · ${prefs.quota.plan_tier.toUpperCase()}`}
              sub={prefs.quota.byok_active ? 'BYOK 已接管推理调用' : '使用平台托管额度'}
            />
            <Metric
              label="今日已用 / 每日上限"
              value={`${prefs.quota.used_today} / ${prefs.quota.daily_limit}`}
              sub="仅统计平台托管大模型调用"
            />
            <Metric
              label="今日剩余额度"
              value={prefs.quota.remaining_today}
              tone={prefs.quota.remaining_today > 0 ? 'tone-good' : 'tone-bad'}
              sub="纯规则引擎永不消耗额度"
            />
            <Metric
              label="每日额度重置"
              value={<span className="small">北京时间每日 00:00 清零</span>}
              sub={
                <span
                  title={`按上海时区（Asia/Shanghai / CST）每日零点刷新，当前周期截止：${prefs.quota.resets_at_shanghai}`}
                >
                  本周期截止 <span className="mono">{prefs.quota.resets_at_shanghai}</span>
                </span>
              }
            />
          </div>

          <form
            className="stack subpanel"
            noValidate
            aria-busy={updatePreferences.isPending}
            onSubmit={(event) => {
              event.preventDefault()
              handleSavePreferences()
            }}
          >
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <strong className="small">执行模式与 BYOK 自备密钥</strong>
              <div className="sentinel-list">
                {prefs.byok_base_url_masked ? (
                  <Tag color="blue">{`Base URL · ${prefs.byok_base_url_masked}`}</Tag>
                ) : (
                  <Tag color="gray">Base URL 未配置</Tag>
                )}
                <Tag color={prefs.byok_api_key_configured ? 'green' : 'gray'}>
                  {prefs.byok_api_key_configured
                    ? `API Key · ${prefs.byok_api_key_masked ?? '****'}`
                    : 'API Key 未配置'}
                </Tag>
              </div>
            </div>

            <div className="form-grid">
              <div className="field">
                <label className="checkbox-row" htmlFor="ai-prefer-rule-only">
                  <input
                    id="ai-prefer-rule-only"
                    type="checkbox"
                    checked={preferRuleOnly}
                    disabled={updatePreferences.isPending}
                    onChange={(event) => {
                      setDraftPreferRuleOnly(event.target.checked)
                      clearFeedbackOnEdit()
                    }}
                  />
                  <span>默认仅用纯规则引擎（不消耗额度）</span>
                </label>

                <label className="checkbox-row" htmlFor="ai-byok-enabled">
                  <input
                    id="ai-byok-enabled"
                    type="checkbox"
                    checked={byokEnabled}
                    disabled={updatePreferences.isPending}
                    onChange={(event) => {
                      setDraftByokEnabled(event.target.checked)
                      clearFeedbackOnEdit()
                    }}
                  />
                  <span>启用 BYOK 自备 OpenAI 兼容密钥</span>
                </label>
              </div>

              <div className="field">
                <label htmlFor="ai-byok-model">BYOK 模型名称</label>
                <input
                  id="ai-byok-model"
                  className="input mono"
                  type="text"
                  maxLength={64}
                  disabled={updatePreferences.isPending}
                  placeholder="gpt-4o-mini"
                  value={byokModel}
                  onChange={(event) => {
                    setDraftByokModel(event.target.value)
                    clearFeedbackOnEdit()
                  }}
                />
              </div>

              <div className="field field-full">
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <label htmlFor="ai-byok-base-url">BYOK Base URL（可选）</label>
                  <label className="checkbox-row" htmlFor="ai-clear-base-url">
                    <input
                      id="ai-clear-base-url"
                      type="checkbox"
                      checked={clearBaseUrl}
                      disabled={!prefs.byok_base_url_masked || updatePreferences.isPending}
                      onChange={(event) => {
                        const checked = event.target.checked
                        setClearBaseUrl(checked)
                        if (checked) {
                          setBaseUrlInput('')
                        }
                        clearFeedbackOnEdit()
                      }}
                    />
                    <span>清空 Base URL</span>
                  </label>
                </div>
                <input
                  id="ai-byok-base-url"
                  className="input mono"
                  type="url"
                  maxLength={500}
                  disabled={clearBaseUrl || updatePreferences.isPending}
                  placeholder={
                    prefs.byok_base_url_masked
                      ? '留空保留已配置地址，或输入新公网 Base URL 覆盖'
                      : 'https://api.openai.com/v1'
                  }
                  value={baseUrlInput}
                  onChange={(event) => {
                    setBaseUrlInput(event.target.value)
                    setClearBaseUrl(false)
                    clearFeedbackOnEdit()
                  }}
                />
              </div>

              <div className="field field-full">
                <label htmlFor="ai-byok-api-key">BYOK API Key（可选）</label>
                <input
                  id="ai-byok-api-key"
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  maxLength={300}
                  disabled={updatePreferences.isPending}
                  placeholder={
                    prefs.byok_api_key_configured
                      ? '留空保留已存密钥，或输入新 API Key 覆盖'
                      : 'sk-...'
                  }
                  value={apiKeyInput}
                  onChange={(event) => {
                    setApiKeyInput(event.target.value)
                    clearFeedbackOnEdit()
                  }}
                />
              </div>
            </div>

            <div className="form-actions">
              {isDirty ? (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={updatePreferences.isPending}
                  onClick={handleDiscardChanges}
                >
                  重置未保存修改
                </button>
              ) : null}
              <button
                type="button"
                className="btn-danger"
                disabled={!prefs.byok_api_key_configured || updatePreferences.isPending}
                onClick={handleClearApiKey}
              >
                清除已存 Key
              </button>
              <button type="submit" className="btn-primary" disabled={updatePreferences.isPending}>
                {updatePreferences.isPending ? '保存中...' : '保存 AI 设置'}
              </button>
            </div>

            {activeError ? (
              <div className="inline-error" role="alert">
                {activeError}
              </div>
            ) : null}

            {prefNotice ? (
              <div className="notice-box" role="status">
                {prefNotice}
              </div>
            ) : null}
          </form>
        </div>
      )}
    </Card>
  )
}
