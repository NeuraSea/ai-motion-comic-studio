const originHostname = 'console-origin.nervafs.xyz'

export default {
  async fetch(request) {
    const incoming = new URL(request.url)
    incoming.hostname = originHostname

    const upstreamRequest = new Request(incoming, request)
    upstreamRequest.headers.set('x-manju-console-proxy', 'cloudflare-worker')
    return fetch(upstreamRequest)
  },
}
