import { useState, useEffect } from 'react'

export type Theme = 'light' | 'dark' | 'system'

function applyTheme(theme: Theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem('anthrimon-theme') as Theme) ?? 'system'
  )

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem('anthrimon-theme', theme)

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => applyTheme('system')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [theme])

  const setTheme = (t: Theme) => {
    setThemeState(t)
  }

  return { theme, setTheme }
}

/** Apply theme immediately on page load (before React mounts) to prevent flash. */
export function initTheme() {
  const stored = (localStorage.getItem('anthrimon-theme') as Theme) ?? 'system'
  applyTheme(stored)
}
