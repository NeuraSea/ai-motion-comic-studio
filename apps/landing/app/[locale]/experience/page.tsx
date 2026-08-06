import { notFound } from 'next/navigation'

import { isLocale, locales } from '../../../lib/content'
import { ExperienceLogin } from './experience-login'

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }))
}

export default async function ExperiencePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isLocale(locale)) notFound()
  return <ExperienceLogin locale={locale} />
}
