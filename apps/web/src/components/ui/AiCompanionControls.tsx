import { AI_REQUEST_MODE_OPTIONS, getAiQuotaTagMeta, type AiRequestMode } from '../../lib/aiLabels'
import type { AiQuotaStatus } from '../../types/api'
import { InfoHint } from './InfoHint'
import { Tag } from './Tag'

type AiCompanionControlsProps = {
  mode: AiRequestMode
  onModeChange: (nextMode: AiRequestMode) => void
  quota: AiQuotaStatus | null
  ariaLabel: string
  disabled?: boolean
}

export function AiCompanionControls({
  mode,
  onModeChange,
  quota,
  ariaLabel,
  disabled = false,
}: AiCompanionControlsProps) {
  const quotaMeta = quota ? getAiQuotaTagMeta(quota) : null

  return (
    <div className="ai-controls">
      {quotaMeta ? (
        <span className="label-with-hint">
          <Tag color={quotaMeta.color}>{quotaMeta.label}</Tag>
          <InfoHint
            term="byok_ai"
            title={quota?.byok_active ? 'BYOK 自备密钥推理' : '平台 AI 每日额度与 BYOK'}
          />
        </span>
      ) : null}
      <div className="label-with-hint">
        <div className="filter-bar" role="group" aria-label={ariaLabel}>
          {AI_REQUEST_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={mode === option.value}
              className={mode === option.value ? 'filter-pill active' : 'filter-pill'}
              onClick={() => onModeChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <InfoHint
          title="AI 执行模式切换"
          entry={{
            summary:
              '可在「智能推演 (auto)」与「纯规则引擎 (rule_only)」之间切换：auto 会基于受事实约束的快照调用大模型（或 BYOK），并在超限或失败时自动回退规则引擎；rule_only 全程使用本地确定性规则。',
            reading:
              'rule_only 完全不消耗每日平台 AI 额度，适合离线、批量验证或额度用尽时无缝兜底。',
          }}
        />
      </div>
    </div>
  )
}
