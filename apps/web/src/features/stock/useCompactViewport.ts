import { useEffect, useState } from 'react'

/** Tracks narrow mobile viewports (default <= 560px) so ECharts legends and y-axis labels never collide. */
export function useCompactViewport(maxWidth = 560): boolean {
  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= maxWidth : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const update = () => {
      setIsCompact(window.innerWidth <= maxWidth)
    }
    update()
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
    }
  }, [maxWidth])

  return isCompact
}
