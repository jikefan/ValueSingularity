/**
 * ECharts 在 canvas 里绘制，读不到 CSS 变量，颜色只能以字面量传入。
 * 这里是唯一的例外处：值必须与 `styles/tokens.css` 保持一致。
 */
export const CHART_COLORS = {
  text: '#9fb4c8',
  muted: '#6e869c',
  grid: 'rgba(126, 149, 170, 0.12)',
  positive: '#73f0c3',
  negative: '#ff6b8a',
} as const
