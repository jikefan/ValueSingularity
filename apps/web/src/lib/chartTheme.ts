import type { ThemeMode } from './theme'

export type ChartPalette = {
  readonly text: string
  readonly muted: string
  readonly white: string
  readonly panel: string
  readonly axisLine: string
  readonly grid: string
  readonly positive: string
  readonly negative: string
  readonly electric: string
  readonly amber: string
  readonly violet: string
}

/**
 * ECharts 在 canvas 里绘制，读不到 CSS 变量，颜色只能以字面量传入。
 * 这里是唯一的例外处：值必须与 `styles/tokens.css` 保持一致。
 */
export const CHART_COLORS = {
  text: '#a1a8b5',
  muted: '#818a99',
  white: '#ffffff',
  panel: '#111318',
  axisLine: '#262b35',
  grid: 'rgba(255, 255, 255, 0.06)',
  positive: '#1fd07a',
  negative: '#f43f5e',
  electric: '#3b82f6',
  amber: '#f59e0b',
  violet: '#a78bfa',
} as const satisfies ChartPalette

export const LIGHT_CHART_COLORS = {
  text: '#475569',
  muted: '#5a6577',
  white: '#0b0e14',
  panel: '#ffffff',
  axisLine: '#d6dce6',
  grid: 'rgba(15, 23, 42, 0.06)',
  positive: '#0a7b48',
  negative: '#be123c',
  electric: '#1d4ed8',
  amber: '#92400e',
  violet: '#6d28d9',
} as const satisfies ChartPalette

/** Resolves ECharts canvas palette matching the active Carbon Dark or Ceramic Light theme. */
export function getChartPalette(theme: ThemeMode): ChartPalette {
  switch (theme) {
    case 'light':
      return LIGHT_CHART_COLORS
    case 'dark':
      return CHART_COLORS
    default: {
      const _exhaustive: never = theme
      return _exhaustive
    }
  }
}

export const CHART_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif"

/** Builds theme-synchronized ECharts palette and shared option defaults for Carbon Dark or Ceramic Light. */
export function createChartTheme(theme: ThemeMode) {
  const colors = getChartPalette(theme)
  return {
    colors,
    axis: {
      axisLine: { lineStyle: { color: colors.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: colors.muted, fontFamily: CHART_FONT_FAMILY },
      splitLine: { lineStyle: { color: colors.grid } },
    },
    legend: {
      top: 0,
      textStyle: { color: colors.text, fontFamily: CHART_FONT_FAMILY, fontSize: 12 },
    },
    tooltip: {
      backgroundColor: colors.panel,
      borderColor: colors.axisLine,
      textStyle: { color: colors.white, fontFamily: CHART_FONT_FAMILY, fontSize: 12 },
    },
  } as const
}

const DARK_CHART_THEME = createChartTheme('dark')

export const CHART_AXIS_COMMON = DARK_CHART_THEME.axis
export const CHART_LEGEND_COMMON = DARK_CHART_THEME.legend
export const CHART_TOOLTIP_COMMON = DARK_CHART_THEME.tooltip
