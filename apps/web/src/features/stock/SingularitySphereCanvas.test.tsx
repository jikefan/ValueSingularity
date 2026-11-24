import { describe, expect, it } from 'vitest'
import { resolveSingularityPillLayout } from './singularityLayout'

describe('resolveSingularityPillLayout', () => {
  it('clears the top HUD and clamps wide labels inside desktop and mobile stage borders', () => {
    const mobilePlaced = resolveSingularityPillLayout({
      stageWidth: 328,
      stageHeight: 340,
      hudHeight: 28,
      pills: [
        { index: 0, rawX: 14, rawY: 12, z: 0.94, width: 120, height: 24 },
        { index: 1, rawX: 318, rawY: 332, z: 0.95, width: 118, height: 24 },
        { index: 2, rawX: 164, rawY: 180, z: 1.05, width: 100, height: 24 },
      ],
    })

    const leftEdgePill = mobilePlaced[0]
    const rightEdgePill = mobilePlaced[1]
    const backPill = mobilePlaced[2]

    expect(leftEdgePill).toBeDefined()
    expect(rightEdgePill).toBeDefined()
    expect(backPill).toBeDefined()

    expect(leftEdgePill?.x).toBeGreaterThanOrEqual(72)
    expect(leftEdgePill?.y).toBeGreaterThanOrEqual(66)
    expect(rightEdgePill?.x).toBeLessThanOrEqual(328 - 71)
    expect(rightEdgePill?.y).toBeLessThanOrEqual(316)
    expect(leftEdgePill?.opacity).toBe('1')
    expect(backPill?.opacity).toBe('0.45')
  })

  it('expands topInset when the HUD wraps onto two lines on narrow viewports', () => {
    const placed = resolveSingularityPillLayout({
      stageWidth: 290,
      stageHeight: 340,
      hudHeight: 60,
      pills: [{ index: 0, rawX: 145, rawY: 20, z: 0.92, width: 110, height: 24 }],
    })

    expect(placed[0]?.y).toBe(88)
  })

  it('separates colliding pills vertically without breaching top HUD or bottom stage bounds', () => {
    const topCluster = resolveSingularityPillLayout({
      stageWidth: 328,
      stageHeight: 340,
      hudHeight: 28,
      pills: [
        { index: 0, rawX: 164, rawY: 40, z: 0.91, width: 112, height: 24 },
        { index: 1, rawX: 170, rawY: 44, z: 0.93, width: 112, height: 24 },
        { index: 2, rawX: 160, rawY: 50, z: 0.94, width: 112, height: 24 },
      ],
    })

    const sortedTop = [...topCluster].sort((a, b) => a.y - b.y)
    expect(sortedTop[0]?.y).toBeGreaterThanOrEqual(66)
    expect((sortedTop[1]?.y ?? 0) - (sortedTop[0]?.y ?? 0)).toBeGreaterThanOrEqual(30)
    expect((sortedTop[2]?.y ?? 0) - (sortedTop[1]?.y ?? 0)).toBeGreaterThanOrEqual(30)

    const bottomCluster = resolveSingularityPillLayout({
      stageWidth: 460,
      stageHeight: 340,
      hudHeight: 28,
      pills: [
        { index: 0, rawX: 230, rawY: 312, z: 0.92, width: 114, height: 24 },
        { index: 1, rawX: 235, rawY: 318, z: 0.94, width: 114, height: 24 },
        { index: 2, rawX: 226, rawY: 325, z: 0.95, width: 114, height: 24 },
      ],
    })

    const sortedBottom = [...bottomCluster].sort((a, b) => a.y - b.y)
    expect(sortedBottom[2]?.y).toBeLessThanOrEqual(316)
    expect((sortedBottom[1]?.y ?? 0) - (sortedBottom[0]?.y ?? 0)).toBeGreaterThanOrEqual(30)
    expect((sortedBottom[2]?.y ?? 0) - (sortedBottom[1]?.y ?? 0)).toBeGreaterThanOrEqual(30)
  })
})
