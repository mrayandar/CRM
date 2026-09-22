import { redirect } from 'next/navigation'

/** Mirrors the old catch-all route: any unmatched path bounces to the dashboard. */
export default function NotFound() {
  redirect('/')
}
