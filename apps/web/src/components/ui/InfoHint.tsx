import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { GLOSSARY, type GlossaryEntry, type GlossaryKey } from '../../lib/glossary'

export type CustomGlossaryEntry = Omit<GlossaryEntry, 'label'> & { label?: string }

export type InfoHintProps =
  | {
      term: GlossaryKey
      title?: string
      entry?: CustomGlossaryEntry
      size?: 'sm' | 'md'
      className?: string
    }
  | {
      term?: GlossaryKey
      title?: string
      entry: CustomGlossaryEntry
      size?: 'sm' | 'md'
      className?: string
    }

type PopoverCoords = {
  left: number
  top: number
  placement: 'top' | 'bottom'
}

const CLOSE_GRACE_MS = 120
const VIEWPORT_MARGIN_PX = 12
const POPOVER_GAP_PX = 8
const FLIP_BELOW_THRESHOLD_PX = 160
const DEFAULT_POPOVER_WIDTH_PX = 320
const DEFAULT_POPOVER_HEIGHT_PX = 150

function resolveEntry(props: InfoHintProps): GlossaryEntry {
  const base: GlossaryEntry | undefined = props.term ? GLOSSARY[props.term] : undefined
  if (props.entry) {
    return {
      label: props.title ?? props.entry.label ?? base?.label ?? '指标说明',
      plain: props.entry.plain ?? base?.plain,
      summary: props.entry.summary,
      formula: props.entry.formula,
      reading: props.entry.reading,
    }
  }
  if (base) {
    return props.title ? { ...base, label: props.title } : base
  }
  return {
    label: props.title ?? '指标说明',
    summary: '',
  }
}

export function InfoHint(props: InfoHintProps) {
  const { size = 'sm', className } = props
  const resolved = resolveEntry(props)
  const popoverId = useId()

  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | undefined>(undefined)
  const pointerDownRef = useRef(false)
  const isHoveringTriggerRef = useRef(false)
  const isHoveringPopoverRef = useRef(false)

  const [isOpen, setIsOpen] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [coords, setCoords] = useState<PopoverCoords>({
    left: VIEWPORT_MARGIN_PX,
    top: VIEWPORT_MARGIN_PX,
    placement: 'top',
  })

  const cancelCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== undefined && typeof window !== 'undefined') {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = undefined
    }
  }, [])

  const scheduleClose = useCallback(() => {
    cancelCloseTimer()
    if (typeof window === 'undefined') {
      return
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined
      if (!isHoveringTriggerRef.current && !isHoveringPopoverRef.current) {
        setIsOpen(false)
      }
    }, CLOSE_GRACE_MS)
  }, [cancelCloseTimer])

  const updatePosition = useCallback(() => {
    const buttonEl = buttonRef.current
    if (!buttonEl || typeof window === 'undefined') {
      return
    }
    const triggerRect = buttonEl.getBoundingClientRect()
    const popoverRect = popoverRef.current?.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    const maxPopoverWidth = Math.max(120, viewportWidth - VIEWPORT_MARGIN_PX * 2)
    const width =
      popoverRect && popoverRect.width > 0
        ? popoverRect.width
        : Math.min(DEFAULT_POPOVER_WIDTH_PX, maxPopoverWidth)
    const height =
      popoverRect && popoverRect.height > 0 ? popoverRect.height : DEFAULT_POPOVER_HEIGHT_PX

    const desiredLeft = triggerRect.left + triggerRect.width / 2 - width / 2
    const maxLeft = Math.max(VIEWPORT_MARGIN_PX, viewportWidth - width - VIEWPORT_MARGIN_PX)
    const left = Math.min(Math.max(VIEWPORT_MARGIN_PX, desiredLeft), maxLeft)

    const requiredTopSpace = Math.max(
      FLIP_BELOW_THRESHOLD_PX,
      height + POPOVER_GAP_PX + VIEWPORT_MARGIN_PX,
    )
    const placeBelow =
      triggerRect.top < requiredTopSpace && viewportHeight - triggerRect.bottom > triggerRect.top
    const desiredTop = placeBelow
      ? triggerRect.bottom + POPOVER_GAP_PX
      : triggerRect.top - height - POPOVER_GAP_PX
    const maxTop = Math.max(VIEWPORT_MARGIN_PX, viewportHeight - height - VIEWPORT_MARGIN_PX)
    const top = Math.min(Math.max(VIEWPORT_MARGIN_PX, desiredTop), maxTop)

    setCoords({
      left: Math.round(left),
      top: Math.round(top),
      placement: placeBelow ? 'bottom' : 'top',
    })
  }, [])

  useEffect(() => {
    return () => {
      cancelCloseTimer()
    }
  }, [cancelCloseTimer])

  useLayoutEffect(() => {
    if (!isOpen || typeof window === 'undefined') {
      return
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [isOpen, updatePosition])

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') {
      return
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        cancelCloseTimer()
        setIsPinned(false)
        setIsOpen(false)
      }
    }
    function handleOutsidePointerDown(event: Event) {
      if (!(event.target instanceof Node)) {
        return
      }
      if (buttonRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) {
        return
      }
      cancelCloseTimer()
      setIsPinned(false)
      setIsOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handleOutsidePointerDown)
    document.addEventListener('mousedown', handleOutsidePointerDown)
    document.addEventListener('touchstart', handleOutsidePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handleOutsidePointerDown)
      document.removeEventListener('mousedown', handleOutsidePointerDown)
      document.removeEventListener('touchstart', handleOutsidePointerDown)
    }
  }, [cancelCloseTimer, isOpen])

  function handleTriggerClick(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    pointerDownRef.current = false
    cancelCloseTimer()
    if (isPinned) {
      setIsPinned(false)
      setIsOpen(false)
      return
    }
    setIsPinned(true)
    setIsOpen(true)
  }

  const triggerClass = ['info-hint-btn', size === 'md' ? 'info-hint-btn-md' : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={triggerClass}
        aria-label={`解释：${resolved.label}`}
        aria-expanded={isOpen}
        aria-describedby={isOpen ? popoverId : undefined}
        onPointerDown={() => {
          pointerDownRef.current = true
        }}
        onMouseDown={() => {
          pointerDownRef.current = true
        }}
        onMouseEnter={() => {
          isHoveringTriggerRef.current = true
          cancelCloseTimer()
          setIsOpen(true)
        }}
        onMouseLeave={() => {
          isHoveringTriggerRef.current = false
          if (!isPinned) {
            scheduleClose()
          }
        }}
        onFocus={() => {
          if (pointerDownRef.current) {
            pointerDownRef.current = false
            return
          }
          cancelCloseTimer()
          setIsOpen(true)
        }}
        onBlur={() => {
          if (!isPinned && !isHoveringTriggerRef.current && !isHoveringPopoverRef.current) {
            cancelCloseTimer()
            setIsOpen(false)
          }
        }}
        onClick={handleTriggerClick}
      >
        ?
      </button>

      {isOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popoverRef}
              id={popoverId}
              role="tooltip"
              data-placement={coords.placement}
              className="info-hint-popover"
              style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
              onMouseEnter={() => {
                isHoveringPopoverRef.current = true
                cancelCloseTimer()
              }}
              onMouseLeave={() => {
                isHoveringPopoverRef.current = false
                if (!isPinned) {
                  scheduleClose()
                }
              }}
            >
              <div className="info-hint-title">{resolved.label}</div>
              {resolved.plain?.trim() ? (
                <p className="info-hint-plain">
                  <strong>大白话：</strong>
                  {resolved.plain}
                </p>
              ) : null}
              <p className="info-hint-summary">{resolved.summary}</p>
              {resolved.formula ? (
                <div className="info-hint-section">
                  <span className="info-hint-kicker">计算口径</span>
                  <span className="info-hint-detail">{resolved.formula}</span>
                </div>
              ) : null}
              {resolved.reading ? (
                <div className="info-hint-section">
                  <span className="info-hint-kicker">怎么看</span>
                  <span className="info-hint-detail">{resolved.reading}</span>
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

export function GlossaryLabel({
  label,
  term,
  size = 'sm',
  className,
}: {
  label: ReactNode
  term: GlossaryKey
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <span className={className ? `label-with-hint ${className}` : 'label-with-hint'}>
      <span>{label}</span>
      <InfoHint term={term} size={size} />
    </span>
  )
}
