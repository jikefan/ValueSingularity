import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSetOption = vi.fn()
const mockResize = vi.fn()
const mockDispose = vi.fn()

vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({
    setOption: mockSetOption,
    resize: mockResize,
    dispose: mockDispose,
  })),
}))

vi.mock('echarts/charts', () => ({
  BarChart: {},
  LineChart: {},
  RadarChart: {},
}))

vi.mock('echarts/components', () => ({
  GridComponent: {},
  LegendComponent: {},
  RadarComponent: {},
  TooltipComponent: {},
}))

vi.mock('echarts/renderers', () => ({
  CanvasRenderer: {},
}))

import { Chart } from './charts'
import {
  CHART_AXIS_COMMON,
  CHART_COLORS,
  CHART_FONT_FAMILY,
  CHART_LEGEND_COMMON,
  CHART_TOOLTIP_COMMON,
  LIGHT_CHART_COLORS,
  createChartTheme,
} from './chartTheme'

describe('Chart', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete document.documentElement.dataset.theme
    window.localStorage.clear()
  })

  it('disables initial chart animation inside setOption so bars render immediately', () => {
    render(
      <Chart
        ariaLabel="示例柱状图"
        option={{
          series: [{ type: 'bar', data: [10, 20] }],
        }}
      />,
    )

    expect(mockSetOption).toHaveBeenCalledTimes(1)
    expect(mockSetOption).toHaveBeenCalledWith(
      {
        animation: false,
        textStyle: { fontFamily: CHART_FONT_FAMILY, color: CHART_COLORS.text },
        series: [{ type: 'bar', data: [10, 20] }],
      },
      true,
    )
  })

  it('re-applies setOption with light palette text color when data-theme changes to light', async () => {
    render(
      <Chart
        ariaLabel="主题切换柱状图"
        option={{
          series: [{ type: 'bar', data: [10, 20] }],
        }}
      />,
    )

    expect(mockSetOption).toHaveBeenCalledTimes(1)
    expect(mockSetOption).toHaveBeenLastCalledWith(
      {
        animation: false,
        textStyle: { fontFamily: CHART_FONT_FAMILY, color: CHART_COLORS.text },
        series: [{ type: 'bar', data: [10, 20] }],
      },
      true,
    )

    document.documentElement.dataset.theme = 'light'

    await waitFor(() => {
      expect(mockSetOption).toHaveBeenCalledTimes(2)
    })
    expect(mockSetOption).toHaveBeenLastCalledWith(
      {
        animation: false,
        textStyle: { fontFamily: CHART_FONT_FAMILY, color: LIGHT_CHART_COLORS.text },
        series: [{ type: 'bar', data: [10, 20] }],
      },
      true,
    )
  })

  it('builds theme-synchronized ECharts defaults from createChartTheme and derives dark constants cleanly', () => {
    const darkTheme = createChartTheme('dark')
    expect(darkTheme.colors).toBe(CHART_COLORS)
    expect(darkTheme.axis).toStrictEqual(CHART_AXIS_COMMON)
    expect(darkTheme.legend).toStrictEqual(CHART_LEGEND_COMMON)
    expect(darkTheme.tooltip).toStrictEqual(CHART_TOOLTIP_COMMON)

    const lightTheme = createChartTheme('light')
    expect(lightTheme.colors).toBe(LIGHT_CHART_COLORS)
    expect(lightTheme.axis).toMatchObject({
      axisLine: { lineStyle: { color: LIGHT_CHART_COLORS.axisLine } },
      axisLabel: { color: LIGHT_CHART_COLORS.muted, fontFamily: CHART_FONT_FAMILY },
      splitLine: { lineStyle: { color: LIGHT_CHART_COLORS.grid } },
    })
    expect(lightTheme.legend).toMatchObject({
      textStyle: { color: LIGHT_CHART_COLORS.text, fontFamily: CHART_FONT_FAMILY },
    })
    expect(lightTheme.tooltip).toMatchObject({
      backgroundColor: LIGHT_CHART_COLORS.panel,
      borderColor: LIGHT_CHART_COLORS.axisLine,
      textStyle: { color: LIGHT_CHART_COLORS.white, fontFamily: CHART_FONT_FAMILY },
    })
  })

  it('exposes A-share flow polarity and Singularity accent colors in dark and light palettes', () => {
    expect(CHART_COLORS.flowIn).toBe(CHART_COLORS.negative)
    expect(CHART_COLORS.flowOut).toMatch(/^#[0-9a-f]{6}$/)
    expect(CHART_COLORS.flowOut).not.toBe(CHART_COLORS.flowIn)
    expect(CHART_COLORS.singularityPrimary).toMatch(/^#[0-9a-f]{6}$/)
    expect(CHART_COLORS.singularitySecondary).toBe(CHART_COLORS.electric)
    expect(CHART_COLORS.singularityGlow).toMatch(/^#[0-9a-f]{6}$/)

    expect(LIGHT_CHART_COLORS.flowIn).toBe(LIGHT_CHART_COLORS.negative)
    expect(LIGHT_CHART_COLORS.flowOut).toBe(LIGHT_CHART_COLORS.positive)
    expect(LIGHT_CHART_COLORS.flowOut).not.toBe(LIGHT_CHART_COLORS.flowIn)
    expect(LIGHT_CHART_COLORS.singularityPrimary).toMatch(/^#[0-9a-f]{6}$/)
    expect(LIGHT_CHART_COLORS.singularityPrimary).not.toBe(CHART_COLORS.singularityPrimary)
    expect(LIGHT_CHART_COLORS.singularitySecondary).toBe(LIGHT_CHART_COLORS.electric)
    expect(LIGHT_CHART_COLORS.singularityGlow).toMatch(/^#[0-9a-f]{6}$/)
  })
})
