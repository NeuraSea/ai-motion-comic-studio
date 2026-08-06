import Link from 'next/link'

export default function LocaleEntry() {
  return (
    <main className="locale-entry">
      <div className="locale-entry__mark">漫</div>
      <p>Manju Studio</p>
      <div className="locale-entry__actions">
        <Link href="/zh/">进入中文站</Link>
        <Link href="/en/">Continue in English</Link>
      </div>
    </main>
  )
}
