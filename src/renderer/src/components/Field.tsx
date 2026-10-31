import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

export function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="label-caps" title={hint}>
      {children}
    </span>
  )
}

interface SliderFieldProps {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  decimals?: number
  unit?: string
  onChange(v: number): void
  className?: string
}

export function SliderField({ label, hint, value, min, max, step, decimals = 2, unit, onChange, className }: SliderFieldProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)} title={hint}>
      <div className="flex items-baseline justify-between">
        <FieldLabel hint={hint}>{label}</FieldLabel>
        <span className="font-mono text-xs tabular-nums text-foreground/80">
          {value.toFixed(decimals)}
          {unit}
        </span>
      </div>
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={([v]) => onChange(v)} />
    </div>
  )
}

interface RangeFieldProps {
  label: string
  hint?: string
  value: [number, number]
  min: number
  max: number
  step: number
  onChange(v: [number, number]): void
}

export function RangeField({ label, hint, value, min, max, step, onChange }: RangeFieldProps) {
  return (
    <div className="flex flex-col gap-2" title={hint}>
      <div className="flex items-baseline justify-between">
        <FieldLabel hint={hint}>{label}</FieldLabel>
        <span className="font-mono text-xs tabular-nums text-foreground/80">
          {value[0].toFixed(2)} – {value[1].toFixed(2)}
        </span>
      </div>
      <Slider min={min} max={max} step={step} value={value} onValueChange={(v) => onChange([v[0], v[1]])} />
    </div>
  )
}
