export type ParsedOptionalNumber = { ok: true; value: number | null } | { ok: false; error: string }

export function isValidEmailFormat(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim())
}

export function isSixDigitCode(raw: string): boolean {
  return /^[0-9]{6}$/.test(raw.trim())
}

export function parseOptionalNumber(
  raw: string,
  label: string,
  constraints: { min?: number; max?: number },
): ParsedOptionalNumber {
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
