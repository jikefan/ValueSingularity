/** Formatting helpers shared by pages and cards. All take plain numbers or nullable values. */

export function fmtPct(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

export function fmtNum(value: number, digits = 2): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function fmtMoney(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)} 万`
  return value.toFixed(2)
}

export function chgClass(value: number): string {
  if (value > 0) return 'up'
  if (value < 0) return 'down'
  return 'flat'
}

export function fmtDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function formatYi(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—'
  }
  return `${fmtNum(value / 1e8, digits)} 亿元`
}

export function toYi(value: number | null | undefined, digits = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  return Number((value / 1e8).toFixed(digits))
}

export function formatPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—'
  }
  return `${value.toFixed(digits)}%`
}

export function formatSignedPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—'
  }
  return fmtPct(value, digits)
}

export function formatNum(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—'
  }
  return fmtNum(value, digits)
}

export function deltaTone(
  value: number | null | undefined,
  invert = false,
): 'up' | 'down' | 'flat' | '' {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return ''
  }
  if (value === 0) {
    return 'flat'
  }
  if (invert) {
    return value > 0 ? 'down' : 'up'
  }
  return value > 0 ? 'up' : 'down'
}

export function qualityTone(
  value: number | null | undefined,
  invert = false,
): 'tone-good' | 'tone-bad' | 'flat' | '' {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return ''
  }
  if (value === 0) {
    return 'flat'
  }
  if (invert) {
    return value > 0 ? 'tone-bad' : 'tone-good'
  }
  return value > 0 ? 'tone-good' : 'tone-bad'
}

export function formatStockName(name: string | null | undefined): string {
  if (!name) {
    return '—'
  }
  const compact = name.replace(/\s+/g, '')
  return compact.length > 0 ? compact : '—'
}

export function formatForensicRatioPct(
  value: number | null | undefined,
  options?: { fallbackText?: string; maxDisplay?: number },
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return options?.fallbackText ?? '—'
  }
  const maxDisplay = options?.maxDisplay ?? 900
  if (Math.abs(value) >= maxDisplay) {
    // Guard against legacy 999.0% sentinel values produced when core profit nears zero.
    return options?.fallbackText ?? '主业微利(不适用)'
  }
  return `${value.toFixed(1)}%`
}
