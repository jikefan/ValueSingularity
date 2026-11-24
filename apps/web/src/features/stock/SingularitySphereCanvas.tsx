import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { createChartTheme } from '../../lib/chartTheme'
import { useThemeMode } from '../../lib/theme'
import { resolveSingularityPillLayout } from './singularityLayout'

export type SingularityDimension = {
  key: string
  label: string
  score: number
}

export type SingularitySphereCanvasProps = {
  stockName: string
  totalScore: number
  dimensions: readonly SingularityDimension[]
  height?: number
  onUnsupported?: () => void
}

const SPOKE_DIRECTIONS: readonly [number, number, number][] = [
  [0, 0.88, 0.14],
  [0.92, 0.24, 0.26],
  [0.58, -0.58, 0.56],
  [-0.6, -0.56, 0.57],
  [-0.9, 0.26, -0.24],
]

const FALLBACK_AXIS_ANGLES_DEG = [-90, -18, 54, 126, 198] as const

function clampScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0
  }
  return Math.min(100, Math.max(0, score))
}

function detectWebGlSupport(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false
  }
  // Guard before canvas.getContext so jsdom environments skip unimplemented getContext stderr noise.
  if (
    typeof window.WebGLRenderingContext === 'undefined' &&
    typeof window.WebGL2RenderingContext === 'undefined'
  ) {
    return false
  }
  try {
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')
    return Boolean(gl)
  } catch {
    return false
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function StaticGeometricFallback({
  stockName,
  totalScore,
  dimensions,
  height,
}: Omit<SingularitySphereCanvasProps, 'onUnsupported'>) {
  const center = 140
  const maxRadius = 92
  const minRadius = 26

  const points = dimensions.slice(0, 5).map((dim, idx) => {
    const angleDeg = FALLBACK_AXIS_ANGLES_DEG[idx] ?? -90 + idx * 72
    const rad = (angleDeg * Math.PI) / 180
    const ratio = clampScore(dim.score) / 100
    const r = minRadius + ratio * (maxRadius - minRadius)
    return {
      ...dim,
      x: center + Math.cos(rad) * r,
      y: center + Math.sin(rad) * r,
      outerX: center + Math.cos(rad) * maxRadius,
      outerY: center + Math.sin(rad) * maxRadius,
    }
  })

  const polygonPoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  return (
    <div
      className="stage-well singularity-stage singularity-stage-fallback"
      style={{ height }}
      role="img"
      aria-label={`${stockName} 3D 价值奇点球（静态几何降级视图）`}
    >
      <div className="singularity-hud-top">
        <span className="hud-pill">
          <span className="live-beacon" />
          3D 价值奇点球 · {totalScore}/100
        </span>
        <span className="hud-pill">静态几何视图</span>
      </div>

      <svg
        className="singularity-fallback-svg"
        viewBox="0 0 280 280"
        width="240"
        height="240"
        aria-hidden="true"
      >
        <circle
          cx={center}
          cy={center}
          r={maxRadius}
          fill="none"
          stroke="var(--hair)"
          strokeDasharray="4 4"
        />
        <ellipse
          cx={center}
          cy={center}
          rx={maxRadius}
          ry={maxRadius * 0.42}
          fill="none"
          stroke="var(--hair)"
          transform={`rotate(-22 ${center} ${center})`}
        />
        <ellipse
          cx={center}
          cy={center}
          rx={maxRadius}
          ry={maxRadius * 0.42}
          fill="none"
          stroke="var(--hair)"
          transform={`rotate(24 ${center} ${center})`}
        />
        <circle
          cx={center}
          cy={center}
          r={maxRadius * 0.58}
          fill="none"
          stroke="var(--line-soft)"
        />
        {points.map((pt) => (
          <g key={pt.key}>
            <line
              x1={center}
              y1={center}
              x2={pt.outerX}
              y2={pt.outerY}
              stroke="var(--hair)"
              strokeWidth="1"
            />
            <line
              x1={center}
              y1={center}
              x2={pt.x}
              y2={pt.y}
              stroke="var(--signal)"
              strokeWidth="2"
            />
            <circle cx={pt.x} cy={pt.y} r="4.5" fill="var(--signal)" />
          </g>
        ))}
        {polygonPoints ? (
          <polygon
            points={polygonPoints}
            fill="var(--signal-soft)"
            stroke="var(--cobalt)"
            strokeWidth="1.5"
          />
        ) : null}
        <circle
          cx={center}
          cy={center}
          r={16 + (clampScore(totalScore) / 100) * 10}
          fill="var(--cobalt-soft)"
          stroke="var(--signal)"
          strokeWidth="1.5"
        />
      </svg>

      <div className="singularity-fallback-pills">
        {points.map((pt) => (
          <span key={pt.key} className="hud-pill singularity-pill-inline">
            <span>{pt.label}</span>
            <span className="tnum">{pt.score}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Interactive offline Three.js 3D 5-axis Value Singularity Sphere with safe WebGL fallback. */
export function SingularitySphereCanvas({
  stockName,
  totalScore,
  dimensions,
  height = 340,
  onUnsupported,
}: SingularitySphereCanvasProps) {
  const { theme } = useThemeMode()
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hudTopRef = useRef<HTMLDivElement>(null)
  const pillRefs = useRef<Array<HTMLSpanElement | null>>([])
  const onUnsupportedRef = useRef(onUnsupported)
  onUnsupportedRef.current = onUnsupported

  const [webglReady, setWebglReady] = useState<boolean>(() => detectWebGlSupport())
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => prefersReducedMotion())

  const dimsSlice = useMemo(() => dimensions.slice(0, 5), [dimensions])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleChange = () => setReducedMotion(mql.matches)
    handleChange()
    mql.addEventListener('change', handleChange)
    return () => {
      mql.removeEventListener('change', handleChange)
    }
  }, [])

  useEffect(() => {
    if (!webglReady) {
      onUnsupportedRef.current?.()
    }
  }, [webglReady])

  useEffect(() => {
    if (!webglReady) {
      return
    }

    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) {
      return
    }

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      })
    } catch {
      setWebglReady(false)
      return
    }

    const { colors } = createChartTheme(theme)
    const primaryColor = new THREE.Color(colors.singularityPrimary)
    const secondaryColor = new THREE.Color(colors.singularitySecondary)
    const glowColor = new THREE.Color(colors.singularityGlow)
    const axisColor = new THREE.Color(colors.axisLine)

    const scene = new THREE.Scene()
    const initialWidth = stage.clientWidth || 360
    const initialHeight = stage.clientHeight || height
    const camera = new THREE.PerspectiveCamera(38, initialWidth / initialHeight, 0.1, 100)
    camera.position.set(0, 0.08, 6.4)
    camera.lookAt(0, 0, 0)

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(initialWidth, initialHeight, false)

    const geometries: THREE.BufferGeometry[] = []
    const materials: THREE.Material[] = []

    const rootGroup = new THREE.Group()
    rootGroup.rotation.x = 0.18
    rootGroup.rotation.y = -0.35
    scene.add(rootGroup)

    const icoGeom = new THREE.IcosahedronGeometry(0.86, 1)
    const icoWireGeom = new THREE.WireframeGeometry(icoGeom)
    icoGeom.dispose()
    const icoMat = new THREE.LineBasicMaterial({
      color: secondaryColor,
      transparent: true,
      opacity: 0.34,
    })
    geometries.push(icoWireGeom)
    materials.push(icoMat)
    rootGroup.add(new THREE.LineSegments(icoWireGeom, icoMat))

    const coreRadius = 0.25 + (clampScore(totalScore) / 100) * 0.19
    const coreGeom = new THREE.SphereGeometry(coreRadius, 24, 24)
    const coreMat = new THREE.MeshBasicMaterial({
      color: glowColor,
      transparent: true,
      opacity: 0.36,
    })
    geometries.push(coreGeom)
    materials.push(coreMat)
    rootGroup.add(new THREE.Mesh(coreGeom, coreMat))

    const orbitAngles: readonly [number, number, number][] = [
      [Math.PI / 2, 0, 0],
      [Math.PI / 3, Math.PI / 4, 0],
      [-Math.PI / 3, -Math.PI / 5, 0],
    ]
    for (const [rx, ry, rz] of orbitAngles) {
      const orbitGeom = new THREE.TorusGeometry(1.42, 0.008, 8, 72)
      const orbitMat = new THREE.MeshBasicMaterial({
        color: axisColor,
        transparent: true,
        opacity: 0.55,
      })
      geometries.push(orbitGeom)
      materials.push(orbitMat)
      const orbitMesh = new THREE.Mesh(orbitGeom, orbitMat)
      orbitMesh.rotation.set(rx, ry, rz)
      rootGroup.add(orbitMesh)
    }

    const tipPositions: THREE.Vector3[] = []
    const labelAnchors: THREE.Vector3[] = []

    dimsSlice.forEach((dim, idx) => {
      const rawDir = SPOKE_DIRECTIONS[idx] ?? [0, 0.88, 0.14]
      const dir = new THREE.Vector3(rawDir[0], rawDir[1], rawDir[2]).normalize()
      const ratio = clampScore(dim.score) / 100
      const spokeLength = 0.42 + ratio * 0.94
      const tip = dir.clone().multiplyScalar(spokeLength)
      const outerTip = dir.clone().multiplyScalar(1.44)
      const anchorTip = dir.clone().multiplyScalar(Math.max(1.06, spokeLength + 0.24))

      tipPositions.push(tip)
      labelAnchors.push(anchorTip)

      const guideGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        outerTip,
      ])
      const guideMat = new THREE.LineBasicMaterial({
        color: axisColor,
        transparent: true,
        opacity: 0.45,
      })
      geometries.push(guideGeom)
      materials.push(guideMat)
      rootGroup.add(new THREE.Line(guideGeom, guideMat))

      const spokeGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), tip])
      const spokeMat = new THREE.LineBasicMaterial({
        color: dim.score >= 70 ? primaryColor : secondaryColor,
        transparent: true,
        opacity: 0.95,
      })
      geometries.push(spokeGeom)
      materials.push(spokeMat)
      rootGroup.add(new THREE.Line(spokeGeom, spokeMat))

      const nodeGeom = new THREE.SphereGeometry(0.072, 16, 16)
      const nodeMat = new THREE.MeshBasicMaterial({
        color: dim.score >= 70 ? primaryColor : secondaryColor,
      })
      geometries.push(nodeGeom)
      materials.push(nodeMat)
      const nodeMesh = new THREE.Mesh(nodeGeom, nodeMat)
      nodeMesh.position.copy(tip)
      rootGroup.add(nodeMesh)
    })

    if (tipPositions.length >= 3) {
      const hullGeom = new THREE.BufferGeometry().setFromPoints(tipPositions)
      const hullMat = new THREE.LineBasicMaterial({
        color: glowColor,
        transparent: true,
        opacity: 0.78,
      })
      geometries.push(hullGeom)
      materials.push(hullMat)
      rootGroup.add(new THREE.LineLoop(hullGeom, hullMat))
    }

    const projectedVec = new THREE.Vector3()
    const updatePillOverlays = () => {
      const w = stage.clientWidth || initialWidth
      const h = stage.clientHeight || initialHeight
      const hudRect = hudTopRef.current?.getBoundingClientRect()
      const hudHeight =
        hudRect && hudRect.height > 0 ? hudRect.height : hudTopRef.current?.offsetHeight || 28
      rootGroup.updateMatrixWorld(true)

      const rawPills = labelAnchors.flatMap((localAnchor, idx) => {
        const pill = pillRefs.current[idx]
        if (!pill) {
          return []
        }
        projectedVec.copy(localAnchor).applyMatrix4(rootGroup.matrixWorld).project(camera)
        return [
          {
            index: idx,
            rawX: (projectedVec.x * 0.5 + 0.5) * w,
            rawY: (-projectedVec.y * 0.5 + 0.5) * h,
            z: projectedVec.z,
            width: pill.offsetWidth,
            height: pill.offsetHeight,
          },
        ]
      })

      const placed = resolveSingularityPillLayout({
        pills: rawPills,
        stageWidth: w,
        stageHeight: h,
        hudHeight,
      })

      for (const pos of placed) {
        const pill = pillRefs.current[pos.index]
        if (!pill) continue
        pill.style.transform = `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, 0) translate(-50%, -50%)`
        pill.style.opacity = pos.opacity
      }
    }

    const renderScene = () => {
      renderer.render(scene, camera)
      updatePillOverlays()
    }

    let isDragging = false
    let lastX = 0
    let lastY = 0

    const handlePointerDown = (event: PointerEvent) => {
      isDragging = true
      lastX = event.clientX
      lastY = event.clientY
      if (typeof stage.setPointerCapture === 'function') {
        try {
          stage.setPointerCapture(event.pointerId)
        } catch {
          // Ignore synthetic pointer events in non-browser harnesses.
        }
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!isDragging) {
        return
      }
      const dx = event.clientX - lastX
      const dy = event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      rootGroup.rotation.y += dx * 0.0085
      rootGroup.rotation.x = Math.min(1.1, Math.max(-1.1, rootGroup.rotation.x + dy * 0.0065))
      if (reducedMotion) {
        renderScene()
      }
    }

    const stopDragging = (event: PointerEvent) => {
      if (!isDragging) {
        return
      }
      isDragging = false
      if (typeof stage.releasePointerCapture === 'function') {
        try {
          stage.releasePointerCapture(event.pointerId)
        } catch {
          // Ignore if capture was not acquired.
        }
      }
    }

    stage.addEventListener('pointerdown', handlePointerDown)
    stage.addEventListener('pointermove', handlePointerMove)
    stage.addEventListener('pointerup', stopDragging)
    stage.addEventListener('pointercancel', stopDragging)

    const resizeObserver = new ResizeObserver(() => {
      const nextW = stage.clientWidth || initialWidth
      const nextH = stage.clientHeight || initialHeight
      camera.aspect = nextW / nextH
      camera.updateProjectionMatrix()
      renderer.setSize(nextW, nextH, false)
      renderScene()
    })
    resizeObserver.observe(stage)

    renderScene()

    let rafId = 0
    if (!reducedMotion) {
      const tick = () => {
        if (!isDragging) {
          rootGroup.rotation.y += 0.0032
        }
        renderScene()
        rafId = window.requestAnimationFrame(tick)
      }
      rafId = window.requestAnimationFrame(tick)
    }

    return () => {
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId)
      }
      resizeObserver.disconnect()
      stage.removeEventListener('pointerdown', handlePointerDown)
      stage.removeEventListener('pointermove', handlePointerMove)
      stage.removeEventListener('pointerup', stopDragging)
      stage.removeEventListener('pointercancel', stopDragging)

      for (const geom of geometries) {
        geom.dispose()
      }
      for (const mat of materials) {
        mat.dispose()
      }
      renderer.dispose()
    }
  }, [height, reducedMotion, theme, totalScore, webglReady, dimsSlice])

  if (!webglReady) {
    return (
      <StaticGeometricFallback
        stockName={stockName}
        totalScore={totalScore}
        dimensions={dimsSlice}
        height={height}
      />
    )
  }

  return (
    <div
      ref={stageRef}
      className="stage-well singularity-stage"
      style={{ height }}
      role="img"
      aria-label={`${stockName} 3D 价值奇点球`}
    >
      <canvas ref={canvasRef} className="singularity-canvas" />

      <div ref={hudTopRef} className="singularity-hud-top">
        <span className="hud-pill">
          <span className="live-beacon" />
          3D 价值奇点球 · {totalScore}/100
        </span>
        <span className="hud-pill">{reducedMotion ? '静态减弱动态模式' : '拖拽旋转视角'}</span>
      </div>

      <div className="singularity-overlay-pills" aria-hidden="true">
        {dimsSlice.map((dim, idx) => (
          <span
            key={dim.key}
            ref={(el) => {
              pillRefs.current[idx] = el
            }}
            className="hud-pill singularity-pill-float"
          >
            <span>{dim.label}</span>
            <span className="tnum">{dim.score}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
