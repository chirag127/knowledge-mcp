# knowledge-mcp

[![Stars](https://img.shields.io/github/stars/chirag127/knowledge-mcp?style=flat-square)](https://github.com/chirag127/knowledge-mcp/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)

Public MCP server exposing [chirag127's OKF knowledge bundle](https://knowledge.oriz.in) over MCP.

Live endpoint: **https://knowledge-mcp.oriz.in/mcp**


**No auth. Free. 793 concept files searchable + readable via `search`, `read`, `list`, `related` tools.**

## Endpoint

```
https://knowledge-mcp.oriz.in/mcp
```

## Client wiring

### Claude Code / Claude Desktop `mcpServers`

```json
{
  "mcpServers": {
    "chirag127-knowledge": {
      "url": "https://knowledge-mcp.oriz.in/mcp"
    }
  }
}
```

### Any MCP client

Streamable HTTP transport, JSON-RPC 2.0 over POST. GET for SSE hello.

## Tools

| Tool | Params | Returns |
|---|---|---|
| `search` | `query: string, limit?: 1-20, type?: enum` | Top-N matching concepts by term-overlap score |
| `read` | `slug: string` | Full concept metadata + body preview |
| `list` | `type?, tag?, limit?: 1-100` | Filtered concept list |
| `related` | `slug: string, depth?: 1-3` | Graph neighbors via `related:` frontmatter |

## Local dev

```bash
npm install
npm run build:index         # rebuild public/index.json from local knowledge/
npm run dev                 # wrangler dev
npm run deploy              # wrangler deploy
```

Set `SOURCE_DIR=/path/to/knowledge` to point at a different bundle.

## Deploy

```bash
npm run deploy
```

Uses `wrangler.toml` — deploys to CF Worker at `knowledge-mcp.oriz.in`.

## Related

- Knowledge bundle: [chirag127/workspace](https://github.com/chirag127/workspace)
- Bundle site: [knowledge.oriz.in](https://knowledge.oriz.in)
- OKF spec: [Google Cloud OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog)
- Decision: [`knowledge-mcp-server-public-2026-07-03`](https://knowledge.oriz.in/decisions/agent-tooling/knowledge-mcp-server-public-2026-07-03.html)

## License

MIT — see LICENSE.
