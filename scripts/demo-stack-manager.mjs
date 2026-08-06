#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareDemoRuntime } from './prepare-demo-runtime.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = resolve(rootDir, 'runtime')
const statePath = resolve(runtimeDir, 'demo-stack.json')
const credentialsPath = resolve(runtimeDir, 'demo-credentials.json')
const appEntry = resolve(rootDir, 'dist-server/index.cjs')
const gatewayEntry = resolve(rootDir, 'scripts/demo-gateway.mjs')
const landingRoot = resolve(rootDir, 'apps/landing/out')
const demoDatabase = resolve(runtimeDir, 'demo/manju.sqlite')
const appPort = 5174
const gatewayPort = 4173
const command = process.argv.slice(2).find((value) => !value.startsWith('--')) || 'status'
const jsonOutput = process.argv.includes('--json')
const namedTunnelConfig = process.env.MANJU_DEMO_TUNNEL_CONFIG
  ? resolve(rootDir, process.env.MANJU_DEMO_TUNNEL_CONFIG)
  : null
const namedTunnelPublicUrl = process.env.MANJU_DEMO_PUBLIC_URL?.trim() || ''
const allowProviderExecution = process.env.MANJU_DEMO_ALLOW_PROVIDER_EXECUTION === '1'

function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }
function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function commandFor(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() } catch { return '' }
}
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}
function probe(port, path = '/healthz', timeoutMs = 1_200) {
  return new Promise((resolveProbe) => {
    const request = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (response) => {
      response.resume()
      resolveProbe(response.statusCode === 200)
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolveProbe(false))
  })
}
async function waitHealthy(port, path, pid) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await probe(port, path)) return
    if (!alive(pid)) throw new Error(`Demo process ${pid} exited; inspect runtime demo logs`)
    await sleep(200)
  }
  throw new Error(`Demo service on ${port} did not become healthy`)
}
function spawnDetached(entry, args, env, logName) {
  const logFd = openSync(resolve(runtimeDir, logName), 'a')
  const child = spawn(entry, args, { cwd: rootDir, detached: true, env: { ...process.env, ...env }, stdio: ['ignore', logFd, logFd] })
  closeSync(logFd)
  child.unref()
  return child.pid
}
function credentials() {
  const existing = readJson(credentialsPath)
  if (existing?.username === 'demo@neurasea.ai' && typeof existing.password === 'string' && existing.password.length >= 12 && typeof existing.sessionSecret === 'string') return existing
  const created = {
    username: 'demo@neurasea.ai',
    password: `Manju-${randomBytes(9).toString('base64url')}`,
    sessionSecret: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
  }
  atomicJson(credentialsPath, created)
  return created
}
function publicCredentials(value) { return { username: value.username, password: value.password } }
async function stopPid(pid, expected) {
  if (!Number.isInteger(pid) || !alive(pid)) return
  if (!commandFor(pid).includes(expected)) throw new Error(`Refusing to stop unexpected PID ${pid}`)
  process.kill(pid, 'SIGTERM')
  for (let index = 0; index < 50 && alive(pid); index += 1) await sleep(100)
  if (alive(pid)) process.kill(pid, 'SIGKILL')
}
async function stop() {
  const state = readJson(statePath)
  if (!state) return { action: 'not-running' }
  await stopPid(state.tunnelPid, 'cloudflared')
  await stopPid(state.gatewayPid, gatewayEntry)
  await stopPid(state.appPid, appEntry)
  rmSync(statePath, { force: true })
  return { action: 'stopped' }
}
async function status() {
  const state = readJson(statePath)
  const appHealthy = await probe(appPort, '/api/health')
  const gatewayHealthy = await probe(gatewayPort)
  return {
    action: 'status',
    running: Boolean(state && appHealthy && gatewayHealthy && alive(state.tunnelPid)),
    appHealthy,
    gatewayHealthy,
    tunnelAlive: Boolean(state && alive(state.tunnelPid)),
    tunnelUrl: state?.tunnelUrl || null,
    providerExecutionAllowed: Boolean(state?.providerExecutionAllowed),
    credentials: existsSync(credentialsPath) ? publicCredentials(readJson(credentialsPath)) : null,
    pids: state ? { app: state.appPid, gateway: state.gatewayPid, tunnel: state.tunnelPid } : null,
  }
}
async function readTunnelUrl(pid) {
  const logPath = resolve(runtimeDir, 'demo-tunnel.log')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!alive(pid)) throw new Error('Cloudflare Tunnel exited before publishing a URL')
    const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const matches = [...text.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)]
    if (matches.length > 0) return matches.at(-1)[0]
    await sleep(250)
  }
  throw new Error('Cloudflare Tunnel did not publish a URL within 30 seconds')
}
async function start() {
  const current = await status()
  if (current.running) return { ...current, action: 'already-running' }
  if (readJson(statePath)) await stop()
  if (!existsSync(appEntry)) throw new Error('Missing dist-server/index.cjs; run npm run build first')
  if (!existsSync(landingRoot)) throw new Error('Missing Fumadocs export; run npm run build:landing first')
  mkdirSync(runtimeDir, { recursive: true })
  if (!existsSync(demoDatabase) || process.env.MANJU_DEMO_REFRESH_RUNTIME === '1') {
    prepareDemoRuntime()
  }
  const account = credentials()
  const started = []
  try {
    const appPid = spawnDetached(process.execPath, [appEntry], {
      HOST: '127.0.0.1', PORT: String(appPort), SERVE_WEB: '1', MANJU_WEB_ROOT: resolve(rootDir, 'dist'),
      MANJU_RUNTIME_DIR: resolve(runtimeDir, 'demo'), MANJU_DEMO_MODE: '1',
      MANJU_DEMO_ALLOW_PROVIDER_EXECUTION: allowProviderExecution ? '1' : '0',
    }, 'demo-app.log')
    started.push([appPid, appEntry])
    await waitHealthy(appPort, '/api/health', appPid)

    const gatewayPid = spawnDetached(process.execPath, [gatewayEntry], {
      MANJU_DEMO_GATEWAY_PORT: String(gatewayPort), MANJU_DEMO_STUDIO_PORT: String(appPort), MANJU_LANDING_ROOT: landingRoot,
      MANJU_DEMO_USERNAME: account.username, MANJU_DEMO_PASSWORD: account.password, MANJU_DEMO_SESSION_SECRET: account.sessionSecret,
      MANJU_DEMO_ALLOW_PROVIDER_EXECUTION: allowProviderExecution ? '1' : '0',
      MANJU_DEMO_LANDING_HOSTNAME: process.env.MANJU_DEMO_LANDING_HOSTNAME || '',
      MANJU_DEMO_CONSOLE_HOSTNAME: process.env.MANJU_DEMO_CONSOLE_HOSTNAME || '',
    }, 'demo-gateway.log')
    started.push([gatewayPid, gatewayEntry])
    await waitHealthy(gatewayPort, '/healthz', gatewayPid)

    writeFileSync(resolve(runtimeDir, 'demo-tunnel.log'), '')
    if (namedTunnelConfig && !existsSync(namedTunnelConfig)) throw new Error(`Named tunnel config not found: ${namedTunnelConfig}`)
    if (namedTunnelConfig && !namedTunnelPublicUrl) throw new Error('MANJU_DEMO_PUBLIC_URL is required with a named tunnel')
    const tunnelArguments = namedTunnelConfig
      ? ['--config', namedTunnelConfig, 'tunnel', '--no-autoupdate', '--logfile', resolve(runtimeDir, 'demo-tunnel.log'), '--loglevel', 'info', 'run']
      : ['--config', '/dev/null', 'tunnel', '--url', `http://127.0.0.1:${gatewayPort}`, '--no-autoupdate', '--logfile', resolve(runtimeDir, 'demo-tunnel.log'), '--loglevel', 'info']
    const tunnelPid = spawnDetached('cloudflared', tunnelArguments, {}, 'demo-tunnel-console.log')
    started.push([tunnelPid, 'cloudflared'])
    const tunnelUrl = namedTunnelConfig ? namedTunnelPublicUrl : await readTunnelUrl(tunnelPid)
    if (namedTunnelConfig) {
      await sleep(1_000)
      if (!alive(tunnelPid)) throw new Error('Named Cloudflare Tunnel exited during startup')
    }
    const state = {
      version: 1,
      appPid,
      gatewayPid,
      tunnelPid,
      tunnelUrl,
      tunnelMode: namedTunnelConfig ? 'named' : 'quick',
      providerExecutionAllowed: allowProviderExecution,
      startedAt: new Date().toISOString(),
    }
    atomicJson(statePath, state)
    return { action: 'started', running: true, tunnelUrl, credentials: publicCredentials(account), pids: { app: appPid, gateway: gatewayPid, tunnel: tunnelPid } }
  } catch (error) {
    for (const [pid, expected] of started.reverse()) await stopPid(pid, expected).catch(() => undefined)
    throw error
  }
}

try {
  let result
  if (command === 'start') result = await start()
  else if (command === 'stop') result = await stop()
  else if (command === 'status') result = await status()
  else throw new Error('Usage: demo-stack-manager.mjs <start|status|stop> [--json]')
  process.stdout.write(`${jsonOutput ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
  if (command === 'status' && !result.running) process.exitCode = 1
} catch (error) {
  process.stderr.write(`${jsonOutput ? JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) : error}\n`)
  process.exitCode = 1
}
