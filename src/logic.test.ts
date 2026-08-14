import { describe, it, expect } from 'vitest'
import {
  tokenize,
  search,
  read,
  listConcepts,
  related,
  type Concept,
  type IndexData,
} from './index.js'

// A small hand-built fixture index that exercises every code path.
const concepts: Concept[] = [
  {
    slug: 'rules/agent/ponytail',
    title: 'Ponytail Rule',
    description: 'Keep agent output tidy and short',
    type: 'rule',
    tags: ['agent', 'style'],
    timestamp: '2026-01-01',
    related: ['decisions/agent-tooling/fleet'],
    bodyPreview: 'Body of ponytail.',
  },
  {
    slug: 'decisions/agent-tooling/fleet',
    title: 'Fleet Decision',
    description: 'Cut the fleet to CC only',
    type: 'decision',
    tags: ['agent', 'fleet'],
    related: ['rules/agent/ponytail', 'glossary/okf'],
    bodyPreview: 'Body of fleet.',
  },
  {
    slug: 'glossary/okf',
    title: 'OKF',
    description: 'Oriz Knowledge Format glossary entry',
    type: 'glossary',
    tags: ['glossary'],
    // no related, no timestamp, no bodyPreview -> covers optional fallbacks
  } as Concept,
]

const idx: IndexData = {
  concepts,
  totalCount: concepts.length,
  builtAt: '2026-08-14T00:00:00.000Z',
}

const SITE = 'https://knowledge.oriz.in'

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, and drops tokens of length <= 2', () => {
    // "42" (2 chars) and single letters are dropped; multi-char alphanumerics survive.
    expect(tokenize('Hello, WORLD-42 a bc worker9')).toEqual(['hello', 'world', 'worker9'])
  })

  it('returns an empty array for punctuation-only input', () => {
    expect(tokenize('--- , . !')).toEqual([])
  })
})

describe('search', () => {
  it('returns matches ranked by term-overlap score', () => {
    const res = search(idx, 'agent fleet', 10)
    expect(res.map(c => c.slug)).toEqual([
      'decisions/agent-tooling/fleet', // matches "agent" (tags) + "fleet" -> score 2
      'rules/agent/ponytail', // matches "agent" -> score 1
    ])
  })

  it('returns [] when the query has no usable tokens', () => {
    expect(search(idx, '  , .', 10)).toEqual([])
  })

  it('returns [] when nothing matches', () => {
    expect(search(idx, 'zzzznomatch', 10)).toEqual([])
  })

  it('honours the limit', () => {
    expect(search(idx, 'agent', 1)).toHaveLength(1)
  })

  it('filters by concept type', () => {
    const res = search(idx, 'agent', 10, 'rule')
    expect(res.map(c => c.slug)).toEqual(['rules/agent/ponytail'])
  })

  it('matches on slug tokens as well as title/description/tags', () => {
    const res = search(idx, 'ponytail', 10)
    expect(res.map(c => c.slug)).toEqual(['rules/agent/ponytail'])
  })
})

describe('read', () => {
  it('renders markdown for an existing slug', async () => {
    const md = await read(idx, 'rules/agent/ponytail', SITE)
    expect(md).toContain('# Ponytail Rule')
    expect(md).toContain('Type: rule')
    expect(md).toContain('Tags: agent, style')
    expect(md).toContain('Timestamp: 2026-01-01')
    expect(md).toContain(`Full HTML: ${SITE}/rules/agent/ponytail.html`)
    expect(md).toContain('Body of ponytail.')
  })

  it('strips leading slashes and .md/.html extensions from the slug', async () => {
    const md = await read(idx, '/rules/agent/ponytail.md', SITE)
    expect(md).toContain('# Ponytail Rule')
  })

  it('omits the timestamp line and body when absent', async () => {
    const md = await read(idx, 'glossary/okf', SITE)
    expect(md).not.toContain('Timestamp:')
    expect(md?.endsWith('\n\n')).toBe(true)
  })

  it('returns null for an unknown slug', async () => {
    expect(await read(idx, 'does/not/exist', SITE)).toBeNull()
  })
})

describe('listConcepts', () => {
  it('returns all concepts up to the default limit', () => {
    expect(listConcepts(idx)).toHaveLength(3)
  })

  it('filters by type', () => {
    expect(listConcepts(idx, 'decision').map(c => c.slug)).toEqual([
      'decisions/agent-tooling/fleet',
    ])
  })

  it('filters by tag', () => {
    expect(listConcepts(idx, undefined, 'glossary').map(c => c.slug)).toEqual([
      'glossary/okf',
    ])
  })

  it('filters by type and tag together', () => {
    expect(listConcepts(idx, 'rule', 'style').map(c => c.slug)).toEqual([
      'rules/agent/ponytail',
    ])
    expect(listConcepts(idx, 'rule', 'nope')).toEqual([])
  })

  it('honours the limit', () => {
    expect(listConcepts(idx, undefined, undefined, 1)).toHaveLength(1)
  })
})

describe('related', () => {
  it('returns direct neighbours at depth 1 (excluding the seed)', () => {
    const res = related(idx, 'rules/agent/ponytail', 1)
    expect(res.map(c => c.slug)).toEqual(['decisions/agent-tooling/fleet'])
  })

  it('traverses transitively at greater depth without revisiting nodes', () => {
    const res = related(idx, 'rules/agent/ponytail', 2)
    const slugs = res.map(c => c.slug).sort()
    // ponytail -> fleet -> {ponytail(seen), okf}
    expect(slugs).toEqual(['decisions/agent-tooling/fleet', 'glossary/okf'])
    // the seed itself is never emitted
    expect(slugs).not.toContain('rules/agent/ponytail')
  })

  it('returns [] for an unknown seed slug', () => {
    expect(related(idx, 'nope', 2)).toEqual([])
  })

  it('returns [] for a leaf with no related edges', () => {
    expect(related(idx, 'glossary/okf', 1)).toEqual([])
  })
})
