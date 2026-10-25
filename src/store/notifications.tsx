'use client'

/**
 * Stage D: the notification bell's client-side state. Deliberately separate from CrmProvider
 * (src/store/crm.tsx) — notifications are an independent domain polled on their own schedule
 * (GET /api/notifications/unread-count every ~60s, its own startLivePoll instance, same
 * pause-when-hidden/refetch-on-focus behavior the main CRM poll already has), not part of
 * loadCrmData's SSR hydration. Still reuses CrmProvider's own `persist` for the optimistic-
 * update + rollback + failure-toast plumbing mark-read/mark-all-read need, rather than building a
 * second copy of it — see bulkReassignLeads' identical reuse for the same reason.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { startLivePoll } from '@/store/livePoll'
import { useCrm } from '@/store/crm'
import { markAllNotificationsReadAction, markNotificationReadAction } from '@lib/actions/notifications'

export interface NotificationItem {
  id: string
  title: string
  createdAt: string
  readAt: string | null
  subjectType: 'lead' | 'contact' | 'deal' | 'task' | null
  subjectId: string | null
}

interface NotificationsState {
  unreadCount: number
  /** null until the list has been fetched at least once (the panel hasn't been opened yet) —
   *  distinct from an empty array, which means "fetched, and there are none". */
  items: NotificationItem[] | null
  listLoading: boolean
  listError: boolean
  /** Fetches (or re-fetches) the newest-50 list — called when the bell panel opens. */
  loadList: () => void
  markRead: (id: string) => void
  markAllRead: () => void
}

const NotificationsContext = createContext<NotificationsState | null>(null)

export function useNotifications(): NotificationsState {
  const ctx = useContext(NotificationsContext)
  if (!ctx) throw new Error('useNotifications must be used within a NotificationsProvider')
  return ctx
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { persist } = useCrm()
  const [unreadCount, setUnreadCount] = useState(0)
  const [items, setItems] = useState<NotificationItem[] | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState(false)
  const disposedRef = useRef(false)

  const refreshUnreadCount = useCallback(async (): Promise<'applied' | 'discarded'> => {
    const response = await fetch('/api/notifications/unread-count', { cache: 'no-store' })
    if (!response.ok) throw new Error(`unread-count failed: ${response.status}`)
    const body: { count: number } = await response.json()
    if (disposedRef.current) return 'discarded'
    setUnreadCount(body.count)
    return 'applied'
  }, [])

  // Same poll/visibility/focus scheduling as CrmProvider's own refetch (src/store/livePoll.ts) —
  // its own instance, since this is a wholly separate fetch with no mutation-pending concept of
  // its own (isMutationPending always false: nothing in THIS domain needs to pause the poll).
  useEffect(() => {
    disposedRef.current = false
    void refreshUnreadCount().catch(() => {})
    const stop = startLivePoll({
      isMutationPending: () => false,
      refetch: refreshUnreadCount,
    })
    return () => {
      disposedRef.current = true
      stop()
    }
  }, [refreshUnreadCount])

  const loadList = useCallback(() => {
    setListLoading(true)
    setListError(false)
    fetch('/api/notifications', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`list failed: ${response.status}`)
        const body: { notifications: NotificationItem[] } = await response.json()
        if (disposedRef.current) return
        setItems(body.notifications)
      })
      .catch(() => {
        if (!disposedRef.current) setListError(true)
      })
      .finally(() => {
        if (!disposedRef.current) setListLoading(false)
      })
  }, [])

  const markRead = useCallback(
    (id: string) => {
      const prevItems = items
      const prevCount = unreadCount
      const wasUnread = items?.find((n) => n.id === id)?.readAt == null
      if (!wasUnread) return // already read — nothing to do, same no-op the server itself treats this as
      setItems((prev) => (prev ? prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) : prev))
      setUnreadCount((c) => Math.max(0, c - 1))
      persist(
        () => markNotificationReadAction(id),
        () => {
          setItems(prevItems)
          setUnreadCount(prevCount)
        },
        undefined,
        "Couldn't mark that as read, please try again.",
      )
    },
    [items, unreadCount, persist],
  )

  const markAllRead = useCallback(() => {
    if (unreadCount === 0) return
    const prevItems = items
    const prevCount = unreadCount
    const now = new Date().toISOString()
    setItems((prev) => (prev ? prev.map((n) => (n.readAt ? n : { ...n, readAt: now })) : prev))
    setUnreadCount(0)
    persist(
      () => markAllNotificationsReadAction(),
      () => {
        setItems(prevItems)
        setUnreadCount(prevCount)
      },
      undefined,
      "Couldn't mark all as read, please try again.",
    )
  }, [items, unreadCount, persist])

  const value: NotificationsState = { unreadCount, items, listLoading, listError, loadList, markRead, markAllRead }
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}
