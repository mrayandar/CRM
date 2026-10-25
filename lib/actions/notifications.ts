'use server'

/**
 * Mark-read actions for the notification bell, and the Stage E preference toggle. The mark-read
 * actions deliberately skip revalidatePath — read/unread state isn't part of loadCrmData's SSR
 * hydration, it's polled client-side (GET /api/notifications, GET /api/notifications/unread-
 * count), so there's no SSR cache to invalidate for those. Preferences ARE part of loadCrmData
 * (lib/data-loader.ts's `notificationPreferences`), so that one DOES revalidate, same as every
 * other Settings toggle (updateProfileAction, updateOrgTimezoneAction, …).
 */

import { revalidatePath } from 'next/cache'
import { requireAuth } from '@lib/auth'
import {
  markAllNotificationsRead as dbMarkAllNotificationsRead,
  markNotificationRead as dbMarkNotificationRead,
  setNotificationPreference as dbSetNotificationPreference,
  NOTIFICATION_KINDS,
} from '@lib/data/notifications'
import type { NotificationKind } from '@prisma/client'

/** Scoped by id + orgId + recipientId inside dbMarkNotificationRead — a Member can only ever mark
 *  their OWN notification read, never anyone else's, regardless of what `id` the client sends. */
export async function markNotificationReadAction(id: string) {
  const { orgId, ownerId } = await requireAuth()
  await dbMarkNotificationRead(orgId, ownerId, id)
}

export async function markAllNotificationsReadAction() {
  const { orgId, ownerId } = await requireAuth()
  await dbMarkAllNotificationsRead(orgId, ownerId)
}

/** Always the CALLER's own preference — there is no "set someone else's" input here at all (no
 *  ownerId param to trust or validate), the same pattern updateProfileAction uses for the same
 *  reason. A Member and an Admin change their own identically; role plays no part in this. */
export async function updateNotificationPreferenceAction(input: { kind: NotificationKind; enabled: boolean }) {
  const { orgId, ownerId } = await requireAuth()
  if (!NOTIFICATION_KINDS.includes(input.kind)) throw new Error('Invalid notification kind')
  if (typeof input.enabled !== 'boolean') throw new Error('Invalid value')
  await dbSetNotificationPreference(orgId, ownerId, input.kind, input.enabled)
  revalidatePath('/', 'layout')
}
