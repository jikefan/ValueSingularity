import { useCallback, useEffect, useState } from 'react'

export function useCooldown(initialSeconds = 0) {
  const [secondsLeft, setSecondsLeft] = useState(Math.max(0, Math.ceil(initialSeconds)))
  const isActive = secondsLeft > 0

  useEffect(() => {
    if (!isActive) {
      return
    }
    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => (prev <= 1 ? 0 : prev - 1))
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [isActive])

  const start = useCallback((seconds: number) => {
    setSecondsLeft(Math.max(0, Math.ceil(seconds)))
  }, [])

  const reset = useCallback(() => {
    setSecondsLeft(0)
  }, [])

  return { secondsLeft, start, reset }
}
