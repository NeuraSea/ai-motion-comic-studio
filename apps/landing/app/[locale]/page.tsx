import { ArrowRight, AudioLines, Check, Film, GitBranch, Layers3, Play, Sparkles } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { getContent, isLocale, locales } from '../../lib/content'
import { experienceUrl } from '../../lib/urls'

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }))
}

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: candidate } = await params
  if (!isLocale(candidate)) notFound()
  const copy = getContent(candidate)

  return (
    <main className="landing-shell">
      <section className="hero" id="product">
        <div className="hero__noise" />
        <div className="hero__glow" />
        <div className="hero__content">
          <p className="eyebrow"><Sparkles size={14} />{copy.hero.eyebrow}</p>
          <h1>{copy.hero.titleLead}<br /><em>{copy.hero.titleAccent}</em></h1>
          <p className="hero__description">{copy.hero.description}</p>
          <div className="hero__actions">
            <Link className="button button--primary" href={experienceUrl(candidate)}>{copy.hero.primary}<ArrowRight size={18} /></Link>
            <Link className="button button--ghost" href={`/${candidate}/#workflow`}><Play size={16} />{copy.hero.secondary}</Link>
          </div>
          <div className="hero__proof">
            {copy.hero.proof.map((item) => <span key={item}><Check size={13} />{item}</span>)}
          </div>
        </div>

        <div className="hero-frame" aria-label={copy.hero.frameTitle}>
          <div className="hero-frame__image" />
          <div className="hero-frame__top"><span>MANJU / 01</span><span>24 FPS</span></div>
          <div className="hero-frame__play"><Play fill="currentColor" size={22} /></div>
          <div className="hero-frame__caption">
            <div><strong>{copy.hero.frameTitle}</strong><span>{copy.hero.frameMeta}</span></div>
            <div className="waveform"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
          </div>
          <span className="orbit-chip orbit-chip--one"><AudioLines size={15} /> AUDIO FIRST</span>
          <span className="orbit-chip orbit-chip--two"><Layers3 size={15} /> ASSET r4</span>
        </div>
      </section>

      <section className="manifesto section-wrap">
        <p className="section-kicker">{copy.manifesto.kicker}</p>
        <div className="manifesto__grid">
          <h2>{copy.manifesto.title}</h2>
          <p>{copy.manifesto.body}</p>
        </div>
      </section>

      <section className="feature-grid section-wrap">
        {copy.features.map(([number, title, description], index) => (
          <article className={`feature-card feature-card--${index + 1}`} key={number}>
            <span>{number}</span>
            <div className="feature-card__icon">{index === 2 ? <AudioLines /> : index === 4 ? <Film /> : index === 5 ? <GitBranch /> : <Sparkles />}</div>
            <h3>{title}</h3>
            <p>{description}</p>
          </article>
        ))}
      </section>

      <section className="workflow section-wrap" id="workflow">
        <div className="workflow__heading">
          <p className="section-kicker">{copy.workflow.kicker}</p>
          <h2>{copy.workflow.title}</h2>
        </div>
        <div className="workflow__rail">
          {copy.workflow.steps.map(([number, title, description]) => (
            <article key={number}>
              <span className="workflow__number">{number}</span>
              <div><h3>{title}</h3><p>{description}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section className="trust section-wrap" id="architecture">
        <div className="trust__copy"><p className="section-kicker">PRODUCTION AUTHORITY</p><h2>{copy.trust.title}</h2><p>{copy.trust.body}</p></div>
        <div className="trust__stats">
          {copy.trust.stats.map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
        </div>
      </section>

      <section className="final-cta section-wrap">
        <div className="final-cta__flare" />
        <p className="section-kicker">{copy.cta.eyebrow}</p>
        <h2>{copy.cta.title}</h2>
        <Link className="button button--primary" href={experienceUrl(candidate)}>{copy.cta.button}<ArrowRight size={18} /></Link>
        <small>{copy.cta.note}</small>
      </section>

      <footer className="landing-footer section-wrap"><span>{copy.footer}</span><span>© 2026</span></footer>
    </main>
  )
}
