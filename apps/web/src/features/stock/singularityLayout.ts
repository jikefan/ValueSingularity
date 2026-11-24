export type RawProjectedPill = {
  index: number
  rawX: number
  rawY: number
  z: number
  width: number
  height: number
}

export type PlacedPill = {
  index: number
  x: number
  y: number
  opacity: string
}

export type PillLayoutInput = {
  pills: readonly RawProjectedPill[]
  stageWidth: number
  stageHeight: number
  hudHeight: number
}

const DEFAULT_PILL_WIDTH = 110
const DEFAULT_PILL_HEIGHT = 26
const MIN_TOP_INSET = 66
const HUD_GAP = 28
const BOTTOM_INSET = 24
const HORIZONTAL_COLLISION_SPAN = 118
const VERTICAL_COLLISION_GAP = 30

type LayoutNode = {
  index: number
  x: number
  y: number
  z: number
  pillW: number
  pillH: number
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function getCollisionThresholds(
  a: LayoutNode,
  b: LayoutNode,
): { overlapX: number; minYGap: number } {
  return {
    overlapX: Math.max(HORIZONTAL_COLLISION_SPAN, (a.pillW + b.pillW) / 2 + 8),
    minYGap: Math.max(VERTICAL_COLLISION_GAP, (a.pillH + b.pillH) / 2 + 6),
  }
}

/** Clamps 3D projected pill coordinates into safe stage bounds and resolves vertical collisions. */
export function resolveSingularityPillLayout({
  pills,
  stageWidth,
  stageHeight,
  hudHeight,
}: PillLayoutInput): PlacedPill[] {
  if (pills.length === 0) {
    return []
  }

  const topInset = Math.max(MIN_TOP_INSET, hudHeight + HUD_GAP)
  const minY = Math.min(stageHeight / 2, topInset)
  const maxY = Math.max(minY, stageHeight - BOTTOM_INSET)

  const nodes: LayoutNode[] = pills.map((pill) => {
    const pillW = pill.width > 0 ? pill.width : DEFAULT_PILL_WIDTH
    const pillH = pill.height > 0 ? pill.height : DEFAULT_PILL_HEIGHT
    const halfW = Math.max(58, pillW / 2 + 12)
    const minX = Math.min(stageWidth / 2, halfW)
    const maxX = Math.max(minX, stageWidth - halfW)
    const safeX = Number.isFinite(pill.rawX) ? pill.rawX : stageWidth / 2
    const safeY = Number.isFinite(pill.rawY) ? pill.rawY : stageHeight / 2
    return {
      index: pill.index,
      x: clampValue(safeX, minX, maxX),
      y: clampValue(safeY, minY, maxY),
      z: pill.z,
      pillW,
      pillH,
    }
  })

  nodes.sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index)

  for (let i = 1; i < nodes.length; i++) {
    const curr = nodes[i]
    if (!curr) continue
    const placed = nodes.slice(0, i).sort((a, b) => a.y - b.y)
    for (const prev of placed) {
      const { overlapX, minYGap } = getCollisionThresholds(curr, prev)
      if (Math.abs(curr.x - prev.x) < overlapX && Math.abs(curr.y - prev.y) < minYGap) {
        curr.y = prev.y + minYGap
      }
    }
    curr.y = clampValue(curr.y, minY, maxY)
  }

  nodes.sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index)

  for (let i = nodes.length - 2; i >= 0; i--) {
    const curr = nodes[i]
    if (!curr) continue
    const below = nodes.slice(i + 1).sort((a, b) => b.y - a.y)
    for (const next of below) {
      const { overlapX, minYGap } = getCollisionThresholds(curr, next)
      if (Math.abs(curr.x - next.x) < overlapX && Math.abs(curr.y - next.y) < minYGap) {
        curr.y = next.y - minYGap
      }
    }
    curr.y = clampValue(curr.y, minY, maxY)
  }

  const placedByIndex = new Map<number, PlacedPill>()
  for (const node of nodes) {
    placedByIndex.set(node.index, {
      index: node.index,
      x: node.x,
      y: node.y,
      opacity: node.z < 1 ? '1' : '0.45',
    })
  }

  return pills.map((pill) => {
    const resolved = placedByIndex.get(pill.index)
    if (resolved) {
      return resolved
    }
    return {
      index: pill.index,
      x: pill.rawX,
      y: pill.rawY,
      opacity: pill.z < 1 ? '1' : '0.45',
    }
  })
}
