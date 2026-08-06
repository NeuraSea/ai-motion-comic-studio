import type { Metadata } from 'next'
import { RootProvider } from 'fumadocs-ui/provider/next'
import type { ReactNode } from 'react'

import 'fumadocs-ui/style.css'
import '../landing.css'

export const metadata: Metadata = {
  title: 'Manju Studio — AI Motion Comic Production',
  description: 'From story to finished motion comic, one auditable production line.',
}

export default function EntryLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider search={{ enabled: false }} theme={{ defaultTheme: 'dark' }}>
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
