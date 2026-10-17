// Live smoke test: calls each tool once against Pendle + public RPCs. Not part of `pnpm test`.
// Usage: node scripts/smoke.mjs <tool> '<json arguments>'
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [tool, json = "{}"] = process.argv.slice(2);
const child = spawn(process.execPath, ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout });
const started = Date.now();
child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: tool, arguments: JSON.parse(json), _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } },
}) + "\n");
for await (const line of lines) {
  const msg = JSON.parse(line);
  if (msg.id !== 1) continue;
  const r = msg.result ?? msg.error;
  console.log(`${tool} (${Date.now() - started} ms) isError=${r?.isError ?? false}`);
  for (const c of r?.content ?? []) console.log("  text:", c.text);
  if (r?.structuredContent) console.log("  structured:", JSON.stringify(r.structuredContent).slice(0, 1500));
  if (msg.error) console.log("  error:", JSON.stringify(msg.error));
  break;
}
child.kill();
