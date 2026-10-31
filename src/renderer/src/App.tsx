import { useEffect } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TitleBar } from '@/components/TitleBar'
import { SetupScreen, Sidebar, StatusBar } from '@/components/Shell'
import { GenerateView } from '@/views/GenerateView'
import { LibraryView } from '@/views/LibraryView'
import { PresetsView } from '@/views/PresetsView'
import { SettingsView } from '@/views/SettingsView'
import { useEngine } from '@/store/engine'
import { useNav } from '@/store/nav'
import { useStudio } from '@/store/studio'
import { cn } from '@/lib/utils'

export default function App() {
  const phase = useEngine((s) => s.phase)
  const view = useNav((s) => s.view)

  useEffect(() => {
    void useEngine.getState().init()
    return useEngine.getState().onJob((job) => useStudio.getState().onJob(job))
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <TitleBar />
        {phase !== 'ready' ? (
          <SetupScreen />
        ) : (
          <div className="flex min-h-0 flex-1 gap-2.5 p-2.5">
            <Sidebar />
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Generate stays mounted so playback/waveform state survives tab switches. */}
              <div className={cn('flex min-h-0 flex-1 flex-col', view !== 'generate' && 'hidden')}>
                <GenerateView />
              </div>
              {view === 'library' && <LibraryView />}
              {view === 'presets' && <PresetsView />}
              {view === 'settings' && <SettingsView />}
            </main>
          </div>
        )}
        <StatusBar />
      </div>
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  )
}
