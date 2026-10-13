/// <reference types="vite/client" />
import type { CanvasApi } from '../../shared/types'

declare global {
  interface Window {
    canvas: CanvasApi
  }
}
