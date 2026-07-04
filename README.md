# mailpit-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for [Mailpit](https://mailpit.axllent.org/), the email & SMTP testing tool. It lets AI assistants (Claude Code, Claude Desktop, Cursor, VS Code, …) read, search and manage the emails your application sends during development and testing.

- **Streamable HTTP transport** — run it as a network service next to Mailpit (Docker Compose friendly), or
- **stdio transport** — let your MCP client spawn it locally
- **Bearer-token auth** for the HTTP endpoint, so it can safely sit behind a tunnel/reverse proxy
- Single small dependency surface: the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), Express and Zod

## Tools

| Tool | Description |
|---|---|
| `list_messages` | List mailbox messages, newest first (paginated) |
| `search_messages` | Search with Mailpit query syntax (`from:`, `subject:`, `is:unread`, `tag:` …) |
| `get_message` | Full message by ID or `latest` — headers, text/HTML bodies, attachment metadata |
| `get_message_headers` | Raw headers of a message |
| `delete_messages` | Delete messages by ID, or all messages |
| `get_mailbox_info` | Mailpit version, message/unread counts, database size |

## Quick start (Docker Compose)

```yaml
services:
  mailpit:
    image: axllent/mailpit:latest
    ports:
      - "8025:8025"   # web UI
      - "1025:1025"   # SMTP
    healthcheck:
      test: ["CMD", "/mailpit", "readyz"]
      interval: 30s
      start_period: 10s

  mailpit-mcp:
    image: ghcr.io/cedjey/mailpit-mcp-server:1
    ports:
      - "3000:3000"   # MCP endpoint: http://localhost:3000/mcp
    environment:
      MAILPIT_URL: http://mailpit:8025
      # Recommended: require "Authorization: Bearer <token>" on /mcp
      # MCP_AUTH_TOKEN: your-secret-token
    depends_on:
      mailpit:
        condition: service_healthy
```

Or standalone against an existing Mailpit:

```bash
docker run -d -p 3000:3000 \
  -e MAILPIT_URL=http://your-mailpit-host:8025 \
  -e MCP_AUTH_TOKEN=your-secret-token \
  ghcr.io/cedjey/mailpit-mcp-server:1
```

## Connecting clients

**Claude Code:**

```bash
claude mcp add --transport http mailpit http://localhost:3000/mcp \
  --header "Authorization: Bearer your-secret-token"
```

**`.mcp.json` / Cursor / VS Code:**

```json
{
  "mcpServers": {
    "mailpit": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${MAILPIT_MCP_TOKEN}" }
    }
  }
}
```

**Claude Desktop (stdio):**

```json
{
  "mcpServers": {
    "mailpit": {
      "command": "docker",
      "args": ["run", "-i", "--rm",
        "-e", "MCP_TRANSPORT=stdio",
        "-e", "MAILPIT_URL=http://host.docker.internal:8025",
        "ghcr.io/cedjey/mailpit-mcp-server:1"]
    }
  }
}
```

Or without Docker (Node 20+): clone the repo, `npm ci`, and use `"command": "node", "args": ["/path/to/server.js"]` with `MCP_TRANSPORT=stdio`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MAILPIT_URL` | `http://localhost:8025` | Base URL of the Mailpit instance |
| `MCP_TRANSPORT` | `http` | `http` (network service) or `stdio` (spawned by client) |
| `MCP_HTTP_PORT` | `3000` | Port for the HTTP endpoint |
| `MCP_AUTH_TOKEN` | *(empty = auth off)* | When set, `/mcp` requires `Authorization: Bearer <token>` |
| `MAILPIT_AUTH_USER` / `MAILPIT_AUTH_PASS` | *(none)* | Basic-auth credentials if Mailpit's API is protected |

The HTTP mode also serves `GET /healthz` (no auth) for container healthchecks.

## Security notes

Mailpit captures every email your app sends — treat the MCP endpoint as sensitive. Set `MCP_AUTH_TOKEN` whenever the port is reachable beyond localhost, and prefer keeping it off the public internet (private network, VPN, or an authenticated tunnel). `delete_messages` is destructive; scope access accordingly.

## Development

```bash
npm ci
MAILPIT_URL=http://localhost:8025 npm start   # HTTP mode on :3000
node mcp-test.js                              # e2e check against a running server
```

`mcp-test.js` honours `MCP_URL` and `MCP_AUTH_TOKEN`.

## License

[MIT](LICENSE)
