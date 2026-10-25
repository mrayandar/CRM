/**
 * Stage D: the one pure piece of the bell UI that doesn't need a DOM to test — which record type
 * routes where on click-through. The rest of the bell (NotificationsProvider, the Popover panel)
 * is React state/markup with no equivalent here; this repo's vitest setup runs in plain Node, no
 * jsdom — see src/store/livePoll.ts's own doc comment on the same constraint.
 */
import { describe, expect, it } from 'vitest'
import { notificationHref } from '@/lib/utils'
import type { NotificationItem } from '@/store/notifications'

const item = (subjectType: NotificationItem['subjectType'], subjectId: string | null): NotificationItem => ({
  id: 'n1', title: 'x', createdAt: new Date().toISOString(), readAt: null, subjectType, subjectId,
})

describe('notificationHref', () => {
  it('routes a lead notification to its detail page', () => {
    expect(notificationHref(item('lead', 'lead-1'))).toBe('/leads/lead-1')
  })
  it('routes a contact notification to its detail page', () => {
    expect(notificationHref(item('contact', 'contact-1'))).toBe('/contacts/contact-1')
  })
  it('routes a deal notification to the Pipeline board (no per-deal detail page)', () => {
    expect(notificationHref(item('deal', 'deal-1'))).toBe('/pipeline')
  })
  it('routes a task notification to the Tasks list (no per-task detail page)', () => {
    expect(notificationHref(item('task', 'task-1'))).toBe('/tasks')
  })
  it('returns null for a coalesced notification with no single subject', () => {
    expect(notificationHref(item(null, null))).toBeNull()
  })
  it('returns null for a lead/contact row missing its subjectId (defensive — should never happen)', () => {
    expect(notificationHref(item('lead', null))).toBeNull()
  })
})
