#!/usr/bin/env node

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const landingRoot = resolve(process.env.MANJU_LANDING_ROOT || resolve(rootDir, 'apps/landing/out'))
const gatewayPort = Number.parseInt(process.env.MANJU_DEMO_GATEWAY_PORT || '4173', 10)
const studioPort = Number.parseInt(process.env.MANJU_DEMO_STUDIO_PORT || '5174', 10)
const username = process.env.MANJU_DEMO_USERNAME?.trim() || ''
const password = process.env.MANJU_DEMO_PASSWORD || ''
const sessionSecret = process.env.MANJU_DEMO_SESSION_SECRET || ''
const landingHostname = (process.env.MANJU_DEMO_LANDING_HOSTNAME || '').trim().toLowerCase()
const consoleHostname = (process.env.MANJU_DEMO_CONSOLE_HOSTNAME || '').trim().toLowerCase()
const consoleOrigin = consoleHostname ? `https://${consoleHostname}` : ''
const cookieName = 'manju_demo_session'
const sessionSeconds = 4 * 60 * 60

if (!existsSync(landingRoot)) throw new Error(`Landing build not found: ${landingRoot}`)
if (!username || password.length < 12 || sessionSecret.length < 32) {
  throw new Error('Demo gateway requires a username, a 12+ character password and a 32+ character session secret')
}
if (!Number.isInteger(gatewayPort) || !Number.isInteger(studioPort)) throw new Error('Invalid demo port')

function constantTimeTextEqual(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function signature(value) {
  return createHmac('sha256', sessionSecret).update(value).digest('base64url')
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({ username, expiresAt: Math.floor(Date.now() / 1000) + sessionSeconds })).toString('base64url')
  return `${payload}.${signature(payload)}`
}

function readCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').flatMap((part) => {
    const separator = part.indexOf('=')
    if (separator < 1) return []
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]]
  }))
}

function hasValidSession(request) {
  const token = readCookies(request)[cookieName]
  if (!token) return false
  const [payload, providedSignature, ...extra] = token.split('.')
  if (!payload || !providedSignature || extra.length > 0 || !constantTimeTextEqual(providedSignature, signature(payload))) return false
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return parsed.username === username
      && Number.isInteger(parsed.expiresAt)
      && parsed.expiresAt > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

function clientAddress(request) {
  const forwarded = request.headers['cf-connecting-ip'] || request.headers['x-forwarded-for']
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim() || request.socket.remoteAddress || 'unknown'
}

const attempts = new Map()
function loginRateLimited(request) {
  const now = Date.now()
  const key = clientAddress(request)
  const current = attempts.get(key)
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 })
    return false
  }
  current.count += 1
  return current.count > 10
}

function proxyToStudio(request, response, rewrittenPath) {
  const headers = { ...request.headers, host: `127.0.0.1:${studioPort}` }
  delete headers['cf-connecting-ip']
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: studioPort,
    method: request.method,
    path: rewrittenPath,
    headers,
  }, (upstreamResponse) => {
    response.status(upstreamResponse.statusCode || 502)
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined && name.toLowerCase() !== 'connection') response.setHeader(name, value)
    }
    upstreamResponse.pipe(response)
  })
  upstream.setTimeout(15 * 60_000, () => upstream.destroy(new Error('studio proxy timeout')))
  upstream.on('error', () => {
    if (!response.headersSent) response.status(502).json({ error: { code: 'DEMO_STUDIO_UNAVAILABLE', message: '体验工作台暂时不可用' } })
    else response.end()
  })
  request.pipe(upstream)
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)

function requestHostname(request) {
  return String(request.headers.host || request.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
}

// A single named tunnel terminates both public hostnames, but their product
// boundaries stay explicit: the apex is the public website and the console
// host owns authentication, API and studio traffic.
app.use((request, response, next) => {
  const hostname = requestHostname(request)
  const path = request.path
  if (landingHostname && hostname === landingHostname) {
    const consolePath = path === '/experience/session'
      || path === '/experience/logout'
      || path.startsWith('/studio')
      || path.startsWith('/api')
      || path.startsWith('/generated')
      || /^\/(zh|en)\/experience(?:\/|$)/.test(path)
    if (consolePath) {
      if ((request.method === 'GET' || request.method === 'HEAD') && consoleOrigin) {
        response.redirect(302, `${consoleOrigin}${request.originalUrl}`)
      } else {
        response.status(404).json({ error: { code: 'LANDING_ROUTE_NOT_FOUND', message: '该接口仅在体验控制台提供' } })
      }
      return
    }
  }
  if (consoleHostname && hostname === consoleHostname) {
    if (path === '/' || path === '/zh' || path === '/zh/' || path === '/en' || path === '/en/') {
      const locale = path.startsWith('/en') ? 'en' : 'zh'
      response.redirect(302, `/${locale}/experience/`)
      return
    }
  }
  next()
})

app.get('/healthz', (_request, response) => {
  response.setHeader('cache-control', 'no-store')
  response.json({
    status: 'ok',
    service: 'manju-demo-gateway',
    providerExecution: process.env.MANJU_DEMO_ALLOW_PROVIDER_EXECUTION === '1'
      ? 'enabled-with-locked-configuration'
      : 'disabled',
  })
})

app.get('/experience/session', (request, response) => {
  response.setHeader('cache-control', 'no-store')
  response.json({ authenticated: hasValidSession(request) })
})

app.post('/experience/session', express.json({ limit: '2kb', strict: true }), (request, response) => {
  response.setHeader('cache-control', 'no-store')
  if (loginRateLimited(request)) {
    response.status(429).json({ error: { code: 'LOGIN_RATE_LIMITED', message: 'Too many login attempts' } })
    return
  }
  const submittedUsername = typeof request.body?.username === 'string' ? request.body.username.trim() : ''
  const submittedPassword = typeof request.body?.password === 'string' ? request.body.password : ''
  if (!constantTimeTextEqual(submittedUsername, username) || !constantTimeTextEqual(submittedPassword, password)) {
    response.status(401).json({ error: { code: 'INVALID_DEMO_CREDENTIALS', message: 'Invalid demo credentials' } })
    return
  }
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const secure = forwardedProto === 'https' ? '; Secure' : ''
  response.setHeader('set-cookie', `${cookieName}=${encodeURIComponent(createSessionToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionSeconds}${secure}`)
  response.json({ authenticated: true, redirectTo: '/studio/?stage=script' })
})

app.post('/experience/logout', (request, response) => {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const secure = forwardedProto === 'https' ? '; Secure' : ''
  response.setHeader('set-cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`)
  response.status(204).end()
})

app.use(['/studio', '/studio/*splat', '/api', '/api/*splat', '/generated', '/generated/*splat'], (request, response, next) => {
  if (hasValidSession(request)) {
    next()
    return
  }
  if (request.originalUrl.startsWith('/studio')) {
    response.redirect(302, '/zh/experience/')
    return
  }
  response.status(401).json({ error: { code: 'DEMO_AUTH_REQUIRED', message: '请先登录体验账号' } })
})

app.use(['/studio', '/studio/*splat'], (request, response) => {
  const rewritten = request.originalUrl.replace(/^\/studio(?=\/|\?|$)/, '') || '/'
  proxyToStudio(request, response, rewritten.startsWith('?') ? `/${rewritten}` : rewritten)
})
app.use(['/api', '/api/*splat', '/generated', '/generated/*splat', '/assets', '/assets/*splat'], (request, response) => {
  proxyToStudio(request, response, request.originalUrl)
})

app.get('/', (_request, response) => response.redirect(302, '/zh/'))
app.use(express.static(landingRoot, {
  dotfiles: 'deny',
  extensions: ['html'],
  immutable: true,
  maxAge: '1h',
  redirect: true,
  setHeaders(response, filePath) {
    if (filePath.endsWith('.html')) response.setHeader('cache-control', 'no-store')
  },
}))
app.use((_request, response) => response.status(404).sendFile(resolve(landingRoot, '404.html')))

const server = createServer(app)
server.listen(gatewayPort, '127.0.0.1', () => {
  console.log(`Manju demo gateway: http://127.0.0.1:${gatewayPort}`)
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
