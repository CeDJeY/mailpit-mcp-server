import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { version: VERSION } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

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
  const server = new McpServer({ name: "mailpit", version: VERSION });

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

  server.registerTool(
    "get_message_source",
    {
      title: "Get raw message source",
      description: "Get the full raw RFC-822 source of a message (headers + MIME parts), useful for debugging encoding issues",
      inputSchema: {
        id: z.string().min(1).describe("Message ID, or `latest`"),
      },
    },
    async ({ id }) => asResult(await mailpit(`/api/v1/message/${encodeURIComponent(id)}/raw`)),
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Get attachment",
      description:
        "Download a message attachment by part ID (from get_message's Attachments list). Images are returned as images, text as text, other types as base64",
      inputSchema: {
        id: z.string().min(1).describe("Message ID, or `latest`"),
        part_id: z.string().min(1).describe("Attachment PartID from get_message"),
      },
    },
    async ({ id, part_id }) => {
      const res = await fetch(
        `${MAILPIT_URL}/api/v1/message/${encodeURIComponent(id)}/part/${encodeURIComponent(part_id)}`,
        { headers: MAILPIT_BASIC_AUTH ? { Authorization: MAILPIT_BASIC_AUTH } : {} },
      );
      if (!res.ok) {
        throw new Error(`Mailpit API GET part ${part_id} failed: ${res.status} ${await res.text()}`);
      }
      const type = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) {
        throw new Error(`Attachment is ${buf.length} bytes — too large to return (2MB limit)`);
      }
      if (type.startsWith("image/")) {
        return { content: [{ type: "image", data: buf.toString("base64"), mimeType: type }] };
      }
      if (/^text\/|[/+](json|xml|javascript|csv)$/.test(type)) {
        return asResult(buf.toString("utf8"));
      }
      return asResult(`Binary attachment (${type}, ${buf.length} bytes), base64:\n${buf.toString("base64")}`);
    },
  );

  server.registerTool(
    "check_html",
    {
      title: "Check HTML compatibility",
      description: "Analyze a message's HTML for compatibility across email clients (which features are supported where)",
      inputSchema: {
        id: z.string().min(1).describe("Message ID, or `latest`"),
      },
    },
    async ({ id }) => asResult(await mailpit(`/api/v1/message/${encodeURIComponent(id)}/html-check`)),
  );

  server.registerTool(
    "check_links",
    {
      title: "Check links",
      description: "Extract all links from a message and optionally verify them (detect broken links)",
      inputSchema: {
        id: z.string().min(1).describe("Message ID, or `latest`"),
        follow: z.boolean().default(false).describe("Actually request each link and report HTTP status codes"),
      },
    },
    async ({ id, follow }) =>
      asResult(await mailpit(`/api/v1/message/${encodeURIComponent(id)}/link-check?follow=${follow}`)),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send test message",
      description:
        "Compose and inject a test email into Mailpit via its API (no SMTP client needed). The message is captured by Mailpit, not delivered anywhere",
      inputSchema: {
        from: z.string().email().describe("Sender email address"),
        from_name: z.string().optional().describe("Sender display name"),
        to: z.array(z.string().email()).min(1).describe("Recipient email addresses"),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().describe("Subject line"),
        text: z.string().optional().describe("Plain-text body"),
        html: z.string().optional().describe("HTML body"),
        tags: z.array(z.string()).optional().describe("Mailpit tags to apply"),
      },
    },
    async ({ from, from_name, to, cc, bcc, subject, text, html, tags }) =>
      asResult(
        await mailpit("/api/v1/send", {
          method: "POST",
          body: JSON.stringify({
            From: { Email: from, ...(from_name ? { Name: from_name } : {}) },
            To: to.map((e) => ({ Email: e })),
            ...(cc?.length ? { Cc: cc.map((e) => ({ Email: e })) } : {}),
            ...(bcc?.length ? { Bcc: bcc.map((e) => ({ Email: e })) } : {}),
            Subject: subject,
            ...(text ? { Text: text } : {}),
            ...(html ? { HTML: html } : {}),
            ...(tags?.length ? { Tags: tags } : {}),
          }),
        }),
      ),
  );

  server.registerTool(
    "set_read_status",
    {
      title: "Set read status",
      description: "Mark messages as read or unread, by ID or all messages when no IDs are given",
      inputSchema: {
        read: z.boolean().describe("true = mark read, false = mark unread"),
        ids: z.array(z.string()).optional().describe("Message IDs; omit to apply to all messages"),
      },
    },
    async ({ read, ids }) => {
      await mailpit("/api/v1/messages", {
        method: "PUT",
        body: JSON.stringify({ IDs: ids ?? [], Read: read }),
      });
      return asResult(`Marked ${ids?.length ? `${ids.length} message(s)` : "all messages"} as ${read ? "read" : "unread"}`);
    },
  );

  server.registerTool(
    "wait_for_message",
    {
      title: "Wait for message",
      description:
        "Poll until a NEW message arrives (optionally matching a search query) or the timeout expires. Useful in e2e flows: trigger an action, then wait for the resulting email",
      inputSchema: {
        query: z.string().optional().describe('Mailpit search query to match, e.g. `to:user@example.com subject:"welcome"`; omit for any message'),
        timeout_seconds: z.number().int().min(1).max(120).default(30).describe("How long to wait"),
        accept_recent_seconds: z
          .number()
          .int()
          .min(0)
          .max(300)
          .default(5)
          .describe(
            "Also accept a matching message that arrived up to this many seconds BEFORE the wait started (avoids racing fast emails); 0 = only strictly new messages",
          ),
      },
    },
    async ({ query, timeout_seconds, accept_recent_seconds }) => {
      const newest = async () => {
        const q = query?.trim();
        const data = q
          ? await mailpit(`/api/v1/search?query=${encodeURIComponent(q)}&limit=1`)
          : await mailpit("/api/v1/messages?limit=1");
        return data.messages?.[0] ?? null;
      };
      const initial = await newest();
      // The awaited email may land moments before we take the snapshot — accept it
      if (initial && accept_recent_seconds > 0 && Date.now() - Date.parse(initial.Created) < accept_recent_seconds * 1000) {
        return asResult(initial);
      }
      const deadline = Date.now() + timeout_seconds * 1000;
      while (Date.now() < deadline) {
        await sleep(1000);
        const m = await newest();
        if (m && m.ID !== initial?.ID) return asResult(m);
      }
      throw new Error(`No new message${query ? ` matching "${query}"` : ""} arrived within ${timeout_seconds}s`);
    },
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
