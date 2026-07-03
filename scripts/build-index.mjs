#!/usr/bin/env node
/**
 * build-index — pull knowledge.oriz.in schema + related graph + concept meta
 * and produce a single public/index.json that the Worker bundles.
 *
 * Two paths:
 *   1. Fetch from https://knowledge.oriz.in (published bundle).
 *   2. If SOURCE_DIR env var set, walk that local knowledge/ tree instead.
 *
 * Idempotent. Safe to re-run — replaces public/index.json.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const matter = (await import('gray-matter')).default

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const OUT = path.join(REPO_ROOT, 'public', 'index.json')

const SOURCE_DIR = process.env.SOURCE_DIR || path.resolve(REPO_ROOT, '..', '..', 'd', 'oriz', 'knowledge')

mkdirSync(path.dirname(OUT), { recursive: true })

function walk(dir, files = []) {
  if (!statSync(dir, { throwIfNoEntry: false })) return files
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (entry.endsWith('.md')) files.push(full)
  }
  return files
}

console.log(`build-index: reading from ${SOURCE_DIR}`)
const files = walk(SOURCE_DIR)
console.log(`build-index: found ${files.length} concept files`)

const concepts = []
for (const f of files) {
  const raw = readFileSync(f, 'utf8')
  let parsed
  try { parsed = matter(raw) } catch { continue }
  const rel = path.relative(SOURCE_DIR, f).replace(/\\/g, '/')
  const slug = rel.replace(/\.md$/, '')
  const body = parsed.content || ''
  concepts.push({
    slug,
    title: parsed.data.title || slug,
    description: parsed.data.description || '',
    type: parsed.data.type || 'other',
    tags: parsed.data.tags || [],
    timestamp: parsed.data.timestamp ? String(parsed.data.timestamp) : undefined,
    related: parsed.data.related || [],
    bodyPreview: body.slice(0, 500),
  })
}

const out = {
  concepts,
  totalCount: concepts.length,
  builtAt: new Date().toISOString(),
  sourceUrl: 'https://github.com/chirag127/workspace/tree/main/knowledge',
}

writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`build-index: wrote ${concepts.length} concepts to ${path.relative(REPO_ROOT, OUT)}`)
