'use client'

import type { ReactNode } from 'react'
import { useNavigate } from '@/lib/router-compat'
import { ArrowLeft, Bell, CheckCheck, Loader2, RotateCw, Search } from 'lucide-react'
import { cn, notificationHref, relativeTime } from '@/lib/utils'
import { IconButton } from '@/components/ui/Button'
import { Popover } from '@/components/ui/Menu'
import { useCommandPalette } from './CommandPalette'
import { useNotifications } from '@/store/notifications'

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

        <NotificationBell />

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

function NotificationBell() {
  const navigate = useNavigate()
  const { unreadCount, items, listLoading, listError, loadList, markRead, markAllRead } = useNotifications()

  return (
    <Popover
      align="end"
      width={340}
      trigger={({ toggle }) => (
        <span className="relative">
          <IconButton label="Notifications" onClick={() => { toggle(); loadList() }}>
            <Bell size={15} />
          </IconButton>
          {unreadCount > 0 && (
            <span className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-negative text-[9.5px] font-semibold text-white tabular">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </span>
      )}
    >
      {({ close }) => (
        <div className="flex max-h-[420px] flex-col">
          <div className="flex items-center justify-between px-2 py-1.5">
            <p className="text-[12.5px] font-semibold text-ink-800">Notifications</p>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="flex items-center gap-1 rounded-[6px] px-1.5 py-1 text-[11.5px] font-medium text-ink-500 transition-colors hover:bg-subtle hover:text-ink-900 disabled:pointer-events-none disabled:opacity-40"
            >
              <CheckCheck size={12} />
              Mark all read
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
            {listLoading && !items && (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={16} className="animate-spin text-ink-400" />
              </div>
            )}

            {listError && (
              <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
                <p className="text-[12.5px] text-ink-500">Couldn&apos;t load notifications.</p>
                <button
                  type="button"
                  onClick={loadList}
                  className="flex items-center gap-1 rounded-[6px] border border-line-strong px-2 py-1 text-[11.5px] font-medium text-ink-600 transition-colors hover:bg-subtle"
                >
                  <RotateCw size={11} />
                  Try again
                </button>
              </div>
            )}

            {!listLoading && !listError && items && items.length === 0 && (
              <p className="px-2 py-6 text-center text-[12.5px] text-ink-500">You&apos;re all caught up.</p>
            )}

            {items && items.length > 0 && (
              <ul>
                {items.map((item) => {
                  const href = notificationHref(item)
                  const unread = item.readAt === null
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          markRead(item.id)
                          close()
                          if (href) navigate(href)
                        }}
                        className={cn(
                          'flex w-full items-start gap-2 rounded-[7px] px-2 py-2 text-left transition-colors hover:bg-subtle',
                          unread && 'bg-brand-50/60',
                        )}
                      >
                        <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', unread ? 'bg-brand-600' : 'bg-transparent')} />
                        <span className="min-w-0 flex-1">
                          <span className={cn('block text-[12.5px] leading-4.5', unread ? 'font-medium text-ink-900' : 'text-ink-700')}>
                            {item.title}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-ink-400">{relativeTime(item.createdAt)}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Popover>
  )
}
