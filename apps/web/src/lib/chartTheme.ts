/**
 * ECharts 在 canvas 里绘制，读不到 CSS 变量，颜色只能以字面量传入。
 * 这里是唯一的例外处：值必须与 `styles/tokens.css` 保持一致。
 */
export const CHART_COLORS = {
  text: '#9fb4c8',
  muted: '#6e869c',
  white: '#f4f9ff',
  panel: '#0c1620',
  axisLine: '#1e2f40',
  grid: 'rgba(126, 149, 170, 0.12)',
  positive: '#73f0c3',
  negative: '#ff6b8a',
  electric: '#59c6ff',
  amber: '#f6c760',
  violet: '#b79cff',
} as const

export const CHART_FONT_FAMILY =
  "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif"

export const CHART_AXIS_COMMON = {
  axisLine: { lineStyle: { color: CHART_COLORS.axisLine } },
  axisTick: { show: false },
  axisLabel: { color: CHART_COLORS.muted, fontFamily: CHART_FONT_FAMILY },
  splitLine: { lineStyle: { color: CHART_COLORS.grid } },
} as const

export const CHART_LEGEND_COMMON = {
  top: 0,
  textStyle: { color: CHART_COLORS.text, fontFamily: CHART_FONT_FAMILY, fontSize: 12 },
} as const

export const CHART_TOOLTIP_COMMON = {
  backgroundColor: CHART_COLORS.panel,
  borderColor: CHART_COLORS.axisLine,
  textStyle: { color: CHART_COLORS.white, fontFamily: CHART_FONT_FAMILY, fontSize: 12 },
} as const
