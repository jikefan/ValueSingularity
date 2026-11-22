import { AI_REQUEST_MODE_OPTIONS, getAiQuotaTagMeta, type AiRequestMode } from '../../lib/aiLabels'
import type { AiQuotaStatus } from '../../types/api'
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
      {quotaMeta ? <Tag color={quotaMeta.color}>{quotaMeta.label}</Tag> : null}
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
    </div>
  )
}
