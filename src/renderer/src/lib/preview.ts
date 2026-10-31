/** One shared audition player for take cards and library rows. */
import { create } from 'zustand'
import type { SfxItem } from '@shared/ipc'
import { audioUrl } from './api'

interface PreviewStore {
  playingId: string | null
  progress: number
  toggle(item: SfxItem): void
  stop(): void
}

const audio = new Audio()
audio.crossOrigin = 'anonymous'

export const usePreview = create<PreviewStore>((set, get) => {
  audio.addEventListener('ended', () => set({ playingId: null, progress: 0 }))
  audio.addEventListener('timeupdate', () => set({ progress: audio.duration ? audio.currentTime / audio.duration : 0 }))
  return {
    playingId: null,
    progress: 0,
    toggle(item) {
      if (get().playingId === item.id) {
        get().stop()
        return
      }
      audio.src = audioUrl(item)
      void audio.play()
      set({ playingId: item.id, progress: 0 })
    },
    stop() {
      audio.pause()
      set({ playingId: null, progress: 0 })
    }
  }
})
