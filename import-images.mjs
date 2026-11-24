import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const links = new RegExp('https://(?:github\\.com/user-attachments/assets/(' + uuid + ')|private-user-images\\.githubusercontent\\.com/\\d+/\\d+-(' + uuid + ')\\.[a-z0-9]+(?:\\?jwt=[A-Za-z0-9_.-]+)?)', 'gi')
const saved = new Map()
const files = execFileSync('git', ['ls-files', '-z', '--', '*.html', '*.md', '*.markdown']).toString().split('\0').filter(Boolean)

async function importImage(id, signed) {
  const stable = 'https://github.com/user-attachments/assets/' + id
  for (const address of signed ? [stable, signed] : [stable]) {
    const response = await fetch(address, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) continue
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 32 * 1024 * 1024) throw new Error('Attachment exceeds 32 MiB: ' + id)
      chunks.push(chunk)
    }
    const data = Buffer.concat(chunks)
    const { format } = await sharp(data).metadata()
    if (!['png', 'jpeg', 'gif', 'webp', 'avif', 'heif'].includes(format)) throw new Error('Unsupported attachment type: ' + id)
    const name = 'images/' + createHash('sha256').update(data).digest('hex').slice(0, 20) + '.' + (format === 'heif' ? 'avif' : format)
    await mkdir('images', { recursive: true })
    await writeFile(name, data)
    return name
  }
  throw new Error('Cannot download attachment ' + id + '. Upload the original to images/.')
}

for (const file of files) {
  const original = await readFile(file, 'utf8')
  let updated = ''
  let offset = 0
  for (const match of original.matchAll(links)) {
    const id = match[1] || match[2]
    if (!saved.has(id)) saved.set(id, await importImage(id, match[2] && match[0]))
    const name = saved.get(id)
    const local = file.endsWith('.html') ? '/' + name : path.relative(path.dirname(file), name)
    updated += original.slice(offset, match.index) + local
    offset = match.index + match[0].length
  }
  if (offset) await writeFile(file, updated + original.slice(offset))
}
console.log('Imported ' + saved.size + ' distinct GitHub attachments')
