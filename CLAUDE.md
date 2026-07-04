# mailpit-mcp-server

MCP server for Mailpit. Single-file Node.js server ([server.js](server.js)) on the official
`@modelcontextprotocol/sdk`, published as a Docker image to GHCR.

## Architecture

- `server.js` — everything: config from env, Mailpit REST client, tool registry, two transports.
  - `http` (default): Express, stateless streamable HTTP at `POST /mcp` (fresh McpServer+transport
    per request), optional bearer auth via `MCP_AUTH_TOKEN`, unauthenticated `GET /healthz`.
  - `stdio` (`MCP_TRANSPORT=stdio`): for clients that spawn the server directly.
    stdout carries the protocol — log to stderr only in this mode.
- `mcp-test.js` — e2e client used by CI and for manual checks. Honours `MCP_URL`, `MCP_AUTH_TOKEN`.
- Tools wrap Mailpit's REST API 1:1; keep the tool set small and high-value. Don't add tools
  speculatively — this project deliberately stays minimal (its broken/abandoned predecessors
  are a cautionary tale).

## Testing

```bash
npm ci
MAILPIT_URL=http://localhost:8025 npm start        # needs a running Mailpit
MCP_URL=http://localhost:3000/mcp node mcp-test.js # get_message(latest) fails on an empty mailbox — seed one first
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the real thing on every push:
Mailpit service container, seeded message, 401-without-token check, full MCP client roundtrip,
Docker build.

## Releasing

1. Bump `version` in [package.json](package.json), commit to `main`, wait for CI green.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. [release.yml](.github/workflows/release.yml) builds multi-arch (amd64/arm64) and pushes
   `ghcr.io/cedjey/mailpit-mcp-server` with semver tags + `latest`.
4. `gh release create vX.Y.Z --title vX.Y.Z --notes "..."` with a short changelog.

The image name is hardcoded lowercase in release.yml (GHCR requires lowercase; don't switch it
back to `${{ github.repository }}`).

## Conventions

- Plain JavaScript (ESM, Node >= 20), no build step, no TypeScript.
- New config = env var with a sane default, documented in the README table.
- Anything that changes the HTTP surface (auth, endpoints) needs a matching CI assertion.
