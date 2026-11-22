import { cleanup, render } from '@testing-library/react'
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
import { CHART_COLORS, CHART_FONT_FAMILY } from './chartTheme'

describe('Chart', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
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
})
