import { create } from 'zustand'

export type View = 'generate' | 'library' | 'presets' | 'settings'

export const useNav = create<{ view: View; go(view: View): void }>((set) => ({
  view: 'generate',
  go: (view) => set({ view })
}))
