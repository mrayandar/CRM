import { redirect } from 'next/navigation'
import { requirePaymentAccess } from '@lib/auth'
import { Payments } from '@/screens/Payments'

/**
 * Server-enforced, not just hidden from nav: a Member hitting /payments directly never reaches
 * the screen at all — requirePaymentAccess() throws for them and this redirects home before any
 * Payment data (which the layout's loadCrmData call already withheld from their client state
 * anyway) could even be requested.
 */
export default async function Page() {
  try {
    await requirePaymentAccess()
  } catch {
    redirect('/')
  }
  return <Payments />
}
