import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GLOSSARY } from '../../lib/glossary'
import { Card } from './Card'
import { GlossaryLabel, InfoHint } from './InfoHint'
import { Metric } from './Metric'

describe('InfoHint', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(window, 'innerHeight', {
      value: 768,
      configurable: true,
      writable: true,
    })
  })

  it('opens a portal tooltip on hover, allows moving onto popover, and closes after 120ms grace period', () => {
    vi.useFakeTimers()
    const { container } = render(
      <div className="clip-box">
        <InfoHint term="equity_bond_spread" />
      </div>,
    )

    const trigger = screen.getByRole('button', { name: '解释：股债性价比 (ERP)' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(trigger)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toBeInTheDocument()
    expect(container.contains(tooltip)).toBe(false)
    expect(document.body.contains(tooltip)).toBe(true)
    expect(tooltip).toHaveTextContent(`大白话：${GLOSSARY.equity_bond_spread.plain}`)
    expect(tooltip).toHaveTextContent(GLOSSARY.equity_bond_spread.summary)
    expect(tooltip).toHaveTextContent(GLOSSARY.equity_bond_spread.formula)
    expect(tooltip).toHaveTextContent(GLOSSARY.equity_bond_spread.reading)

    // Leaving trigger keeps popover open during the 120ms grace window so user can hover onto popover.
    fireEvent.mouseLeave(trigger)
    act(() => {
      vi.advanceTimersByTime(80)
    })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseEnter(tooltip)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseLeave(tooltip)
    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('toggles on click without propagating to parent interactive elements and closes on Escape / outside click', () => {
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <InfoHint term="radar_total_score" size="md" />
      </div>,
    )

    const trigger = screen.getByRole('button', { name: '解释：综合雷达评分' })
    expect(trigger).toHaveClass('info-hint-btn', 'info-hint-btn-md')

    fireEvent.click(trigger)
    expect(parentClick).not.toHaveBeenCalled()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('opens on keyboard focus, closes on blur, and cleans up portal on unmount', () => {
    const { unmount } = render(<InfoHint term="reverse_dcf" />)
    const trigger = screen.getByRole('button', { name: '解释：Reverse DCF 逆向估值反推器' })

    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.blur(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    unmount()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('supports custom title and entry, flips below when top headroom < 160px, and clamps horizontally', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 400,
      configurable: true,
      writable: true,
    })

    render(
      <InfoHint
        title="自定义口径"
        entry={{
          summary: '这是自定义解释文案。',
          reading: '越大越好。',
        }}
      />,
    )

    const trigger = screen.getByRole('button', { name: '解释：自定义口径' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      right: 26,
      top: 40,
      bottom: 56,
      width: 16,
      height: 16,
      x: 10,
      y: 40,
      toJSON: () => ({}),
    })

    fireEvent.click(trigger)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveAttribute('data-placement', 'bottom')
    expect(tooltip).toHaveStyle({ left: '12px' })
    expect(tooltip).toHaveTextContent('自定义口径')
    expect(tooltip).toHaveTextContent('这是自定义解释文案。')
  })

  it('keeps label text nodes crisp in GlossaryLabel, Card, and Metric', () => {
    render(
      <Card title="核心指标卡片" hint="compare_matrix">
        <GlossaryLabel label="净现金 / 总市值" term="net_cash_to_mv" />
        <Metric label="5年平均 ROE" hint="roe_5y_avg" value="31.80%" />
      </Card>,
    )

    expect(screen.getByText('核心指标卡片').tagName).toBe('SPAN')
    expect(screen.getByText('净现金 / 总市值').tagName).toBe('SPAN')
    expect(screen.getByText('5年平均 ROE').tagName).toBe('SPAN')
    expect(screen.getByRole('button', { name: '解释：同业横向对比矩阵' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：净现金 / 总市值' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解释：5年平均 ROE' })).toBeInTheDocument()
  })

  it('dismisses pinned tooltip on outside pointerdown and touchstart without breaking trigger toggle', () => {
    render(<InfoHint term="radar_total_score" />)
    const trigger = screen.getByRole('button', { name: '解释：综合雷达评分' })

    fireEvent.pointerDown(trigger)
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toBeInTheDocument()

    fireEvent.touchStart(tooltip)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.touchStart(document.body)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('flips tall popover below when trigger top headroom is smaller than popover height', () => {
    render(
      <InfoHint
        title="高弹窗口径"
        entry={{
          summary: '用于验证较高弹窗在顶部空间不足时自动向下方展开。',
        }}
      />,
    )

    const trigger = screen.getByRole('button', { name: '解释：高弹窗口径' })
    const makeRect = (top: number, bottom: number, left: number, right: number): DOMRect => ({
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top,
      toJSON: () => ({}),
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === trigger) {
        return makeRect(170, 186, 200, 216)
      }
      if (this.getAttribute('role') === 'tooltip') {
        return makeRect(0, 220, 0, 320)
      }
      return makeRect(0, 0, 0, 0)
    })

    fireEvent.click(trigger)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveAttribute('data-placement', 'bottom')
    expect(tooltip).toHaveStyle({ top: '194px' })
  })

  it('renders plain callout above summary when present, inherits base plain on term override, and omits when empty', () => {
    const { rerender } = render(<InfoHint term="reverse_dcf" />)
    fireEvent.click(screen.getByRole('button', { name: '解释：Reverse DCF 逆向估值反推器' }))

    let tooltip = screen.getByRole('tooltip')
    const plainEl = tooltip.querySelector('.info-hint-plain')
    const summaryEl = tooltip.querySelector('.info-hint-summary')
    expect(plainEl).not.toBeNull()
    expect(summaryEl).not.toBeNull()
    expect(plainEl).toHaveTextContent(`大白话：${GLOSSARY.reverse_dcf.plain}`)
    if (plainEl && summaryEl) {
      expect(
        Boolean(plainEl.compareDocumentPosition(summaryEl) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true)
    }

    rerender(
      <InfoHint
        term="reverse_dcf"
        entry={{
          summary: '仅覆盖专业说明，保留基础大白话。',
        }}
      />,
    )
    tooltip = screen.getByRole('tooltip')
    expect(tooltip.querySelector('.info-hint-plain')).toHaveTextContent(
      `大白话：${GLOSSARY.reverse_dcf.plain}`,
    )
    expect(tooltip.querySelector('.info-hint-summary')).toHaveTextContent(
      '仅覆盖专业说明，保留基础大白话。',
    )

    rerender(
      <InfoHint
        title="无大白话词条"
        entry={{
          plain: '   ',
          summary: '仅展示专业口径说明。',
        }}
      />,
    )
    tooltip = screen.getByRole('tooltip')
    expect(tooltip.querySelector('.info-hint-plain')).toBeNull()
    expect(tooltip.querySelector('.info-hint-summary')).toHaveTextContent('仅展示专业口径说明。')
  })
})
