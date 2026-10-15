import { useSyncExternalStore } from 'react'
import type { ITheme } from '@xterm/xterm'

const query = window.matchMedia('(prefers-color-scheme: dark)')

export function useColorScheme(): 'dark' | 'light' {
  return useSyncExternalStore(
    (cb) => {
      query.addEventListener('change', cb)
      return () => query.removeEventListener('change', cb)
    },
    () => (query.matches ? 'dark' : 'light')
  )
}

export const TERMINAL_FONT = '"anthropic-mono", "SF Mono", ui-monospace, Menlo, monospace'

// Built from the Claude desktop palette: warm neutrals with the clay accent as cursor.
export const terminalThemes: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#20201f',
    foreground: '#faf9f5',
    cursor: '#d97757',
    cursorAccent: '#20201f',
    selectionBackground: '#d9775740',
    black: '#30302e',
    red: '#e06c5f',
    green: '#8fbf6f',
    yellow: '#e2b55c',
    blue: '#6fa8dc',
    magenta: '#c49be0',
    cyan: '#6cc1b8',
    white: '#c2c0b6',
    brightBlack: '#73726c',
    brightRed: '#f08a7e',
    brightGreen: '#a6d38a',
    brightYellow: '#f0cc7e',
    brightBlue: '#8fc0ec',
    brightMagenta: '#d8b4f0',
    brightCyan: '#8fd6ce',
    brightWhite: '#faf9f5'
  },
  light: {
    background: '#ffffff',
    foreground: '#141413',
    cursor: '#c6613f',
    cursorAccent: '#ffffff',
    selectionBackground: '#d9775733',
    black: '#141413',
    red: '#c0392b',
    green: '#3d7a2a',
    yellow: '#9a6b00',
    blue: '#2a6cb0',
    magenta: '#8e44ad',
    cyan: '#1f7f78',
    white: '#73726c',
    brightBlack: '#9c9a92',
    brightRed: '#d9534f',
    brightGreen: '#4f9a38',
    brightYellow: '#b8860b',
    brightBlue: '#3b82c4',
    brightMagenta: '#a35bc4',
    brightCyan: '#2a9d94',
    brightWhite: '#3d3d3a'
  }
}
