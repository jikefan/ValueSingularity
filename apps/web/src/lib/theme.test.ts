import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  applyToneMood,
  getResolvedTheme,
  readStoredTheme,
  subscribeThemeChange,
  useThemeMode,
} from './theme'

function ThemeProbe() {
  const { theme, toggleTheme } = useThemeMode()
  return createElement('button', { type: 'button', onClick: toggleTheme }, theme)
}

describe('theme runtime', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.tone
    document.documentElement.className = ''
    window.localStorage.clear()
  })

  it('defaults to dark when localStorage and DOM attribute are unset', () => {
    expect(DEFAULT_THEME).toBe('dark')
    expect(readStoredTheme()).toBe('dark')
    expect(getResolvedTheme()).toBe('dark')
  })

  it('applies light theme with transient theme-anim class and persists to localStorage', () => {
    vi.useFakeTimers()
    const eventSpy = vi.fn()
    window.addEventListener('vs-theme-change', eventSpy)

    applyTheme('light', { animate: true })

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(getResolvedTheme()).toBe('light')
    expect(document.documentElement.classList.contains('theme-anim')).toBe(true)
    expect(eventSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(500)
    expect(document.documentElement.classList.contains('theme-anim')).toBe(false)

    window.removeEventListener('vs-theme-change', eventSpy)
  })

  it('applies theme without theme-anim when animate is omitted', () => {
    applyTheme('light', { animate: true })
    expect(document.documentElement.classList.contains('theme-anim')).toBe(true)

    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('theme-anim')).toBe(false)
  })

  it('falls back to dark on corrupt or inaccessible localStorage', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'corrupt-theme')
    expect(readStoredTheme()).toBe('dark')
    expect(getResolvedTheme()).toBe('dark')

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(readStoredTheme()).toBe('dark')
    expect(() => applyTheme('light')).not.toThrow()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('notifies subscribers via MutationObserver, storage event, and useThemeMode toggle', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeThemeChange(listener)

    render(createElement(ThemeProbe))
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent('dark')

    fireEvent.click(button)
    expect(button).toHaveTextContent('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(listener).toHaveBeenCalled()

    act(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await waitFor(() => {
      expect(button).toHaveTextContent('dark')
    })

    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: THEME_STORAGE_KEY,
          newValue: 'light',
        }),
      )
    })
    expect(button).toHaveTextContent('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: THEME_STORAGE_KEY,
          newValue: 'dark',
          storageArea: window.sessionStorage,
        }),
      )
    })
    expect(button).toHaveTextContent('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    applyToneMood('cobalt')
    expect(document.documentElement.dataset.tone).toBe('cobalt')
    applyToneMood('signal')
    expect(document.documentElement.dataset.tone).toBe('signal')

    unsubscribe()
  })
})
