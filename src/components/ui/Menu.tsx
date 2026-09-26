'use client'

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Lightweight popover: trigger + anchored panel, closes on outside click or Escape. Opens below the
 * trigger; if it wouldn't fit there it opens above (e.g. the account menu at the bottom of the
 * sidebar); if it fits neither way it uses the roomier side and scrolls.
 */
export function Popover({
  trigger,
  children,
  align = 'start',
  width = 220,
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (props: { close: () => void }) => ReactNode
  align?: 'start' | 'end'
  width?: number
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ up: boolean; maxHeight?: number }>({ up: false })

  // Measured before paint, so the panel never flashes off-screen first.
  useLayoutEffect(() => {
    if (!open) {
      setPlace({ up: false })
      return
    }
    const panel = panelRef.current
    const trigger = ref.current?.getBoundingClientRect()
    if (!panel || !trigger) return
    const gap = 6
    const margin = 8
    const spaceBelow = window.innerHeight - trigger.bottom - gap - margin
    const spaceAbove = trigger.top - gap - margin
    if (panel.offsetHeight <= spaceBelow) return
    if (panel.offsetHeight <= spaceAbove) {
      setPlace({ up: true })
      return
    }
    const up = spaceAbove > spaceBelow
    setPlace({ up, maxHeight: Math.max(120, up ? spaceAbove : spaceBelow) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className={cn('relative', className)}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          ref={panelRef}
          style={{ width, maxHeight: place.maxHeight }}
          className={cn(
            'absolute z-50 animate-pop-in rounded-panel border border-line',
            'bg-surface p-1 shadow-pop',
            place.maxHeight !== undefined && 'overflow-y-auto',
            place.up ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  children,
  onClick,
  icon,
  selected,
  tone = 'default',
}: {
  children: ReactNode
  onClick?: () => void
  icon?: ReactNode
  selected?: boolean
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-[6px] px-2 py-[6px] text-left text-[13px]',
        'transition-colors duration-75',
        tone === 'danger'
          ? 'text-negative hover:bg-negative-soft'
          : 'text-ink-700 hover:bg-subtle hover:text-ink-900',
      )}
    >
      {icon && <span className="text-ink-400">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check size={13} className="text-brand-600" />}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.07em] text-ink-400 uppercase">
      {children}
    </p>
  )
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-line" />
}
