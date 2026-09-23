import { Suspense } from 'react'
import { Contacts } from '@/screens/Contacts'

export default function Page() {
  return (
    <Suspense>
      <Contacts />
    </Suspense>
  )
}
