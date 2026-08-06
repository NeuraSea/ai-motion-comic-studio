import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['fumadocs-ui'],
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
}

export default config
