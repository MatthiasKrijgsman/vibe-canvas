/** Accept what people type in an address bar: bare hosts, ports and absolute file paths. */
export function normalizeUrl(input: string): string {
  const url = input.trim()
  if (!url) return ''
  if (/^(https?|file|about|data):/i.test(url)) return url
  if (url.startsWith('/')) return `file://${encodeURI(url)}`
  if (/^:\d+/.test(url)) return `http://localhost${url}`
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/.test(url)) return `http://${url}`
  return `https://${url}`
}
