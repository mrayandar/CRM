import type { Metadata } from 'next'
import './globals.css'
import { CrmProvider } from '@/store/crm'
import { AppLayout } from '@/components/layout/AppLayout'

export const metadata: Metadata = {
  title: 'NexoCRM',
  description: 'Modern SaaS CRM — pipeline, leads, and contacts at a glance.',
  icons: { icon: '/favicon.svg' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CrmProvider>
          <AppLayout>{children}</AppLayout>
        </CrmProvider>
      </body>
    </html>
  )
}
