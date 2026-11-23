import { BarChart, LineChart, RadarChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  RadarComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'
import { CHART_FONT_FAMILY, getChartPalette } from './chartTheme'
import { useThemeMode } from './theme'

// 按需注册，避免把整包 echarts 打进产物。
echarts.use([
  BarChart,
  LineChart,
  RadarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  RadarComponent,
  CanvasRenderer,
])

export type ChartOption = echarts.EChartsCoreOption

export type ChartProps = {
  option: ChartOption
  height?: number
  ariaLabel?: string
  className?: string
}

/** Thin ECharts wrapper: owns init/resize/dispose, re-applies option on change. */
export function Chart({ option, height = 260, ariaLabel, className }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const { theme } = useThemeMode()
  const palette = getChartPalette(theme)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const chart = echarts.init(container)
    chartRef.current = chart

    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(container)

    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(
      {
        animation: false,
        textStyle: { fontFamily: CHART_FONT_FAMILY, color: palette.text },
        ...option,
      },
      true,
    )
  }, [option, palette.text])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    />
  )
}
