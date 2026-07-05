import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
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
// REQUIRED: SMTP endpoint (host:port) applications must send to for THIS
// Mailpit to capture their mail — exposed to agents via get_mailbox_info and
// used as the default target of send_smtp_message
const SMTP_ENDPOINT =
  process.env.MAILPIT_SMTP_ENDPOINT?.trim() || process.env.MAILPIT_SMTP_ADVERTISE?.trim() || null;
if (!SMTP_ENDPOINT) {
  console.error(
    "MAILPIT_SMTP_ENDPOINT is required: the SMTP host:port applications send mail to, as reachable by them (e.g. mail.internal:2525).",
  );
  process.exit(1);
}
if (!process.env.MAILPIT_SMTP_ENDPOINT && process.env.MAILPIT_SMTP_ADVERTISE) {
  console.error("MAILPIT_SMTP_ADVERTISE is deprecated — rename it to MAILPIT_SMTP_ENDPOINT.");
}
// Optional hard allowlist for send_smtp_message's `endpoint` override (comma-separated
// host:port). Empty = allow any reachable host (the link-local/metadata range is always
// blocked); the configured MAILPIT_SMTP_ENDPOINT is always permitted.
const SMTP_ALLOWLIST = (process.env.MAILPIT_SMTP_ALLOWED_ENDPOINTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
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

// Constant-time bearer comparison: hash both sides to a fixed length so
// timingSafeEqual never throws on a length mismatch and no prefix/length is leaked.
function safeEqual(a, b) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

// Validate and resolve an SMTP target (host:port). Enforces a real port range,
// blocks the link-local/cloud-metadata range (169.254.0.0/16 — never a Mailpit),
// and honours the optional allowlist. Throws on anything invalid or disallowed.
function resolveSmtpTarget(endpoint) {
  const target = endpoint ?? SMTP_ENDPOINT;
  const i = target.lastIndexOf(":");
  const host = target.slice(0, i);
  const port = Number(target.slice(i + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SMTP endpoint "${target}": expected host:port with port 1-65535`);
  }
  if (/^169\.254\./.test(host)) {
    throw new Error(`Refusing to send to link-local address ${host}`);
  }
  if (SMTP_ALLOWLIST.length && target !== SMTP_ENDPOINT && !SMTP_ALLOWLIST.includes(target)) {
    throw new Error(`SMTP endpoint "${target}" is not permitted (set MAILPIT_SMTP_ALLOWED_ENDPOINTS)`);
  }
  return { host, port, target };
}

const INSTRUCTIONS = `Mailpit MCP server — access to a Mailpit test mailbox holding emails captured from the application under test. Nothing here is delivered to real recipients; send_message only injects test data into Mailpit.

IMPORTANT: this mailbox only captures mail sent to its SMTP endpoint: ${SMTP_ENDPOINT}. Before verifying emails, make sure the application under test sends there — if its mail config points elsewhere (another Mailpit instance, a real provider), the emails you wait for will never appear here. To prove the SMTP channel itself works, use send_smtp_message (a real SMTP transaction, exactly like an application) — if the endpoint isn't reachable from the MCP server's own network (e.g. it names localhost or a host-only address), pass its \`endpoint\` parameter with a network-local address such as the Mailpit container hostname (mailpit:1025).

Typical workflows:
- Inspect: list_messages or search_messages → get_message (full bodies + attachment metadata) → get_message_headers / get_message_source for MIME- or encoding-level debugging.
- E2E testing: trigger the action in the app under test, then wait_for_message (e.g. query 'to:user@example.com subject:"welcome"') → get_message with the returned ID → verify content. wait_for_message also accepts messages that arrived up to accept_recent_seconds before the call, so call it right after (not long after) the trigger.
- Template QA (HTML emails): get_message → check_html for email-client compatibility, check_links to detect broken links. Look for unrendered template variables (e.g. {{name}}), missing sections, placeholder images.
- Action links (confirmation, password reset, unsubscribe): get_message_links extracts URLs WITHOUT requesting them — retrieve the link, then open it with your own tooling and session handling. check_links performs real GETs on every link: it may trigger one-click actions, and auth-protected links legitimately return 302/401/403 without being broken.
- Attachments: get_message lists Attachments with their PartID → get_attachment(id, part_id). Images are returned as viewable images; 2MB size cap.

Notes:
- Message IDs come from list/search/wait results; the literal string 'latest' works anywhere an ID is expected.
- Search syntax: from:, to:, subject:"...", is:unread, tag:, has:attachment.
- delete_messages / set_read_status only touch EVERY message when you explicitly pass all:true; omitting ids on its own is refused, so a stray call can't wipe the mailbox.`;

function buildServer() {
  const server = new McpServer({ name: "mailpit", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_messages",
    {
      title: "List messages",
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { destructiveHint: true },
      description:
        "Delete specific messages by ID. To delete EVERY message you must explicitly set `all: true` — omitting `ids` on its own is refused as a safety guard",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("Message IDs to delete"),
        all: z.boolean().optional().describe("Set true to delete ALL messages; required when `ids` is omitted"),
      },
    },
    async ({ ids, all }) => {
      if (ids?.length) {
        await mailpit("/api/v1/messages", { method: "DELETE", body: JSON.stringify({ IDs: ids }) });
        return asResult(`Deleted ${ids.length} message(s)`);
      }
      if (all !== true) {
        throw new Error("Refusing to delete: pass specific `ids`, or set `all: true` to delete every message.");
      }
      await mailpit("/api/v1/messages", { method: "DELETE", body: JSON.stringify({}) });
      return asResult("Deleted all messages");
    },
  );

  server.registerTool(
    "get_mailbox_info",
    {
      title: "Mailbox info",
      annotations: { readOnlyHint: true },
      description:
        "Get Mailpit runtime info: version, message count, unread count, database size — plus SMTPEndpoint, the host:port applications must send mail to for this mailbox to capture it",
      inputSchema: {},
    },
    async () => asResult({ SMTPEndpoint: SMTP_ENDPOINT, ...(await mailpit("/api/v1/info")) }),
  );

  server.registerTool(
    "get_message_source",
    {
      title: "Get raw message source",
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      // NOT readOnlyHint: it performs real GETs and can trigger one-click action
      // links, so clients should gate it rather than auto-approve it.
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        "Verify a message's links by REQUESTING each one and reporting HTTP status codes. Caution: this performs a real GET on every link — one-click action links (unsubscribe, confirmation) may be triggered by it; use get_message_links to retrieve URLs without requesting them. Interpret results with context: auth-protected links legitimately return 302/401/403 without being broken",
      inputSchema: {
        id: z.string().min(1).describe("Message ID, or `latest`"),
        follow: z.boolean().default(false).describe("Follow redirects and report the final status code"),
      },
    },
    async ({ id, follow }) =>
      asResult(await mailpit(`/api/v1/message/${encodeURIComponent(id)}/link-check?follow=${follow}`)),
  );

  server.registerTool(
    "get_message_links",
    {
      title: "Extract links",
      annotations: { readOnlyHint: true },
      description:
        "Extract all URLs from a message's HTML and text bodies WITHOUT requesting any of them (no side effects, works for auth-protected links). Use this to retrieve action links — confirmation, password reset, unsubscribe — for e2e flows where you open the link yourself with proper session handling",
      inputSchema: {
        id: z.string().min(1).describe("Message ID, or `latest`"),
      },
    },
    async ({ id }) => {
      const msg = await mailpit(`/api/v1/message/${encodeURIComponent(id)}`);
      const links = [];
      const seen = new Set();
      const add = (url) => {
        const clean = url.replace(/[.,;:!?)\]]+$/, "");
        if (/^https?:\/\//i.test(clean) && !seen.has(clean)) {
          seen.add(clean);
          links.push(clean);
        }
      };
      for (const m of (msg.HTML ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
      for (const m of (msg.Text ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) add(m[0]);
      return asResult({ count: links.length, links });
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send test message",
      annotations: { readOnlyHint: false, destructiveHint: false },
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
    "send_smtp_message",
    {
      title: "Send via the SMTP channel",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Send an email over a REAL SMTP transaction — exactly what applications do — to prove the SMTP path into this mailbox works end-to-end (unlike send_message, which injects via the HTTP API and proves nothing about SMTP). Defaults to the configured SMTP endpoint; if that address isn't reachable from the MCP server's own network (e.g. it names localhost or a host-only address), pass `endpoint` with a network-local address such as the Mailpit container hostname (mailpit:1025). Confirm capture afterwards with wait_for_message or search_messages",
      inputSchema: {
        from: z.string().email().describe("Sender email address"),
        to: z.array(z.string().email()).min(1).describe("Recipient email addresses"),
        subject: z.string().describe("Subject line"),
        text: z.string().optional().describe("Plain-text body"),
        html: z.string().optional().describe("HTML body"),
        endpoint: z
          .string()
          .regex(/^[^\s:]+:\d+$/, "host:port")
          .optional()
          .describe("SMTP host:port override; defaults to the configured SMTP endpoint"),
      },
    },
    async ({ from, to, subject, text, html, endpoint }) => {
      const { host, port, target } = resolveSmtpTarget(endpoint);
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: false,
        connectionTimeout: 10_000,
        tls: { rejectUnauthorized: false },
      });
      try {
        const info = await transporter.sendMail({ from, to, subject, text, html });
        return asResult({ endpoint: target, messageId: info.messageId, response: info.response });
      } finally {
        transporter.close();
      }
    },
  );

  server.registerTool(
    "set_read_status",
    {
      title: "Set read status",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description:
        "Mark messages as read or unread by ID. To apply to EVERY message you must explicitly set `all: true` — omitting `ids` on its own is refused",
      inputSchema: {
        read: z.boolean().describe("true = mark read, false = mark unread"),
        ids: z.array(z.string()).optional().describe("Message IDs"),
        all: z.boolean().optional().describe("Set true to apply to ALL messages; required when `ids` is omitted"),
      },
    },
    async ({ read, ids, all }) => {
      if (!ids?.length && all !== true) {
        throw new Error("Refusing to update all messages: pass specific `ids`, or set `all: true`.");
      }
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
      annotations: { readOnlyHint: true },
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

  server.registerPrompt(
    "verify_email",
    {
      title: "Verify an expected email",
      description: "Wait for an email matching a query, then verify its structure, links and client compatibility",
      argsSchema: {
        query: z.string().describe('Mailpit search query for the expected email, e.g. to:user@example.com subject:"welcome"'),
        checklist: z.string().optional().describe("What the email must contain (structure/content requirements); omit for a general integrity check"),
      },
    },
    ({ query, checklist }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Verify the email expected in the Mailpit test mailbox. Steps:

1. Call wait_for_message with query \`${query}\` (it also accepts a message that arrived a few seconds ago).
2. Call get_message with the returned ID and review subject, sender, recipients, text and HTML bodies.
3. Call get_message_links to enumerate the URLs. If none look like one-click action links (unsubscribe, confirm, reset), also call check_links with follow=true to detect broken links — but treat 302/401/403 on auth-protected links as expected, not broken. If action links are present, do NOT run check_links (it performs real GETs and could trigger them); verify those URLs by structure instead (correct host, expected path, token present).
4. If the message has an HTML body, call check_html and note compatibility warnings that matter for mainstream clients.
5. Inspect for general defects: unrendered template variables (like {{name}}), placeholder/missing images, empty sections, encoding artifacts.

${checklist ? `Verify against this checklist — every item must be satisfied:\n${checklist}` : "No specific checklist was provided — assess general integrity and structure."}

Finish with a clear verdict: PASS or FAIL, followed by a short list of findings (most severe first). If the email never arrives, report that as a FAIL with the timeout details.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "inspect_mailbox",
    {
      title: "Inspect the mailbox",
      description: "Summarize the current state of the Mailpit mailbox and flag anything unusual",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Give me a summary of the Mailpit test mailbox:

1. Call get_mailbox_info for totals and Mailpit version.
2. Call list_messages (limit 20) and group what you see: senders, subjects, time range, read/unread, tags.
3. Flag anything unusual: repeated identical messages (possible send loop in the app under test), unrendered template variables in snippets, messages with attachments, very large messages.

Keep the summary short and lead with the most notable finding.`,
          },
        },
      ],
    }),
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
    if (safeEqual(header, `Bearer ${AUTH_TOKEN}`)) return next();
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
