/**
 * knowledge-mcp — CF Worker exposing chirag127's OKF bundle over MCP.
 *
 * Endpoints:
 *   GET  /              — human-facing HTML info page
 *   GET  /mcp           — SSE for MCP protocol (Streamable HTTP transport)
 *   POST /mcp           — JSON-RPC 2.0 MCP requests
 *   GET  /health        — JSON status
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

interface Concept {
  slug: string
  title: string
  description: string
  type: string
  tags: string[]
  timestamp?: string
  related?: string[]
  bodyPreview?: string
}

type IndexData = { concepts: Concept[]; totalCount: number; builtAt: string }

interface Env {
  ASSETS: { fetch: (req: Request | string) => Promise<Response> }
}

let INDEX_CACHE: IndexData | null = null

async function getIndex(env: Env): Promise<IndexData> {
  if (INDEX_CACHE) return INDEX_CACHE
  const res = await env.ASSETS.fetch('https://placeholder/index.json')
  INDEX_CACHE = await res.json() as IndexData
  return INDEX_CACHE
}

// ---- MCP protocol ----

type JsonRpcRequest = { jsonrpc: '2.0'; id: number | string | null; method: string; params?: unknown }
type JsonRpcResponse = { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string } }

const SERVER_INFO = {
  name: 'chirag127-knowledge-mcp',
  version: '0.1.0',
}

const TOOLS = [
  {
    name: 'search',
    description: 'Full-text search across chirag127\'s OKF knowledge bundle (793 concept files). Returns top-N results by term-overlap score.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
        type: { type: 'string', enum: ['decision', 'rule', 'runbook', 'service', 'glossary', 'index'], description: 'Filter by concept type' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read',
    description: 'Fetch full body of a concept file by slug (e.g. "rules/agent/ponytail" or "decisions/agent-tooling/fleet-cut-to-cc-only-2026-07-02"). Returns markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Concept slug (path without .md, e.g. "rules/agent/ponytail")' },
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
]

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2)
}

function search(idx: IndexData, query: string, limit: number, type?: string): Concept[] {
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

async function read(idx: IndexData, slug: string, siteOrigin: string): Promise<string | null> {
  const clean = slug.replace(/^\/+/, '').replace(/\.md$/, '').replace(/\.html$/, '')
  const url = `${siteOrigin}/${clean}.html`
  const c = idx.concepts.find(c => c.slug === clean)
  if (!c) return null
  return `# ${c.title}\n\n${c.description}\n\n---\n\nType: ${c.type}\nTags: ${(c.tags || []).join(', ')}\n${c.timestamp ? `Timestamp: ${c.timestamp}\n` : ''}\n\nFull HTML: ${url}\nRaw source: https://github.com/chirag127/workspace/blob/main/knowledge/${clean}.md\n\n${c.bodyPreview || ''}`
}

function listConcepts(idx: IndexData, type?: string, tag?: string, limit = 20): Concept[] {
  return idx.concepts
    .filter(c => (!type || c.type === type) && (!tag || (c.tags || []).includes(tag)))
    .slice(0, limit)
}

function related(idx: IndexData, slug: string, depth: number): Concept[] {
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

// ---- MCP handlers ----

async function handleMcp(req: JsonRpcRequest, siteOrigin: string, env: Env): Promise<JsonRpcResponse> {
  try {
    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: '2026-03-26',
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        }
      case 'tools/list':
        return { jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } }
      case 'tools/call': {
        const { name, arguments: args } = req.params as { name: string; arguments: Record<string, unknown> }
        const idx = await getIndex(env)
        let content: unknown
        if (name === 'search') {
          const q = String(args.query || '')
          const lim = Math.min(20, Math.max(1, Number(args.limit) || 3))
          const t = args.type ? String(args.type) : undefined
          content = search(idx, q, lim, t)
        } else if (name === 'read') {
          const body = await read(idx, String(args.slug || ''), siteOrigin)
          content = body ?? { error: 'not-found' }
        } else if (name === 'list') {
          content = listConcepts(idx, args.type ? String(args.type) : undefined, args.tag ? String(args.tag) : undefined, Number(args.limit) || 20)
        } else if (name === 'related') {
          content = related(idx, String(args.slug || ''), Math.min(3, Math.max(1, Number(args.depth) || 1)))
        } else {
          return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Unknown tool: ${name}` } }
        }
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }],
          },
        }
      }
      default:
        return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } }
    }
  } catch (err: any) {
    return { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(err?.message || err) } }
  }
}

// ---- HTTP handlers ----

const SITE_ORIGIN = 'https://knowledge.oriz.in'

function homeHtml(idx: IndexData): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>knowledge-mcp — chirag127's OKF over MCP</title>
<style>body{max-width:720px;margin:2rem auto;padding:0 1rem;font:16px/1.5 system-ui,sans-serif;color:#222}code{background:#f4f4f4;padding:.15em .3em}pre{background:#f4f4f4;padding:1em;overflow-x:auto}h1{border-bottom:2px solid #333;padding-bottom:.3em}</style>
</head><body>
<h1>knowledge-mcp</h1>
<p>Public MCP server. No auth. Exposes <a href="${SITE_ORIGIN}">chirag127's OKF knowledge bundle</a> (${idx.totalCount} concept files) over MCP.</p>
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
<p><a href="/health">health</a></p>
</body></html>`
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === '') {
      const idx = await getIndex(env)
      return new Response(homeHtml(idx), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (url.pathname === '/health') {
      const idx = await getIndex(env)
      return new Response(JSON.stringify({ ok: true, concepts: idx.totalCount, builtAt: idx.builtAt, server: SERVER_INFO }), { headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname === '/mcp') {
      if (request.method === 'POST') {
        const body = await request.json() as JsonRpcRequest | JsonRpcRequest[]
        if (Array.isArray(body)) {
          const responses = await Promise.all(body.map(r => handleMcp(r, SITE_ORIGIN, env)))
          return new Response(JSON.stringify(responses), { headers: { 'content-type': 'application/json' } })
        }
        const resp = await handleMcp(body, SITE_ORIGIN, env)
        return new Response(JSON.stringify(resp), { headers: { 'content-type': 'application/json' } })
      }
      if (request.method === 'GET') {
        return new Response('data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"knowledge-mcp ready"}}\n\n', {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        })
      }
      return new Response('Method not allowed', { status: 405 })
    }
    return new Response('Not found', { status: 404 })
  },
}
