import { Waveform } from '@/components/Waveform'
import { PromptPanel } from '@/components/PromptPanel'
import { TakesRow } from '@/components/TakesRow'
import { ProcessBar } from '@/components/ProcessBar'

export function GenerateView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
      <div className="flex min-h-[190px] flex-1 flex-col">
        <Waveform />
      </div>
      <PromptPanel />
      <TakesRow />
      <ProcessBar />
    </div>
  )
}
