'use client'

import type { ReactNode } from 'react'
import { useNavigate } from '@/lib/router-compat'
import { ArrowLeft, Bell, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/Button'
import { useCommandPalette } from './CommandPalette'

export function PageShell({
  title,
  subtitle,
  eyebrow,
  actions,
  toolbar,
  back,
  children,
  contentClassName,
}: {
  title: ReactNode
  subtitle?: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  toolbar?: ReactNode
  back?: string
  children: ReactNode
  contentClassName?: string
}) {
  const navigate = useNavigate()
  const palette = useCommandPalette()

  return (
    <div className="flex h-dvh min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/85 px-5 backdrop-blur-md">
        {back && (
          <IconButton label="Back" onClick={() => navigate(back)} className="-ml-1.5">
            <ArrowLeft size={15} />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className="text-[11px] leading-3.5 font-medium tracking-[0.02em] text-ink-400">
              {eyebrow}
            </p>
          )}
          <h1 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.016em] text-ink-900">
            {title}
          </h1>
          {subtitle && <p className="truncate text-[12px] leading-4 text-ink-500">{subtitle}</p>}
        </div>

        <button
          type="button"
          onClick={palette.open}
          className="hidden h-8 w-[200px] items-center gap-2 rounded-control border border-line-strong bg-surface px-2.5 text-[12.5px] text-ink-400 transition-colors hover:border-[#cfcfd6] hover:text-ink-600 lg:flex"
        >
          <Search size={13} />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded-[4px] border border-line bg-subtle px-1 py-px font-sans text-[10px] font-medium text-ink-400">
            ⌘K
          </kbd>
        </button>

        <IconButton label="Notifications" className="relative">
          <Bell size={15} />
          <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand-600 ring-2 ring-surface" />
        </IconButton>

        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>

      {toolbar && (
        <div className="sticky top-14 z-20 flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface/85 px-5 py-2 backdrop-blur-md">
          {toolbar}
        </div>
      )}

      <main className={cn('min-h-0 flex-1 overflow-y-auto scrollbar-slim', contentClassName)}>
        {children}
      </main>
    </div>
  )
}
