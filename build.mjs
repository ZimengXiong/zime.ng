import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { load } from 'cheerio'
import sharp from 'sharp'

const output = path.resolve('dist')
const site = 'https://zime.ng'
const processed = new Map()
const widths = [320, 640, 960, 1280, 1920]
const pages = []
const assets = new Set()

async function copySite(dir = '') {
  for (const entry of await readdir(dir || '.', { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await copySite(file)
    } else if (entry.isFile() && /\.(html|css|js|txt|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|woff2?|pdf)$/i.test(file)) {
      await mkdir(path.join(output, dir), { recursive: true })
      await cp(file, path.join(output, file))
      assets.add(file)
      if (file.endsWith('.html')) pages.push(file)
    }
  }
}

function imageHost(url) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    (url.hostname === 'zimengxiong.com' || url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'))
}

async function download(url) {
  if (url.hostname === 'github.com') {
    const blob = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/)
    if (blob) url = new URL('/' + blob[1] + '/' + blob[2] + '/' + blob[3], 'https://raw.githubusercontent.com')
  }
  for (let hop = 0; hop < 6 && imageHost(url); hop++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
      url = new URL(response.headers.get('location'), url)
      await response.body?.cancel()
      continue
    }
    if (!response.ok) throw new Error('Remote image download failed: HTTP ' + response.status)
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 32 * 1024 * 1024) throw new Error('Remote image exceeds 32 MiB')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  throw new Error('Unsupported image redirect')
}

async function optimize(url) {
  const local = url.origin === site
  const file = decodeURIComponent(url.pathname.slice(1))
  if (local && !assets.has(file)) throw new Error('Missing image: ' + file)
  const bytes = local ? await readFile(file) : await download(url)
  const meta = await sharp(bytes, { animated: true }).metadata()
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 20)
  const stem = '/images/' + id
  if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'svg'].includes(meta.format)) throw new Error('Unsupported image format: ' + meta.format)
  const original = local ? url.pathname : stem + '.' + (meta.format === 'heif' ? 'avif' : meta.format)
  if (!local) await writeFile(path.join(output, original), bytes)
  if (meta.format === 'svg') return { src: original }
  const rotated = meta.orientation >= 5 && meta.orientation <= 8
  const width = rotated ? meta.height : meta.width
  const height = rotated ? meta.width : meta.pageHeight || meta.height
  const candidates = []
  for (const w of new Set([...widths.filter(w => w < width), Math.min(width, 2560)])) {
    const buffer = await sharp(bytes, { animated: true }).autoOrient().resize({ width: w, withoutEnlargement: true }).webp({ quality: 82, keepDuplicateFrames: true }).toBuffer()
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 20)
    const src = '/images/' + hash + '-' + w + '.webp'
    await writeFile(path.join(output, src), buffer)
    candidates.push(src + ' ' + w + 'w')
  }
  return { src: original, srcset: candidates.join(', '), sizes: '(max-width: ' + width + 'px) 100vw, ' + width + 'px', width, height }
}

await rm(output, { recursive: true, force: true })
await copySite()
await mkdir(path.join(output, 'images'), { recursive: true })
for (const page of pages) {
  const $ = load(await readFile(page, 'utf8'), { scriptingEnabled: false })
  for (const element of $('img[src]')) {
    const img = $(element)
    const url = new URL(img.attr('src'), new URL(page, site))
    if (url.origin !== site && !imageHost(url)) continue
    if (!processed.has(url.href)) processed.set(url.href, await optimize(url))
    const attributes = processed.get(url.href)
    for (const [name, value] of Object.entries(attributes)) {
      if (!img.attr(name) || name === 'src') img.attr(name, String(value))
    }
  }
  if ($('img').length && !$('style').text().includes('max-width: 100%')) $('head').append('<style>img { max-width: 100%; height: auto; }</style>')
  await writeFile(path.join(output, page), $.html())
}
console.log('Built ' + pages.length + ' pages and processed ' + processed.size + ' distinct image URLs')
