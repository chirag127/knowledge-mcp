/**
 * knowledge-mcp — CF Worker exposing chirag127's OKF bundle over MCP.
 *
 * MCP 2.0: served over the SDK's Streamable HTTP transport
 * (WebStandardStreamableHTTPServerTransport), stateless — a fresh
 * McpServer is built per request. Replaces the previous hand-rolled
 * JSON-RPC switch.
 *
 * Endpoints:
 *   GET  /                                  — human-facing HTML info page
 *   GET  /mcp, POST /mcp                     — MCP Streamable HTTP transport
 *   GET  /.well-known/mcp/server-card.json  — static server card
 *   GET  /healthz                            — plaintext liveness
 *   GET  /health                             — JSON status (legacy)
 *
 * Tools exposed (no auth):
 *   search(query, limit=3, type=?)  — BM25-lite over titles + descriptions
 *   read(slug)                        — full concept body
 *   list(type=?, tag=?, limit=20)   — filter concepts
 *   related(slug, depth=1)           — graph neighbors via frontmatter.related
 *
 * Index is loaded from ASSETS binding at first request, cached in globalThis.
 *
 * Related: chirag127/workspace/knowledge/decisions/agent-tooling/knowledge-mcp-server-public-2026-07-03.md
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

export interface Concept {
  slug: string
  title: string
  description: string
  type: string
  tags: string[]
  timestamp?: string
  related?: string[]
  bodyPreview?: string
}

export type IndexData = { concepts: Concept[]; totalCount: number; builtAt: string }

interface Env {
  ASSETS: { fetch: (req: Request | string) => Promise<Response> }
}

let INDEX_CACHE: IndexData | null = null

/** Test-only: clear the module-level index cache so a fresh env is re-read. */
export function __resetIndexCache(): void {
  INDEX_CACHE = null
}

async function getIndex(env: Env): Promise<IndexData> {
  if (INDEX_CACHE) return INDEX_CACHE
  const res = await env.ASSETS.fetch('https://placeholder/index.json')
  INDEX_CACHE = await res.json() as IndexData
  return INDEX_CACHE
}

// ---- MCP server metadata ----

const SERVER_INFO = {
  name: 'chirag127-knowledge-mcp',
  version: '0.1.0',
}

const SITE_ORIGIN = 'https://knowledge.oriz.in'

// ---- Search-index logic (unchanged behaviour) ----

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2)
}

export function search(idx: IndexData, query: string, limit: number, type?: string): Concept[] {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return []
  const scored = idx.concepts
    .filter(c => !type || c.type === type)
    .map(c => {
      const haystack = tokenize(`${c.title} ${c.description} ${(c.tags || []).join(' ')} ${c.slug}`)
      const score = qTokens.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0)
      return { c, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return scored.map(s => s.c)
}

export async function read(idx: IndexData, slug: string, siteOrigin: string): Promise<string | null> {
  const clean = slug.replace(/^\/+/, '').replace(/\.md$/, '').replace(/\.html$/, '')
  const url = `${siteOrigin}/${clean}.html`
  const c = idx.concepts.find(c => c.slug === clean)
  if (!c) return null
  return `# ${c.title}\n\n${c.description}\n\n---\n\nType: ${c.type}\nTags: ${(c.tags || []).join(', ')}\n${c.timestamp ? `Timestamp: ${c.timestamp}\n` : ''}\n\nFull HTML: ${url}\nRaw source: https://github.com/chirag127/workspace/blob/main/knowledge/${clean}.md\n\n${c.bodyPreview || ''}`
}

export function listConcepts(idx: IndexData, type?: string, tag?: string, limit = 20): Concept[] {
  return idx.concepts
    .filter(c => (!type || c.type === type) && (!tag || (c.tags || []).includes(tag)))
    .slice(0, limit)
}

export function related(idx: IndexData, slug: string, depth: number): Concept[] {
  const seen = new Set<string>()
  const queue: Array<{ slug: string; d: number }> = [{ slug, d: 0 }]
  const found: Concept[] = []
  while (queue.length) {
    const { slug: s, d } = queue.shift()!
    if (seen.has(s) || d > depth) continue
    seen.add(s)
    const c = idx.concepts.find(c => c.slug === s)
    if (!c) continue
    if (d > 0) found.push(c)
    for (const r of c.related || []) queue.push({ slug: r, d: d + 1 })
  }
  return found
}

function textResult(content: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      },
    ],
  }
}

// ---- MCP server (fresh instance per request) ----

const CONCEPT_TYPES = ['decision', 'rule', 'runbook', 'service', 'glossary', 'index'] as const

export function buildServer(env: Env): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "Public MCP server exposing chirag127's OKF knowledge bundle (search, read, " +
      'list, related). No auth. Backed by a prebuilt search index of concept files.',
  })

  server.registerTool(
    'search',
    {
      description:
        "Full-text search across chirag127's OKF knowledge bundle (793 concept files). Returns top-N results by term-overlap score.",
      inputSchema: {
        query: z.string().describe('Search terms'),
        limit: z.number().int().min(1).max(20).optional().describe('Max results (default 3)'),
        type: z.enum(CONCEPT_TYPES).optional().describe('Filter by concept type'),
      },
    },
    async (args) => {
      const idx = await getIndex(env)
      const q = String(args.query || '')
      const lim = Math.min(20, Math.max(1, Number(args.limit) || 3))
      const t = args.type ? String(args.type) : undefined
      return textResult(search(idx, q, lim, t))
    }
  )

  server.registerTool(
    'read',
    {
      description:
        'Fetch full body of a concept file by slug (e.g. "rules/agent/ponytail" or "decisions/agent-tooling/fleet-cut-to-cc-only-2026-07-02"). Returns markdown.',
      inputSchema: {
        slug: z.string().describe('Concept slug (path without .md, e.g. "rules/agent/ponytail")'),
      },
    },
    async (args) => {
      const idx = await getIndex(env)
      const body = await read(idx, String(args.slug || ''), SITE_ORIGIN)
      return textResult(body ?? { error: 'not-found' })
    }
  )

  server.registerTool(
    'list',
    {
      description: 'List concept files filtered by type and/or tag. Returns titles + slugs.',
      inputSchema: {
        type: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
      },
    },
    async (args) => {
      const idx = await getIndex(env)
      const content = listConcepts(
        idx,
        args.type ? String(args.type) : undefined,
        args.tag ? String(args.tag) : undefined,
        Number(args.limit) || 20
      )
      return textResult(content)
    }
  )

  server.registerTool(
    'related',
    {
      description: 'Get concepts related to a given slug via `related:` frontmatter graph.',
      inputSchema: {
        slug: z.string(),
        depth: z.number().int().min(1).max(3).optional().describe('Traversal depth (default 1)'),
      },
    },
    async (args) => {
      const idx = await getIndex(env)
      const content = related(idx, String(args.slug || ''), Math.min(3, Math.max(1, Number(args.depth) || 1)))
      return textResult(content)
    }
  )

  return server
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const server = buildServer(env)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    transport.close().catch(() => undefined)
    server.close().catch(() => undefined)
  }
}

// ---- Static server card ----

const SERVER_CARD = {
  name: 'chirag127/knowledge-mcp',
  title: "knowledge-mcp — chirag127's OKF over MCP",
  description:
    "Public MCP server exposing chirag127's OKF knowledge bundle (793 concept files) — search, read, list, related. No auth.",
  version: SERVER_INFO.version,
  websiteUrl: 'https://knowledge-mcp.oriz.in',
  repositoryUrl: 'https://github.com/chirag127/knowledge-mcp',
  documentationUrl: 'https://github.com/chirag127/knowledge-mcp#readme',
  serverInfo: {
    name: SERVER_INFO.name,
    title: "knowledge-mcp — chirag127's OKF over MCP",
    version: SERVER_INFO.version,
  },
  authentication: { required: false },
  tools: [
    {
      name: 'search',
      description:
        "Full-text search across chirag127's OKF knowledge bundle (793 concept files). Returns top-N results by term-overlap score.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
          type: { type: 'string', enum: [...CONCEPT_TYPES], description: 'Filter by concept type' },
        },
        required: ['query'],
      },
    },
    {
      name: 'read',
      description:
        'Fetch full body of a concept file by slug (e.g. "rules/agent/ponytail"). Returns markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Concept slug (path without .md)' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'list',
      description: 'List concept files filtered by type and/or tag. Returns titles + slugs.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
    {
      name: 'related',
      description: 'Get concepts related to a given slug via `related:` frontmatter graph.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          depth: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
        },
        required: ['slug'],
      },
    },
  ],
  resources: [],
  prompts: [],
} as const

// ---- HTTP handlers ----

function homeHtml(idx: IndexData): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>knowledge-mcp — chirag127's OKF over MCP</title>
<style>body{max-width:720px;margin:2rem auto;padding:0 1rem;font:16px/1.5 system-ui,sans-serif;color:#222}code{background:#f4f4f4;padding:.15em .3em}pre{background:#f4f4f4;padding:1em;overflow-x:auto}h1{border-bottom:2px solid #333;padding-bottom:.3em}</style>
</head><body>
<h1>knowledge-mcp</h1>
<p>Public MCP server. No auth. Exposes <a href="${SITE_ORIGIN}">chirag127's OKF knowledge bundle</a> (${idx.totalCount} concept files) over MCP (Streamable HTTP, MCP 2.0).</p>
<h2>Connect</h2>
<p>MCP endpoint: <code>https://knowledge-mcp.oriz.in/mcp</code></p>
<pre>{
  "mcpServers": {
    "chirag127-knowledge": {
      "url": "https://knowledge-mcp.oriz.in/mcp"
    }
  }
}</pre>
<h2>Tools</h2>
<ul>
<li><code>search(query, limit=3, type?)</code> — full-text search</li>
<li><code>read(slug)</code> — fetch concept body</li>
<li><code>list(type?, tag?, limit=20)</code> — filter concepts</li>
<li><code>related(slug, depth=1)</code> — graph neighbors</li>
</ul>
<h2>Source</h2>
<ul>
<li>Server: <a href="https://github.com/chirag127/knowledge-mcp">github.com/chirag127/knowledge-mcp</a></li>
<li>Knowledge: <a href="https://github.com/chirag127/workspace">github.com/chirag127/workspace</a></li>
<li>Index built: ${idx.builtAt}</li>
</ul>
<p><a href="/.well-known/mcp/server-card.json">server card</a> · <a href="/health">health</a></p>
</body></html>`
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/' || url.pathname === '') {
      const idx = await getIndex(env)
      return new Response(homeHtml(idx), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    if (url.pathname === '/.well-known/mcp/server-card.json') {
      return new Response(JSON.stringify(SERVER_CARD, null, 2), {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
      })
    }

    if (url.pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain' } })
    }

    if (url.pathname === '/health') {
      const idx = await getIndex(env)
      return new Response(
        JSON.stringify({ ok: true, concepts: idx.totalCount, builtAt: idx.builtAt, server: SERVER_INFO }),
        { headers: { 'content-type': 'application/json' } }
      )
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      return handleMcp(request, env)
    }

    return new Response('Not found', { status: 404 })
  },
}
