'use server'

/**
 * Mark-read actions for the notification bell. Deliberately NOT routed through
 * revalidatePath — notifications aren't part of loadCrmData's SSR hydration (see
 * lib/data-loader.ts), they're polled client-side (GET /api/notifications, GET
 * /api/notifications/unread-count), so there's no SSR cache to invalidate here.
 */

import { requireAuth } from '@lib/auth'
import { markAllNotificationsRead as dbMarkAllNotificationsRead, markNotificationRead as dbMarkNotificationRead } from '@lib/data/notifications'

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
