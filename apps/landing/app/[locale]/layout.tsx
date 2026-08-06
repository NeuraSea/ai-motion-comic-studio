import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { RootProvider } from 'fumadocs-ui/provider/next'
import { ArrowUpRight, BookOpen, Boxes, Clapperboard } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { getContent, isLocale, locales } from '../../lib/content'
import { experienceUrl } from '../../lib/urls'
import 'fumadocs-ui/style.css'
import '../landing.css'

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }))
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params
  const zh = locale === 'zh'
  return {
    title: zh ? '漫剧工坊 — AI 漫剧生产平台' : 'Manju Studio — AI Motion Comic Production',
    description: zh
      ? '从原著、角色资产和配音，到逐镜视频与 OpenCut 成片的一体化 AI 漫剧生产线。'
      : 'From story, characters and voice to shot-level video and an editable OpenCut master.',
  }
}

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale: candidate } = await params
  if (!isLocale(candidate)) notFound()
  const copy = getContent(candidate)
  const alternate = candidate === 'zh' ? 'en' : 'zh'

  return (
    <html lang={candidate === 'zh' ? 'zh-CN' : 'en'} suppressHydrationWarning>
      <body>
        <RootProvider search={{ enabled: false }} theme={{ defaultTheme: 'dark' }}>
          <HomeLayout
            nav={{
              title: (
                <span className="brand-lockup">
                  <span className="brand-lockup__mark">漫</span>
                  <span>MANJU <b>STUDIO</b></span>
                </span>
              ),
              url: `/${candidate}/`,
              transparentMode: 'top',
            }}
            links={[
              { text: copy.nav.product, url: `/${candidate}/#product`, icon: <Boxes size={16} /> },
              { text: copy.nav.workflow, url: `/${candidate}/#workflow`, icon: <Clapperboard size={16} /> },
              { text: copy.nav.architecture, url: `/${candidate}/#architecture`, icon: <BookOpen size={16} /> },
              { type: 'custom', on: 'nav', children: <Link className="nav-language" href={`/${alternate}/`}>{alternate === 'zh' ? '中' : 'EN'}</Link> },
              { type: 'custom', on: 'nav', children: <Link className="nav-demo" href={experienceUrl(candidate)}>{copy.nav.login}<ArrowUpRight size={15} /></Link> },
            ]}
            themeSwitch={{ enabled: false }}
            searchToggle={{ enabled: false }}
          >
            {children}
          </HomeLayout>
        </RootProvider>
      </body>
    </html>
  )
}
