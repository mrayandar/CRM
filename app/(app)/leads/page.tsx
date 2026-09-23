import { Suspense } from 'react'
import { Leads } from '@/screens/Leads'

export default function Page() {
  return (
    <Suspense>
      <Leads />
    </Suspense>
  )
}
