import type { Locale } from './content'

export const landingOrigin = process.env.NEXT_PUBLIC_MANJU_LANDING_ORIGIN || 'https://comic.nervafs.xyz'
export const consoleOrigin = process.env.NEXT_PUBLIC_MANJU_CONSOLE_ORIGIN || 'https://console.comic.nervafs.xyz'

export function landingUrl(locale: Locale): string {
  return `${landingOrigin}/${locale}/`
}

export function experienceUrl(locale: Locale): string {
  return `${consoleOrigin}/${locale}/experience/`
}
