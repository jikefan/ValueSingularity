import { useCallback, useSyncExternalStore } from 'react'

export type ThemeMode = 'dark' | 'light'
export type ToneMood = 'signal' | 'cobalt' | 'danger'

export const THEME_STORAGE_KEY = 'vs_theme'
export const DEFAULT_THEME: ThemeMode = 'dark'

const THEME_CHANGE_EVENT = 'vs-theme-change'
const THEME_ANIM_CLASS = 'theme-anim'
const THEME_ANIM_DURATION_MS = 320

let themeAnimTimer: number | undefined

function parseThemeMode(value: unknown): ThemeMode | null {
  if (value === 'dark' || value === 'light') {
    return value
  }
  return null
}

function getServerSnapshot(): ThemeMode {
  return DEFAULT_THEME
}

/** Reads persisted theme preference from localStorage, falling back to DEFAULT_THEME on invalid or inaccessible storage. */
export function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return DEFAULT_THEME
  }
  try {
    return parseThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY)) ?? DEFAULT_THEME
  } catch {
    // Private browsing or storage restrictions can throw on localStorage access.
    return DEFAULT_THEME
  }
}

/** Resolves active theme from DOM attribute first, then persisted storage, defaulting to dark. */
export function getResolvedTheme(): ThemeMode {
  if (typeof document !== 'undefined') {
    const domTheme = parseThemeMode(document.documentElement.dataset.theme)
    if (domTheme !== null) {
      return domTheme
    }
  }
  return readStoredTheme()
}

/** Applies theme to the document root, persists preference, and optionally animates the transition. */
export function applyTheme(theme: ThemeMode, options?: { animate?: boolean }): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement

    if (themeAnimTimer !== undefined && typeof window !== 'undefined') {
      window.clearTimeout(themeAnimTimer)
      themeAnimTimer = undefined
    }

    if (options?.animate && typeof window !== 'undefined') {
      root.classList.add(THEME_ANIM_CLASS)
      themeAnimTimer = window.setTimeout(() => {
        root.classList.remove(THEME_ANIM_CLASS)
        themeAnimTimer = undefined
      }, THEME_ANIM_DURATION_MS)
    } else {
      root.classList.remove(THEME_ANIM_CLASS)
    }

    root.dataset.theme = theme
  }

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Ignore storage quota or security restrictions so UI state still switches cleanly.
    }
    window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: theme }))
  }
}

/** Applies semantic tone mood to the document root. */
export function applyToneMood(tone: ToneMood): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.tone = tone
  }
}

/** Subscribes to theme changes from applyTheme events, cross-tab storage events, and direct data-theme mutations. */
export function subscribeThemeChange(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const handleThemeEvent = () => {
    listener()
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) {
      return
    }
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) {
      return
    }
    const next = readStoredTheme()
    if (typeof document !== 'undefined' && document.documentElement.dataset.theme !== next) {
      document.documentElement.dataset.theme = next
    }
    listener()
  }

  window.addEventListener(THEME_CHANGE_EVENT, handleThemeEvent)
  window.addEventListener('storage', handleStorage)

  let observer: MutationObserver | null = null
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          listener()
          return
        }
      }
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
  }

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, handleThemeEvent)
    window.removeEventListener('storage', handleStorage)
    observer?.disconnect()
  }
}

export type ThemeModeState = {
  theme: ThemeMode
  setTheme: (next: ThemeMode, options?: { animate?: boolean }) => void
  toggleTheme: () => void
}

/** React hook synchronizing with the active theme and providing imperative setters. */
export function useThemeMode(): ThemeModeState {
  const theme = useSyncExternalStore(subscribeThemeChange, getResolvedTheme, getServerSnapshot)

  const setTheme = useCallback((next: ThemeMode, options?: { animate?: boolean }) => {
    applyTheme(next, options)
  }, [])

  const toggleTheme = useCallback(() => {
    const current = getResolvedTheme()
    applyTheme(current === 'dark' ? 'light' : 'dark', { animate: true })
  }, [])

  return { theme, setTheme, toggleTheme }
}
