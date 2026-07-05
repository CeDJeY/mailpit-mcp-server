// Connects to the MCP endpoint as a real client and exercises the tool surface
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const token = process.env.MCP_AUTH_TOKEN?.trim();
const client = new Client({ name: "mcp-test", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  }),
);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}

const { tools } = await client.listTools();
console.log(`Tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

const instructions = client.getInstructions();
if (!instructions || instructions.length < 100) throw new Error("server instructions missing");
console.log("instructions: present,", instructions.length, "chars");

const del = tools.find((t) => t.name === "delete_messages");
if (!del?.annotations?.destructiveHint) throw new Error("delete_messages missing destructiveHint");
const ro = tools.filter((t) => t.annotations?.readOnlyHint).length;
console.log(`annotations: ${ro} read-only tools, delete_messages is destructive`);

const { prompts } = await client.listPrompts();
console.log(`Prompts (${prompts.length}):`, prompts.map((p) => p.name).join(", "));
const rendered = await client.getPrompt({ name: "verify_email", arguments: { query: "subject:test" } });
if (!rendered.messages?.[0]?.content?.text?.includes("wait_for_message")) throw new Error("verify_email prompt broken");
console.log("verify_email prompt renders OK");

const info = JSON.parse(await call("get_mailbox_info"));
console.log("get_mailbox_info: Mailpit", info.Version, "—", info.Messages, "message(s), SMTP:", info.SMTPEndpoint ?? "(not advertised)");
if (process.env.EXPECT_SMTP_ENDPOINT && info.SMTPEndpoint !== process.env.EXPECT_SMTP_ENDPOINT) {
  throw new Error(`SMTPEndpoint mismatch: got ${info.SMTPEndpoint}, expected ${process.env.EXPECT_SMTP_ENDPOINT}`);
}

const list = JSON.parse(await call("list_messages", { limit: 5 }));
console.log("list_messages:", list.messages_count, "total");

// send a message via the API and verify the full read-path against it
const sent = JSON.parse(
  await call("send_message", {
    from: "mcp-test@example.com",
    from_name: "MCP Test",
    to: ["dest@example.com"],
    subject: "MCP e2e send",
    text: "sent through the MCP send_message tool",
    html: '<p>sent via <a href="https://example.com">MCP</a></p>',
  }),
);
console.log("send_message: ID", sent.ID);

const msg = JSON.parse(await call("get_message", { id: sent.ID }));
console.log("get_message: subject:", msg.Subject, "| from:", msg.From?.Address);

const source = await call("get_message_source", { id: sent.ID });
console.log("get_message_source:", source.split("\r\n")[0] || source.split("\n")[0]);

const htmlCheck = JSON.parse(await call("check_html", { id: sent.ID }));
console.log("check_html: keys:", Object.keys(htmlCheck).join(", "));

const linkCheck = JSON.parse(await call("check_links", { id: sent.ID }));
console.log("check_links: links found:", linkCheck.Links?.length ?? 0);

const extracted = JSON.parse(await call("get_message_links", { id: sent.ID }));
if (!extracted.links?.includes("https://example.com")) throw new Error("get_message_links missed the HTML link");
console.log("get_message_links:", extracted.count, "link(s):", extracted.links.join(", "));

await call("set_read_status", { read: true, ids: [sent.ID] });
console.log("set_read_status: OK");

// delete_messages must refuse the wipe-all path unless explicitly confirmed.
// Safe: this expects an error and deletes nothing.
let refusedDeleteAll = false;
try {
  await call("delete_messages", {});
} catch {
  refusedDeleteAll = true;
}
if (!refusedDeleteAll) throw new Error("delete_messages did not refuse an unconfirmed delete-all");
console.log("delete_messages: refuses unconfirmed delete-all (needs all:true or ids) OK");

// send over the REAL SMTP channel and confirm capture
const smtp = JSON.parse(
  await call("send_smtp_message", {
    from: "smtp-check@example.com",
    to: ["dest@example.com"],
    subject: "SMTP channel check",
    html: "<p>sent over a real SMTP transaction</p>",
    ...(process.env.SMTP_TEST_ENDPOINT ? { endpoint: process.env.SMTP_TEST_ENDPOINT } : {}),
  }),
);
console.log("send_smtp_message:", smtp.response, "via", smtp.endpoint);
const smtpMsg = JSON.parse(await call("wait_for_message", { query: 'subject:"SMTP channel check"', timeout_seconds: 15 }));
console.log("smtp message captured:", smtpMsg.Subject);

// wait_for_message: start waiting, then send — the wait must pick it up
const waitPromise = call("wait_for_message", { query: 'subject:"wait-target"', timeout_seconds: 20 });
await call("send_message", {
  from: "waiter@example.com",
  to: ["dest@example.com"],
  subject: "wait-target arrived",
  text: "triggering the waiter",
});
const waited = JSON.parse(await waitPromise);
console.log("wait_for_message: caught:", waited.Subject);

console.log("\nAll checks passed.");
await client.close();
