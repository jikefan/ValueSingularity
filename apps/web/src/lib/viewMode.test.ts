import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VIEW_MODE,
  VIEW_MODE_STORAGE_KEY,
  applyViewMode,
  getViewMode,
  subscribeViewModeChange,
  useViewMode,
} from './viewMode'

function ViewModeProbe({ label }: { label: string }) {
  const { viewMode, setViewMode, isSimple, isPro } = useViewMode()
  return createElement(
    'button',
    {
      type: 'button',
      'data-simple': String(isSimple),
      'data-pro': String(isPro),
      onClick: () => setViewMode(viewMode === 'simple' ? 'pro' : 'simple'),
    },
    `${label}:${viewMode}`,
  )
}

describe('viewMode', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('defaults safely to simple when localStorage is empty or corrupt', () => {
    expect(DEFAULT_VIEW_MODE).toBe('simple')
    expect(getViewMode()).toBe('simple')

    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'invalid-mode')
    expect(getViewMode()).toBe('simple')
  })

  it('persists changes under vs_view_mode and syncs across hook consumers and storage events', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeViewModeChange(listener)

    render(
      createElement(
        'div',
        null,
        createElement(ViewModeProbe, { label: 'a' }),
        createElement(ViewModeProbe, { label: 'b' }),
      ),
    )

    const btnA = screen.getByRole('button', { name: /^a:/ })
    const btnB = screen.getByRole('button', { name: /^b:/ })
    expect(btnA).toHaveTextContent('a:simple')
    expect(btnA).toHaveAttribute('data-simple', 'true')
    expect(btnA).toHaveAttribute('data-pro', 'false')
    expect(btnB).toHaveTextContent('b:simple')

    fireEvent.click(btnA)
    expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('pro')
    expect(getViewMode()).toBe('pro')
    expect(btnA).toHaveTextContent('a:pro')
    expect(btnA).toHaveAttribute('data-simple', 'false')
    expect(btnA).toHaveAttribute('data-pro', 'true')
    expect(btnB).toHaveTextContent('b:pro')
    expect(listener).toHaveBeenCalledTimes(1)

    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'simple')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: VIEW_MODE_STORAGE_KEY,
          newValue: 'simple',
        }),
      )
    })
    expect(btnA).toHaveTextContent('a:simple')
    expect(btnB).toHaveTextContent('b:simple')

    // Unrelated storageArea (sessionStorage) or unrelated key must be ignored.
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'pro')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: VIEW_MODE_STORAGE_KEY,
          newValue: 'pro',
          storageArea: window.sessionStorage,
        }),
      )
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'other_key',
          newValue: 'pro',
        }),
      )
    })
    expect(btnA).toHaveTextContent('a:simple')

    unsubscribe()
  })

  it('does not throw when localStorage access is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(getViewMode()).toBe('simple')
    expect(() => applyViewMode('pro')).not.toThrow()
  })
})
