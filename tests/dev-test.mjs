/**
 * Local smoke test — boots the bridge over stdio exactly like a real MCP client would,
 * then exercises the paths that can only be validated against a live instance.
 *
 *   node --env-file=.env dev-test.mjs
 *   node --env-file=.env dev-test.mjs --reset   # clear cached tokens first (forces browser auth)
 *
 * Not shipped in the npm package (see "files" in package.json) and gitignored.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE = path.join(os.homedir(), ".sn-mcp-bridge", "tokens.json");
const SESSION_TOOLS = ["execute_script", "explore_syslog", "explore_syslog_transaction", "explore_node_logs"];

if (process.argv.includes("--reset")) {
	fs.rmSync(CACHE, { force: true });
	console.log("• cleared cached tokens — a browser authorization will be required\n");
}

const instance = process.env.SN_INSTANCE;
if (!instance) {
	console.error("SN_INSTANCE is not set. Did you create .env and pass --env-file=.env?");
	process.exit(1);
}

const inst = new URL(instance).hostname.split(".")[0].toUpperCase().replace(/-/g, "_");
const pick = (n) => process.env[`SN_${inst}_${n}`] || process.env[`SN_${n}`];
const expectOAuth = Boolean(pick("CLIENT_ID"));
const expectSession = Boolean(pick("USERNAME") && pick("PASSWORD"));

console.log(`instance     ${instance}`);
console.log(`env prefix   SN_${inst}_`);
console.log(`expecting    ${expectOAuth ? "oauth" : "basic"} auth, session tools ${expectSession ? "enabled" : "disabled"}\n`);

const env = { PATH: process.env.PATH, HOME: process.env.HOME };
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("SN_")) env[k] = v;

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [path.join(import.meta.dirname, "..", "src", "index.js")],
	env,
	stderr: "inherit", // surfaces the authorize URL and the startup banner
});

const client = new Client({ name: "dev-test", version: "1.0.0" });

const checks = [];
const record = (name, passed, detail) => {
	checks.push({ name, passed });
	console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
	console.log("connecting (first OAuth run opens your browser — approve the prompt)…\n");
	await client.connect(transport);
	record("server started", true);

	// 1. Tool registration reflects the configured auth mode.
	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name);
	const present = SESSION_TOOLS.filter((t) => names.includes(t));
	record(
		"session tools gated correctly",
		expectSession ? present.length === SESSION_TOOLS.length : present.length === 0,
		`${names.length} tools total, session tools present: ${present.length}/${SESSION_TOOLS.length}`
	);

	// 2. A real authenticated Table API read.
	const q = await client.callTool({
		name: "query_data",
		arguments: { table: "sys_user", limit: 2, fields: ["user_name", "name"] },
	});
	const qText = q.content?.[0]?.text ?? "";
	record("query_data on sys_user", !q.isError, q.isError ? qText.slice(0, 200) : `returned ${qText.length} bytes`);

	// 3. Confirm who the token actually authenticates as — the single best signal that the
	//    bearer token is being honored by the instance rather than an anonymous fallback.
	const who = await client.callTool({
		name: "query_data",
		arguments: { table: "sys_user", query: "sys_id=javascript:gs.getUserID()", fields: ["user_name", "name", "time_zone"], limit: 1 },
	});
	const whoText = who.content?.[0]?.text ?? "";
	record("resolved authenticated user", !who.isError, who.isError ? whoText.slice(0, 200) : whoText.replace(/\s+/g, " ").slice(0, 160));

	// 4. Session path, only when credentials for it were supplied.
	if (expectSession) {
		const s = await client.callTool({ name: "execute_script", arguments: { script: "gs.print('sn-mcp-bridge oauth smoke test');" } });
		const sText = s.content?.[0]?.text ?? "";
		record("execute_script (form-login session)", !s.isError && sText.includes("smoke test"), sText.replace(/\s+/g, " ").slice(0, 160));
	}

	// 5. Token cache written with owner-only permissions.
	if (expectOAuth) {
		try {
			const mode = (fs.statSync(CACHE).mode & 0o777).toString(8);
			const keys = Object.keys(JSON.parse(fs.readFileSync(CACHE, "utf8")));
			record("token cache secured", mode === "600", `mode ${mode}, entries: ${keys.join(", ")}`);
		} catch (e) {
			record("token cache secured", false, e.message);
		}
	}
} catch (error) {
	record("run completed without throwing", false, error.message);
} finally {
	await client.close().catch(() => {});
}

const failed = checks.filter((c) => !c.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (expectOAuth && !failed) console.log("Re-run without --reset — it should start silently, with no browser prompt.");
process.exit(failed ? 1 : 0);
