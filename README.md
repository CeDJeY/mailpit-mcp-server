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
| `get_message_source` | Full raw RFC-822 source (headers + MIME parts) |
| `get_attachment` | Download an attachment — images returned as images, text as text, other as base64 |
| `check_html` | HTML compatibility analysis across email clients |
| `get_message_links` | Extract all URLs without requesting them — safe retrieval of confirmation/reset/unsubscribe links for e2e flows |
| `check_links` | Verify links by requesting them (real GETs — may trigger one-click actions; auth-protected links can return 302/401/403 without being broken) |
| `send_message` | Compose and inject a test email via the Mailpit API (captured, not delivered) |
| `send_smtp_message` | Send over a REAL SMTP transaction (as applications do) to prove the SMTP channel works end-to-end |
| `wait_for_message` | Poll until a new (optionally matching) message arrives — great for e2e flows |
| `set_read_status` | Mark messages read/unread, by ID or all |
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
    image: ghcr.io/cedjey/mailpit-mcp-server:2
    ports:
      - "3000:3000"   # MCP endpoint: http://localhost:3000/mcp
    environment:
      MAILPIT_URL: http://mailpit:8025
      # Required: where applications send SMTP, as reachable by them
      MAILPIT_SMTP_ENDPOINT: localhost:1025
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
  -e MAILPIT_SMTP_ENDPOINT=your-mailpit-host:1025 \
  -e MCP_AUTH_TOKEN=your-secret-token \
  ghcr.io/cedjey/mailpit-mcp-server:2
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
        "-e", "MAILPIT_SMTP_ENDPOINT=localhost:1025",
        "ghcr.io/cedjey/mailpit-mcp-server:2"]
    }
  }
}
```

Or without Docker (Node 20+): clone the repo, `npm ci`, and use `"command": "node", "args": ["/path/to/server.js"]` with `MCP_TRANSPORT=stdio`.

## Built-in agent context

The server ships the context an AI agent needs — no extra prompting required by consumers:

- **Server instructions** (delivered via the MCP initialize handshake): what the mailbox is, the standard workflows (inspect, e2e wait-then-verify, template QA, attachments), search syntax, and warnings — clients inject these into the model's context automatically.
- **Tool annotations**: the ten read-only tools carry `readOnlyHint`, `delete_messages` carries `destructiveHint` — clients can auto-approve reads and gate deletes.
- **MCP prompts**: `verify_email` (wait for a message matching a query, then verify structure, links and client compatibility against an optional checklist) and `inspect_mailbox` (summarize mailbox state, flag anomalies). Claude Code exposes these as slash commands.

## Claude Code plugin

The easiest way to use this from Claude Code — one install, prompted for your endpoint and token, no manual MCP or skill setup:

```
/plugin marketplace add CeDJeY/mailpit-mcp-server
/plugin install mailpit@cedjey
```

On enable, Claude Code asks for:
- **Mailpit MCP endpoint URL** — e.g. `http://your-host:3000/mcp`
- **Bearer token** — the server's `MCP_AUTH_TOKEN` (leave empty if auth is disabled)

The plugin bundles the MCP connection plus two skills:

- **`verify-email`** — the verification workflow: wait for the email, inspect structure, extract links safely, check HTML compatibility, report a PASS/FAIL verdict.
- **`route-mail-to-mailpit`** — the prerequisite the verification depends on: configure the application under test to send SMTP to Mailpit, prove it with a canary email, and flag configurations that could leak test mail to real SMTP providers.

Plugin source lives in [plugin/](plugin/); non-plugin users can copy the [skills](plugin/skills/) into their project's `.claude/skills/` manually.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MAILPIT_URL` | `http://localhost:8025` | Base URL of the Mailpit instance |
| `MCP_TRANSPORT` | `http` | `http` (network service) or `stdio` (spawned by client) |
| `MCP_HTTP_PORT` | `3000` | Port for the HTTP endpoint |
| `MCP_AUTH_TOKEN` | *(empty = auth off)* | When set, `/mcp` requires `Authorization: Bearer <token>` |
| `MAILPIT_AUTH_USER` / `MAILPIT_AUTH_PASS` | *(none)* | Basic-auth credentials if Mailpit's API is protected |
| `MAILPIT_SMTP_ENDPOINT` | **required** | SMTP `host:port` applications must send to (as reachable by them); exposed to agents via `get_mailbox_info` (`SMTPEndpoint`) and the server instructions for routing checks, and used as `send_smtp_message`'s default target. The server refuses to start without it (`MAILPIT_SMTP_ADVERTISE` still accepted as a deprecated alias) |

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
