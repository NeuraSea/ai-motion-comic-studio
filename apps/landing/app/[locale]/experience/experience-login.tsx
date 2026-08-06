'use client'

import { ArrowLeft, ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { FormEvent, useState } from 'react'

import { landingUrl } from '../../../lib/urls'

export function ExperienceLogin({ locale }: { locale: 'zh' | 'en' }) {
  const zh = locale === 'zh'
  const [username, setUsername] = useState('demo@neurasea.ai')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/experience/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) {
        setError(response.status === 429
          ? (zh ? '尝试次数过多，请稍后再试。' : 'Too many attempts. Please try again later.')
          : (zh ? '账号或密码不正确。' : 'Incorrect account or password.'))
        return
      }
      window.location.assign('/studio/?stage=script')
    } catch {
      setError(zh ? '体验服务暂时不可用。' : 'The demo service is temporarily unavailable.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-page__art"><div className="login-page__art-image" /><div className="login-page__quote"><span>MANJU / DEMO</span><blockquote>{zh ? '“每一个镜头，都有可以回到的版本。”' : '“Every shot has a version you can return to.”'}</blockquote></div></div>
      <section className="login-panel">
        <Link className="login-back" href={landingUrl(locale)}><ArrowLeft size={16} />{zh ? '返回首页' : 'Back home'}</Link>
        <div className="login-panel__inner">
          <div className="login-mark">漫</div>
          <p className="section-kicker">{zh ? '受控体验环境' : 'CONTROLLED DEMO ENVIRONMENT'}</p>
          <h1>{zh ? '进入漫剧工作台' : 'Enter Manju Studio'}</h1>
          <p className="login-panel__lead">{zh ? '使用 NeuraSea 提供的固定体验账号。你的操作发生在隔离副本中。' : 'Use the fixed demo account provided by NeuraSea. Your work stays inside an isolated copy.'}</p>
          <form onSubmit={submit}>
            <label>{zh ? '体验账号' : 'Demo account'}<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
            <label>{zh ? '密码' : 'Password'}<span className="password-field"><input autoComplete="current-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
            {error && <p className="login-error" role="alert">{error}</p>}
            <button className="button button--primary login-submit" disabled={busy} type="submit"><LockKeyhole size={17} />{busy ? (zh ? '正在验证…' : 'Signing in…') : (zh ? '进入体验工作台' : 'Enter demo studio')}<ArrowRight size={17} /></button>
          </form>
          <div className="login-safety"><ShieldCheck size={18} /><span><strong>{zh ? '演示安全边界' : 'Demo safety boundary'}</strong>{zh ? '数据与宿主项目隔离；真实 Provider 已启用，图片、语音和视频任务可能产生费用，请仅创建必要任务。' : 'Data is isolated from the host project. Real providers are enabled, so image, speech, and video jobs may incur charges—create only necessary tasks.'}</span></div>
        </div>
      </section>
    </main>
  )
}
