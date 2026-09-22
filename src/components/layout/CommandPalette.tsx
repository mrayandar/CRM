'use client'

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@/lib/router-compat'
import {
  ArrowRight,
  BarChart3,
  CheckSquare,
  Columns3,
  CornerDownLeft,
  LayoutDashboard,
  Search,
  Settings,
  UserPlus,
  Users,
} from 'lucide-react'
import { cn, currencyCompact } from '@/lib/utils'
import { useCrm } from '@/store/crm'
import { DEAL_STAGE_LABEL, LEAD_STATUS_LABEL } from '@/data/types'

interface PaletteApi {
  open: () => void
}

const PaletteContext = createContext<PaletteApi>({ open: () => {} })

export const useCommandPalette = () => useContext(PaletteContext)

interface Row {
  id: string
  title: string
  meta: string
  group: string
  to: string
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const navigate = useNavigate()
  const { leads, contacts, deals } = useCrm()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
        setQuery('')
        setCursor(0)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const rows = useMemo<Row[]>(() => {
    const navRows: Row[] = [
      { id: 'n1', title: 'Dashboard', meta: 'Go to', group: 'Navigate', to: '/' },
      { id: 'n2', title: 'Leads', meta: 'Go to', group: 'Navigate', to: '/leads' },
      { id: 'n3', title: 'Contacts', meta: 'Go to', group: 'Navigate', to: '/contacts' },
      { id: 'n4', title: 'Pipeline', meta: 'Go to', group: 'Navigate', to: '/pipeline' },
      { id: 'n5', title: 'Tasks', meta: 'Go to', group: 'Navigate', to: '/tasks' },
      { id: 'n6', title: 'Reports', meta: 'Go to', group: 'Navigate', to: '/reports' },
      { id: 'n7', title: 'Settings', meta: 'Go to', group: 'Navigate', to: '/settings' },
    ]

    const leadRows: Row[] = leads.map((l) => ({
      id: l.id,
      title: l.name,
      meta: `${l.company} · ${LEAD_STATUS_LABEL[l.status]}`,
      group: 'Leads',
      to: `/leads/${l.id}`,
    }))

    const contactRows: Row[] = contacts.map((c) => ({
      id: c.id,
      title: c.name,
      meta: `${c.company} · ${c.title}`,
      group: 'Contacts',
      to: `/contacts/${c.id}`,
    }))

    const dealRows: Row[] = deals.map((d) => ({
      id: d.id,
      title: d.name,
      meta: `${currencyCompact(d.value)} · ${DEAL_STAGE_LABEL[d.stage]}`,
      group: 'Deals',
      to: '/pipeline',
    }))

    const all = [...navRows, ...leadRows, ...contactRows, ...dealRows]
    const q = query.trim().toLowerCase()
    if (!q) return all.filter((r) => r.group === 'Navigate')
    return all
      .filter((r) => `${r.title} ${r.meta}`.toLowerCase().includes(q))
      .slice(0, 24)
  }, [query, leads, contacts, deals])

  const go = (row?: Row) => {
    if (!row) return
    navigate(row.to)
    setOpen(false)
  }

  const api = useMemo<PaletteApi>(
    () => ({
      open: () => {
        setOpen(true)
        setQuery('')
        setCursor(0)
      },
    }),
    [],
  )

  const grouped = rows.reduce<Record<string, Row[]>>((acc, row) => {
    ;(acc[row.group] ||= []).push(row)
    return acc
  }, {})

  const iconFor = (group: string, title: string) => {
    if (group === 'Navigate') {
      const map: Record<string, typeof Search> = {
        Dashboard: LayoutDashboard,
        Leads: UserPlus,
        Contacts: Users,
        Pipeline: Columns3,
        Tasks: CheckSquare,
        Reports: BarChart3,
        Settings: Settings,
      }
      const Icon = map[title] ?? ArrowRight
      return <Icon size={14} />
    }
    return <Search size={14} />
  }

  let flatIndex = -1

  return (
    <PaletteContext.Provider value={api}>
      {children}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-200 flex items-start justify-center p-4 pt-[12vh]">
            <div
              className="fixed inset-0 animate-fade-in bg-ink-900/25 backdrop-blur-[2px]"
              onClick={() => setOpen(false)}
            />
            <div className="relative z-10 w-full max-w-[560px] animate-pop-in overflow-hidden rounded-card border border-line bg-surface shadow-pop">
              <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
                <Search size={15} className="text-ink-400" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setCursor(0)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setCursor((c) => Math.min(c + 1, rows.length - 1))
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setCursor((c) => Math.max(c - 1, 0))
                    }
                    if (e.key === 'Enter') go(rows[cursor])
                  }}
                  placeholder="Search leads, contacts, deals…"
                  className="h-full flex-1 bg-transparent text-[14px] text-ink-900 placeholder:text-ink-400 focus:outline-none"
                />
                <kbd className="rounded-[4px] border border-line bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-ink-400">
                  ESC
                </kbd>
              </div>

              <div className="max-h-[380px] overflow-y-auto scrollbar-slim p-1.5">
                {rows.length === 0 && (
                  <p className="px-3 py-8 text-center text-[13px] text-ink-500">
                    No matches for “{query}”
                  </p>
                )}
                {Object.entries(grouped).map(([group, items]) => (
                  <div key={group} className="mb-1 last:mb-0">
                    <p className="px-2.5 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.07em] text-ink-400 uppercase">
                      {group}
                    </p>
                    {items.map((row) => {
                      flatIndex += 1
                      const active = flatIndex === cursor
                      return (
                        <button
                          key={row.id}
                          type="button"
                          onMouseEnter={() => setCursor(rows.indexOf(row))}
                          onClick={() => go(row)}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-left',
                            active ? 'bg-subtle' : 'hover:bg-subtler',
                          )}
                        >
                          <span className={cn(active ? 'text-brand-600' : 'text-ink-400')}>
                            {iconFor(group, row.title)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink-900">
                              {row.title}
                            </span>
                            <span className="block truncate text-[11.5px] text-ink-500">{row.meta}</span>
                          </span>
                          {active && <CornerDownLeft size={12} className="text-ink-400" />}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </PaletteContext.Provider>
  )
}
