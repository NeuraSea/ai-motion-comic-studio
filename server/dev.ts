import { startServer } from './index.js'

startServer().catch((error) => {
  console.error('启动漫剧 MVP API 失败', error)
  process.exitCode = 1
})
