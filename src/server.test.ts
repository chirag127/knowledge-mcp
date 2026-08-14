import { describe, it, expect, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer, __resetIndexCache, type IndexData } from './index.js'

// Fixture index served through a stubbed ASSETS binding — no real HTTP/transport.
const idx: IndexData = {
  concepts: [
    {
      slug: 'rules/agent/ponytail',
      title: 'Ponytail Rule',
      description: 'Keep agent output tidy',
      type: 'rule',
      tags: ['agent'],
      related: ['glossary/okf'],
      bodyPreview: 'Body.',
    },
    {
      slug: 'glossary/okf',
      title: 'OKF',
      description: 'Oriz Knowledge Format',
      type: 'glossary',
      tags: ['glossary'],
    },
  ],
  totalCount: 2,
  builtAt: '2026-08-14T00:00:00.000Z',
}

const env = {
  ASSETS: {
    fetch: async () => new Response(JSON.stringify(idx), { headers: { 'content-type': 'application/json' } }),
  },
}

async function connectedClient() {
  __resetIndexCache()
  const server = buildServer(env)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, server }
}

// The text-content block a tool returns carries JSON; parse it back to data.
function parseToolJson(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find(b => b.type === 'text')?.text ?? ''
  return JSON.parse(text)
}

describe('MCP tool surface (in-memory transport)', () => {
  beforeEach(() => __resetIndexCache())

  it('lists exactly the four expected tools with input schemas', async () => {
    const { client, server } = await connectedClient()
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['list', 'read', 'related', 'search'])
    for (const t of tools) {
      expect(t.description).toBeTruthy()
      expect(t.inputSchema).toBeTruthy()
    }
    await server.close()
  })

  it('search tool returns ranked results over the index', async () => {
    const { client, server } = await connectedClient()
    const res = await client.callTool({ name: 'search', arguments: { query: 'agent', limit: 5 } })
    const data = parseToolJson(res as never)
    expect(data.map((c: { slug: string }) => c.slug)).toContain('rules/agent/ponytail')
    await server.close()
  })

  it('read tool returns markdown for a known slug', async () => {
    const { client, server } = await connectedClient()
    const res = await client.callTool({ name: 'read', arguments: { slug: 'glossary/okf' } })
    const text = (res as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('# OKF')
    await server.close()
  })

  it('read tool returns a not-found payload for an unknown slug', async () => {
    const { client, server } = await connectedClient()
    const res = await client.callTool({ name: 'read', arguments: { slug: 'no/such/thing' } })
    expect(parseToolJson(res as never)).toEqual({ error: 'not-found' })
    await server.close()
  })

  it('list tool filters by type', async () => {
    const { client, server } = await connectedClient()
    const res = await client.callTool({ name: 'list', arguments: { type: 'glossary' } })
    const data = parseToolJson(res as never)
    expect(data.map((c: { slug: string }) => c.slug)).toEqual(['glossary/okf'])
    await server.close()
  })

  it('related tool walks the frontmatter graph', async () => {
    const { client, server } = await connectedClient()
    const res = await client.callTool({ name: 'related', arguments: { slug: 'rules/agent/ponytail', depth: 1 } })
    const data = parseToolJson(res as never)
    expect(data.map((c: { slug: string }) => c.slug)).toEqual(['glossary/okf'])
    await server.close()
  })
})
