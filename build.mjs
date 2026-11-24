import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { load } from 'cheerio'
import sharp from 'sharp'

const output = path.resolve('dist')
const site = 'https://zime.ng'
const origin = 'https://zimengxiong.com'
const person = origin + '/#person'
const website = origin + '/#website'
const ogImage = origin + '/og-image.png'
const indexNowKey = '3c9e7a1f5b2d8e4a6c0f9b3d7e1a5c8f'
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const posts = []
const urls = []
const processed = new Map()
const widths = [320, 640, 960, 1280, 1920]
const persist = process.argv.includes('--save-images')
const cacheDir = 'images/generated'
const manifestFile = cacheDir + '/manifest.json'
const encoding = { version: 1, widths, maxWidth: 2560, quality: 82, sharp: sharp.versions.sharp, vips: sharp.versions.vips, webp: sharp.versions.webp }
let manifest = {}
try {
  manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
let encoded = 0
const pages = []
const assets = new Set()

async function copySite(dir = '') {
  for (const entry of await readdir(dir || '.', { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await copySite(file)
    } else if (entry.isFile() && /\.(html|css|js|txt|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|woff2?|pdf|xml)$/i.test(file)) {
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
  if (meta.format === 'svg' || (local && file.startsWith('art/'))) return { src: original }
  const rotated = meta.orientation >= 5 && meta.orientation <= 8
  const width = rotated ? meta.height : meta.width
  const height = rotated ? meta.width : meta.pageHeight || meta.height
  const key = createHash('sha256').update(bytes).update(JSON.stringify(encoding)).digest('hex')
  if (manifest[key] && manifest[key].every(item => assets.has(item.src.slice(1)))) {
    return { ...responsive(manifest[key], width, height), src: original }
  }
  const candidates = []
  for (const w of new Set([...widths.filter(w => w < width), Math.min(width, encoding.maxWidth)])) {
    const buffer = await sharp(bytes, { animated: true }).autoOrient().resize({ width: w, withoutEnlargement: true }).webp({ quality: encoding.quality, keepDuplicateFrames: true }).toBuffer()
    encoded++
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 20)
    const src = '/' + cacheDir + '/' + hash + '-' + w + '.webp'
    await writeFile(path.join(output, src), buffer)
    if (persist) await writeFile(src.slice(1), buffer)
    assets.add(src.slice(1))
    candidates.push({ src, width: w })
  }
  manifest[key] = candidates
  return { ...responsive(candidates, width, height), src: original }
}

function escape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function clean(text) {
  return text.replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

function clip(text, max = 160) {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:.—-]+$/, '') + '…'
}

function parseDate(text) {
  const match = clean(text).match(/^(\d{1,2}) ([a-z]{3}) (\d{4})$/i)
  if (!match || !months.includes(match[2].toLowerCase())) throw new Error('Unparseable post date: ' + text)
  return new Date(Date.UTC(Number(match[3]), months.indexOf(match[2].toLowerCase()), Number(match[1])))
}

function day(date) {
  return date.toISOString().slice(0, 10)
}

function committed(file) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

function excerpt($) {
  let text = ''
  for (const element of $('pre.m span.r')) {
    const span = $(element)
    const paragraph = clean(span.text())
    if (paragraph.length < 60 || /^NOTE:/.test(paragraph) || span.children('b').length && clean(span.children('b').text()) === paragraph) continue
    text = text ? text + ' ' + paragraph : paragraph
    if (text.length >= 140) break
  }
  return clip(text)
}

function breadcrumbs(items) {
  return { '@type': 'BreadcrumbList', '@id': items.at(-1).url + '#breadcrumb', itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: item.url })) }
}

function seo($, page) {
  const route = '/' + page.replace(/index\.html$/, '')
  const url = origin + route
  const home = { name: 'Zimeng Xiong', url: origin + '/' }
  let meta
  if (route === '/') {
    meta = {
      title: 'Zimeng Xiong',
      heading: 'Zimeng Xiong',
      type: 'website',
      description: 'Zimeng Xiong (Alpaca Engineering) — software and hardware projects including PancakeSlicer, ExcaliDash, WinMux, Modelr, and technical writing.',
      lastmod: committed(page),
      graph: description => [
        {
          '@type': 'Person',
          '@id': person,
          name: 'Zimeng Xiong',
          givenName: 'Zimeng',
          familyName: 'Xiong',
          alternateName: ['Zimeng', 'Alpaca Engineering'],
          url: origin + '/',
          email: 'mailto:me@zimengxiong.com',
          sameAs: ['https://github.com/ZimengXiong', 'https://www.youtube.com/@alpacaengineering', 'https://x.com/zimengxiong', 'https://www.reddit.com/user/arduinoRPi4/', 'https://zime.ng/', 'https://excalidash.xyz/', 'https://pancake.cooking/', 'https://www.winmux.dev/', 'https://alpacawebservices.com/']
        },
        { '@type': 'WebSite', '@id': website, url: origin + '/', name: 'Zimeng Xiong', alternateName: 'zime.ng', inLanguage: 'en', publisher: { '@id': person } },
        { '@type': 'ProfilePage', '@id': url + '#webpage', url, name: 'Zimeng Xiong', description, inLanguage: 'en', isPartOf: { '@id': website }, mainEntity: { '@id': person }, about: { '@id': person } }
      ]
    }
  } else if (route === '/things/') {
    const items = []
    for (const element of $('pre.m span.r')) {
      const span = $(element)
      if (!/--i:3(;|$)/.test(span.attr('style') || '')) continue
      const link = span.children('a').first()
      if (!link.length) continue
      items.push({ '@type': 'ListItem', position: items.length + 1, name: clean(link.text()), url: new URL(link.attr('href'), url).href.replace(site + '/', origin + '/') })
    }
    meta = {
      title: 'Things — Zimeng Xiong',
      heading: 'Things',
      type: 'website',
      description: 'Projects by Zimeng Xiong: WinMux, PancakeSlicer, ExcaliDash, tinyTouch, swipeType, Modelr, hunyuan3D-mlx-swift, and more macOS, 3D printing, and ML tools.',
      lastmod: committed(page),
      graph: description => [
        { '@type': 'CollectionPage', '@id': url + '#webpage', url, name: 'Things', description, inLanguage: 'en', isPartOf: { '@id': website }, about: { '@id': person }, author: { '@id': person }, breadcrumb: { '@id': url + '#breadcrumb' }, mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items } },
        breadcrumbs([home, { name: 'Things', url }])
      ]
    }
  } else if (route.startsWith('/blog/')) {
    const heading = clean($('pre.m .ta b').first().text())
    const date = parseDate($('pre.m .dt').first().text())
    const description = excerpt($)
    if (!heading || description.length < 100) throw new Error('Missing post metadata: ' + page)
    const post = { title: heading, url, date, description }
    posts.push(post)
    meta = {
      title: heading + ' — Zimeng Xiong',
      heading,
      type: 'article',
      description,
      date,
      lastmod: day(date),
      graph: description => [
        { '@type': 'BlogPosting', '@id': url + '#article', headline: heading, description, datePublished: day(date), author: { '@id': person }, publisher: { '@id': person }, mainEntityOfPage: { '@type': 'WebPage', '@id': url }, url, image: ogImage, inLanguage: 'en', isPartOf: { '@id': website } },
        breadcrumbs([home, { name: heading, url }])
      ]
    }
  } else {
    throw new Error('No SEO metadata for ' + page)
  }
  urls.push({ url, lastmod: meta.lastmod })
  const tags = [
    ['meta', { name: 'description', content: meta.description }],
    ['meta', { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1' }],
    ['link', { rel: 'canonical', href: url }],
    ['link', { rel: 'icon', href: '/alpaca.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'alternate', type: 'application/rss+xml', title: 'Zimeng Xiong', href: origin + '/feed.xml' }],
    ['meta', { property: 'og:site_name', content: 'Zimeng Xiong' }],
    ['meta', { property: 'og:locale', content: 'en_US' }],
    ['meta', { property: 'og:type', content: meta.type }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:title', content: meta.heading }],
    ['meta', { property: 'og:description', content: meta.description }],
    ['meta', { property: 'og:image', content: ogImage }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: 'Zimeng Xiong' }]
  ]
  if (meta.date) {
    tags.push(['meta', { property: 'article:published_time', content: day(meta.date) }])
    tags.push(['meta', { property: 'article:author', content: origin + '/' }])
  }
  tags.push(
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:site', content: '@zimengxiong' }],
    ['meta', { name: 'twitter:creator', content: '@zimengxiong' }],
    ['meta', { name: 'twitter:title', content: meta.heading }],
    ['meta', { name: 'twitter:description', content: meta.description }],
    ['meta', { name: 'twitter:image', content: ogImage }]
  )
  const graph = JSON.stringify({ '@context': 'https://schema.org', '@graph': meta.graph(meta.description) }).replace(/</g, '\\u003c')
  const html = tags.map(([tag, attrs]) => '<' + tag + Object.entries(attrs).map(([k, v]) => ' ' + k + '="' + escape(v) + '"').join('') + '>').join('\n') + '\n<script type="application/ld+json">' + graph + '</script>'
  $('head meta[name="description"], head link[rel="canonical"], head link[rel="icon"], head link[rel="apple-touch-icon"]').remove()
  $('title').text(meta.title).after('\n' + html)
}

async function discovery() {
  posts.sort((a, b) => b.date - a.date || a.title.localeCompare(b.title))
  urls.sort((a, b) => a.url.localeCompare(b.url))
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(item => '  <url>\n    <loc>' + escape(item.url) + '</loc>\n' + (item.lastmod ? '    <lastmod>' + item.lastmod + '</lastmod>\n' : '') + '  </url>\n').join('') + '</urlset>\n'
  const feed = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n' +
    '  <title>Zimeng Xiong</title>\n  <link>' + origin + '/</link>\n  <description>Writing by Zimeng Xiong (Alpaca Engineering) on software, hardware, and tools.</description>\n  <language>en</language>\n' +
    '  <lastBuildDate>' + posts[0].date.toUTCString() + '</lastBuildDate>\n  <atom:link href="' + origin + '/feed.xml" rel="self" type="application/rss+xml"/>\n' +
    '  <image>\n    <url>' + ogImage + '</url>\n    <title>Zimeng Xiong</title>\n    <link>' + origin + '/</link>\n  </image>\n' +
    posts.map(post => '  <item>\n    <title>' + escape(post.title) + '</title>\n    <link>' + escape(post.url) + '</link>\n    <guid isPermaLink="true">' + escape(post.url) + '</guid>\n    <pubDate>' + post.date.toUTCString() + '</pubDate>\n    <author>me@zimengxiong.com (Zimeng Xiong)</author>\n    <description>' + escape(post.description) + '</description>\n  </item>\n').join('') +
    '</channel>\n</rss>\n'
  const llms = '# Zimeng Xiong\n\n' +
    '> Zimeng Xiong builds software and hardware projects and publishes under the name Alpaca Engineering, including the YouTube channel @alpacaengineering. This site (zimengxiong.com, also served at zime.ng) lists projects and technical writing.\n\n' +
    '- Email: me@zimengxiong.com\n- GitHub: https://github.com/ZimengXiong\n- YouTube: https://www.youtube.com/@alpacaengineering\n- X: https://x.com/zimengxiong\n\n' +
    '## Projects\n\n' +
    '- [PancakeSlicer](https://pancake.cooking/): self-hostable, non-planar 3D printing slicer.\n' +
    '- [ExcaliDash](https://excalidash.xyz/): self-hosted Excalidraw workspace with saved drawings, collections, and real-time collaboration.\n' +
    '- [WinMux](https://www.winmux.dev/): batteries-included window manager for macOS.\n' +
    '- [Modelr](https://github.com/ZimengXiong/Modelr): image to 3D on your Mac.\n' +
    '- [Things](' + origin + '/things/): full project list, including tinyTouch, swipeType, and hunyuan3D-mlx-swift.\n\n' +
    '## Blog\n\n' +
    posts.map(post => '- [' + post.title + '](' + post.url + '): ' + day(post.date)).join('\n') + '\n'
  await writeFile(path.join(output, 'sitemap.xml'), sitemap)
  await writeFile(path.join(output, 'feed.xml'), feed)
  await writeFile(path.join(output, 'robots.txt'), 'User-agent: *\nAllow: /\n\nSitemap: ' + origin + '/sitemap.xml\n')
  await writeFile(path.join(output, 'llms.txt'), llms)
  await writeFile(path.join(output, indexNowKey + '.txt'), indexNowKey)
}

function responsive(candidates, width, height) {
  return { srcset: candidates.map(item => item.src + ' ' + item.width + 'w').join(', '), sizes: '(max-width: ' + width + 'px) 100vw, ' + width + 'px', width, height }
}

await rm(output, { recursive: true, force: true })
await copySite()
await mkdir(path.join(output, cacheDir), { recursive: true })
if (persist) await mkdir(cacheDir, { recursive: true })
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
  seo($, page)
  await writeFile(path.join(output, page), $.html())
}
await discovery()
for (const file of assets) {
  if (!file.startsWith('images/') || file.startsWith(cacheDir + '/') || !/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file)) continue
  const url = new URL('/' + file, site)
  if (!processed.has(url.href)) processed.set(url.href, await optimize(url))
}
if (persist) await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
console.log('Built ' + pages.length + ' pages and processed ' + processed.size + ' distinct image URLs; encoded ' + encoded + ' new variants')
