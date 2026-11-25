import { useCallback, useSyncExternalStore } from 'react'

export type ViewMode = 'simple' | 'pro'

export const VIEW_MODE_STORAGE_KEY = 'vs_view_mode'
export const DEFAULT_VIEW_MODE: ViewMode = 'simple'

const VIEW_MODE_CHANGE_EVENT = 'vs-view-mode-change'

function parseViewMode(value: unknown): ViewMode | null {
  if (value === 'simple' || value === 'pro') {
    return value
  }
  return null
}

function getServerSnapshot(): ViewMode {
  return DEFAULT_VIEW_MODE
}

/** Reads persisted view mode preference from localStorage, falling back to DEFAULT_VIEW_MODE on invalid or inaccessible storage. */
export function getViewMode(): ViewMode {
  if (typeof window === 'undefined') {
    return DEFAULT_VIEW_MODE
  }
  try {
    return parseViewMode(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)) ?? DEFAULT_VIEW_MODE
  } catch {
    // Private browsing or storage restrictions can throw on localStorage access.
    return DEFAULT_VIEW_MODE
  }
}

/** Persists view mode preference to localStorage and notifies subscribers in the current tab. */
export function applyViewMode(next: ViewMode): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, next)
  } catch {
    // Ignore storage quota or security restrictions so event notifications still fire.
  }
  window.dispatchEvent(new CustomEvent<ViewMode>(VIEW_MODE_CHANGE_EVENT, { detail: next }))
}

/** Subscribes to view mode updates from applyViewMode events and cross-tab storage events. */
export function subscribeViewModeChange(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const handleViewModeEvent = () => {
    listener()
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) {
      return
    }
    if (event.key !== null && event.key !== VIEW_MODE_STORAGE_KEY) {
      return
    }
    listener()
  }

  window.addEventListener(VIEW_MODE_CHANGE_EVENT, handleViewModeEvent)
  window.addEventListener('storage', handleStorage)

  return () => {
    window.removeEventListener(VIEW_MODE_CHANGE_EVENT, handleViewModeEvent)
    window.removeEventListener('storage', handleStorage)
  }
}

export type ViewModeState = {
  viewMode: ViewMode
  setViewMode: (next: ViewMode) => void
  isSimple: boolean
  isPro: boolean
}

/** React hook synchronizing with the active view mode ('simple' | 'pro'). */
export function useViewMode(): ViewModeState {
  const viewMode = useSyncExternalStore(subscribeViewModeChange, getViewMode, getServerSnapshot)

  const setViewMode = useCallback((next: ViewMode) => {
    applyViewMode(next)
  }, [])

  return {
    viewMode,
    setViewMode,
    isSimple: viewMode === 'simple',
    isPro: viewMode === 'pro',
  }
}
