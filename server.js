import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const MAILPIT_URL = (process.env.MAILPIT_URL ?? "http://localhost:8025").replace(/\/$/, "");
// "http" (network service, default) or "stdio" (spawned directly by an MCP client)
const TRANSPORT = process.env.MCP_TRANSPORT ?? "http";
const PORT = Number(process.env.MCP_HTTP_PORT ?? 3000);
// When set, every /mcp request must carry "Authorization: Bearer <token>"
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() || null;
// Credentials for Mailpit itself, when its API is behind basic auth (--ui-auth-file)
const MAILPIT_BASIC_AUTH =
  process.env.MAILPIT_AUTH_USER && process.env.MAILPIT_AUTH_PASS
    ? `Basic ${Buffer.from(`${process.env.MAILPIT_AUTH_USER}:${process.env.MAILPIT_AUTH_PASS}`).toString("base64")}`
    : null;

async function mailpit(path, options = {}) {
  const res = await fetch(`${MAILPIT_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(MAILPIT_BASIC_AUTH ? { Authorization: MAILPIT_BASIC_AUTH } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Mailpit API ${options.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asResult(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function buildServer() {
  const server = new McpServer({ name: "mailpit", version: "1.0.0" });

  server.registerTool(
    "list_messages",
    {
      title: "List messages",
      description: "List messages in the Mailpit mailbox, newest first",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25).describe("Max messages to return"),
        start: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
    },
    async ({ limit, start }) => asResult(await mailpit(`/api/v1/messages?limit=${limit}&start=${start}`)),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        'Search messages. Supports Mailpit search syntax, e.g. `from:user@example.com`, `subject:"welcome"`, `is:unread`, `tag:invoice`',
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max messages to return"),
      },
    },
    async ({ query, limit }) =>
      asResult(await mailpit(`/api/v1/search?query=${encodeURIComponent(query)}&limit=${limit}`)),
  );

  server.registerTool(
    "get_message",
    {
      title: "Get message",
      description: "Get a full message by ID, including headers, text and HTML bodies, and attachment metadata",
      inputSchema: {
        id: z.string().min(1).describe("Message ID (from list_messages/search_messages), or `latest`"),
      },
    },
    async ({ id }) => asResult(await mailpit(`/api/v1/message/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "get_message_headers",
    {
      title: "Get message headers",
      description: "Get the raw headers of a message by ID",
      inputSchema: {
        id: z.string().min(1).describe("Message ID, or `latest`"),
      },
    },
    async ({ id }) => asResult(await mailpit(`/api/v1/message/${encodeURIComponent(id)}/headers`)),
  );

  server.registerTool(
    "delete_messages",
    {
      title: "Delete messages",
      description: "Delete specific messages by ID, or ALL messages when no IDs are given",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("Message IDs to delete; omit to delete all messages"),
      },
    },
    async ({ ids }) => {
      await mailpit("/api/v1/messages", {
        method: "DELETE",
        body: JSON.stringify(ids?.length ? { IDs: ids } : {}),
      });
      return asResult(ids?.length ? `Deleted ${ids.length} message(s)` : "Deleted all messages");
    },
  );

  server.registerTool(
    "get_mailbox_info",
    {
      title: "Mailbox info",
      description: "Get Mailpit runtime info: version, message count, unread count, database size",
      inputSchema: {},
    },
    async () => asResult(await mailpit("/api/v1/info")),
  );

  return server;
}

async function startStdio() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol in stdio mode — log to stderr only
  console.error(`Mailpit MCP server on stdio, proxying ${MAILPIT_URL}`);
}

async function startHttp() {
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());

  app.use("/mcp", (req, res, next) => {
    if (!AUTH_TOKEN) return next();
    const header = req.headers.authorization ?? "";
    if (header === `Bearer ${AUTH_TOKEN}`) return next();
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  });

  // Stateless streamable HTTP: fresh server+transport per request
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.get("/healthz", (req, res) => res.json({ status: "ok", mailpit: MAILPIT_URL }));

  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `Mailpit MCP server listening on :${PORT}/mcp, proxying ${MAILPIT_URL}, auth: ${AUTH_TOKEN ? "bearer token required" : "disabled"}`,
    );
  });
}

if (TRANSPORT === "stdio") {
  await startStdio();
} else if (TRANSPORT === "http") {
  await startHttp();
} else {
  console.error(`Unknown MCP_TRANSPORT "${TRANSPORT}" — use "http" or "stdio"`);
  process.exit(1);
}
