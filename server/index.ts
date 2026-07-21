import { createServer } from 'node:http'
import { resolve } from 'node:path'

import express from 'express'

import { createApplication } from './app.js'

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 8788 : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT 必须是 1 到 65535 的整数')
  }
  return port
}

export async function startServer(): Promise<void> {
  const runtime = await createApplication()
  const { app, provider } = runtime
  const host = process.env.HOST?.trim() || '127.0.0.1'
  const port = parsePort(process.env.PORT)
  const serveWeb = process.env.SERVE_WEB === '1'
  const webRoot = resolve(process.env.MANJU_WEB_ROOT?.trim() || 'dist')

  if (serveWeb) {
    app.use(express.static(webRoot, {
      dotfiles: 'deny',
      fallthrough: true,
      index: 'index.html',
      immutable: true,
      maxAge: '1y',
      setHeaders(response, filePath) {
        // Vite assets are content-hashed and can be cached indefinitely, but
        // caching index.html makes a restarted local MVP appear to still run
        // the previous build for up to an hour.
        if (filePath.endsWith('.html')) {
          response.setHeader('Cache-Control', 'no-store')
        }
      },
    }))
    app.use((request, response, next) => {
      if (request.method !== 'GET' || !request.accepts('html')) {
        next()
        return
      }
      response.setHeader('Cache-Control', 'no-store')
      response.sendFile(resolve(webRoot, 'index.html'), (error) => {
        if (error && !response.headersSent) response.status(404).end()
      })
    })
  }
  const server = createServer(app)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  console.log(`漫剧 MVP API 已启动: http://${host}:${port}`)
  if (serveWeb) console.log(`漫剧 Web 已托管: ${webRoot}`)
  console.log(`图片 Provider: ${provider.name} / ${provider.model} (${provider.configured ? '已配置' : '未配置'})`)

  let shutdownPromise: Promise<void> | undefined
  const shutdown = (signal: string) => {
    if (shutdownPromise) return
    console.log(`\n收到 ${signal}，正在关闭服务...`)
    shutdownPromise = (async () => {
      const forceTimer = setTimeout(() => server.closeAllConnections(), 5_000)
      forceTimer.unref()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      clearTimeout(forceTimer)
      await runtime.close()
    })()
    void shutdownPromise.then(
      () => process.exit(0),
      (error) => {
        console.error('关闭服务失败', error instanceof Error ? error.message : 'unknown error')
        process.exit(1)
      },
    )
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}
