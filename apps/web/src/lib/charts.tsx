import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'

// 按需注册，避免把整包 echarts 打进产物。
echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

interface ChartProps {
  option: echarts.EChartsCoreOption
  height?: number
  ariaLabel?: string
}

/** Thin ECharts wrapper: owns init/resize/dispose, re-applies option on change. */
export function Chart({ option, height = 260, ariaLabel }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

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
    chartRef.current?.setOption(option, true)
  }, [option])

  return <div ref={containerRef} style={{ height }} role="img" aria-label={ariaLabel} />
}
