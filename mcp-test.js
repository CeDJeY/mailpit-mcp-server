// Connects to the MCP endpoint as a real client and reads the mailbox through it
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

const { tools } = await client.listTools();
console.log("Tools:", tools.map((t) => t.name).join(", "));

const info = await client.callTool({ name: "get_mailbox_info", arguments: {} });
console.log("\n--- get_mailbox_info ---\n", info.content[0].text);

const list = await client.callTool({ name: "list_messages", arguments: { limit: 5 } });
console.log("\n--- list_messages ---\n", list.content[0].text);

const latest = await client.callTool({ name: "get_message", arguments: { id: "latest" } });
const msg = JSON.parse(latest.content[0].text);
console.log("\n--- get_message(latest) ---");
console.log("Subject:", msg.Subject);
console.log("From:", msg.From?.Address);
console.log("To:", msg.To?.map((t) => t.Address).join(", "));
console.log("Text body:", msg.Text?.trim());

await client.close();
