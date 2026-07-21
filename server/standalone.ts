import { startServer } from './index.js'
import { assertFfmpegReleaseRuntime } from './ffmpeg-runtime.js'
import { startStandaloneRuntime } from './standalone-runtime.js'

startStandaloneRuntime({
  environment: process.env,
  assertReleaseRuntime: assertFfmpegReleaseRuntime,
  startServer,
}).catch((error) => {
  console.error('启动漫剧独立服务失败', error)
  process.exitCode = 1
})
