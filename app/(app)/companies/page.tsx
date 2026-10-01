import { Suspense } from 'react'
import { Companies } from '@/screens/Companies'

export default function Page() {
  return (
    <Suspense>
      <Companies />
    </Suspense>
  )
}
