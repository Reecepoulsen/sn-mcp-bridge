/**
 * Live-instance test for the code management tools — boots the bridge over stdio like a real MCP
 * client and drives get_dev_context / switch_dev_context / create_update_set / list_update_sets /
 * get_update_set_contents / set_update_set_state / batch_update_sets.
 *
 *   node --env-file=.env tests/dev-context-test.mjs
 *
 * Writes to the instance. It creates throwaway update sets in a disposable scope, restores the
 * calling user's original scope and update set at the end, and deletes what it created. Point
 * TEST_SCOPE at a scope you do not care about before running.
 *
 * Not shipped in the npm package (see "files" in package.json).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const TEST_SCOPE = "x_500909_tstclaude";
const OTHER_SCOPE = "x_500909_test_2";
const BASE_SET_NAME = "ZZ-MCP-BRIDGE-TEST-BASE";
const CHILD_SET_NAME = "ZZ-MCP-BRIDGE-TEST-CHILD";
const OTHER_SET_NAME = "ZZ-MCP-BRIDGE-TEST-OTHER-SCOPE";

const NEW_TOOLS = [
	"get_dev_context", "switch_dev_context", "create_update_set",
	"list_update_sets", "get_update_set_contents", "set_update_set_state", "batch_update_sets",
];

if (!process.env.SN_INSTANCE) {
	console.error("SN_INSTANCE is not set. Did you pass --env-file=.env?");
	process.exit(1);
}

const env = { PATH: process.env.PATH, HOME: process.env.HOME };
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("SN_")) env[k] = v;

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [path.join(import.meta.dirname, "..", "src", "index.js")],
	env,
	stderr: "inherit",
});

const client = new Client({ name: "dev-context-test", version: "1.0.0" });

const checks = [];
const record = (name, passed, detail) => {
	checks.push({ name, passed });
	console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * @name call
 * @description Invokes a tool and parses its JSON payload.
 * @param {string} name - The tool name
 * @param {object} [args] - Tool arguments
 * @returns {{isError: boolean, text: string, json: object|null}} The tool result
 */
async function call(name, args = {}) {
	const response = await client.callTool({ name, arguments: args });
	const text = response.content?.[0]?.text ?? "";
	let json = null;
	try { json = JSON.parse(text); } catch { /* error results are plain text */ }
	return { isError: Boolean(response.isError), text, json };
}

/** Update sets created by this run, newest first, so cleanup can unwind them. */
const created = [];
let baseline = null;

try {
	console.log(`instance ${process.env.SN_INSTANCE}\ntest scope ${TEST_SCOPE}\n`);
	await client.connect(transport);

	// 1. Registration
	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name);
	const missing = NEW_TOOLS.filter((t) => !names.includes(t));
	record("code management tools registered", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${names.length} tools total`);

	// 2. Baseline context
	const context = await call("get_dev_context");
	baseline = context.json;
	record(
		"get_dev_context reports scope and update set",
		!context.isError && Boolean(baseline?.scope?.sys_id) && "ready_to_write" in (baseline || {}),
		baseline ? `scope ${baseline.scope.scope}, set '${baseline.update_set?.name}', ready_to_write ${baseline.ready_to_write}` : context.text.slice(0, 160)
	);

	// 3. create_update_set switches scope so the platform stamps the right application
	const base = await call("create_update_set", { name: BASE_SET_NAME, scope: TEST_SCOPE, description: "sn-mcp-bridge test — safe to delete" });
	if (base.json?.created?.sys_id) created.unshift(base.json.created.sys_id);
	record(
		"create_update_set stamps the requested scope",
		!base.isError && base.json?.context?.scope?.scope === TEST_SCOPE && base.json?.made_current === true,
		base.isError ? base.text.slice(0, 200) : `application ${base.json.created.application}, current set '${base.json.context.update_set?.name}'`
	);

	// 4. makeCurrent:false must leave the caller where it found them
	const other = await call("create_update_set", { name: OTHER_SET_NAME, scope: OTHER_SCOPE, makeCurrent: false });
	if (other.json?.created?.sys_id) created.unshift(other.json.created.sys_id);
	record(
		"create_update_set with makeCurrent:false restores scope",
		!other.isError && other.json?.context?.scope?.scope === TEST_SCOPE && other.json?.created?.application !== undefined,
		other.isError ? other.text.slice(0, 200) : `created in ${other.json.created.application}, still in ${other.json.context.scope.scope}`
	);

	// 5. list_update_sets
	const list = await call("list_update_sets", { scope: TEST_SCOPE, state: "in progress" });
	record(
		"list_update_sets returns the new set with a change count",
		!list.isError && (list.json?.update_sets || []).some((s) => s.name === BASE_SET_NAME && s.change_count === 0),
		list.isError ? list.text.slice(0, 200) : `${list.json.count} sets in ${TEST_SCOPE}`
	);

	// 6. get_update_set_contents against a set that already has history
	const contents = await call("get_update_set_contents", { updateSet: baseline.update_set?.sys_id ?? BASE_SET_NAME, includeBatchChildren: true, limit: 20 });
	record(
		"get_update_set_contents groups changes by type",
		!contents.isError && typeof contents.json?.changes_by_type === "object" && "change_count" in contents.json,
		contents.isError ? contents.text.slice(0, 200) : `${contents.json.change_count} changes, types: ${Object.keys(contents.json.changes_by_type).join(", ") || "none"}`
	);

	// 7. Batching — parent is written, base_update_set is left to the platform
	const child = await call("create_update_set", { name: CHILD_SET_NAME, scope: TEST_SCOPE, makeCurrent: false });
	if (child.json?.created?.sys_id) created.unshift(child.json.created.sys_id);

	const batched = await call("batch_update_sets", { base: base.json.created.sys_id, children: [child.json.created.sys_id] });
	const childInBatch = (batched.json?.batch || []).find((s) => s.sys_id === child.json?.created?.sys_id);
	record(
		"batch_update_sets sets parent and the platform derives Batch Base",
		!batched.isError && childInBatch?.parent === base.json.created.sys_id && childInBatch?.base_update_set === base.json.created.sys_id,
		batched.isError ? batched.text.slice(0, 200) : `parent ${childInBatch?.parent}, base_update_set ${childInBatch?.base_update_set}`
	);

	// 8. Negative cases
	const noArgs = await call("switch_dev_context", {});
	record("switch_dev_context rejects an empty call", noArgs.isError, noArgs.text.slice(0, 120));

	const crossScope = await call("switch_dev_context", { scope: TEST_SCOPE, updateSet: other.json.created.sys_id });
	record("switch_dev_context rejects a cross-scope update set", crossScope.isError, crossScope.text.slice(0, 160));

	const selfParent = await call("batch_update_sets", { base: base.json.created.sys_id, children: [base.json.created.sys_id] });
	record("batch_update_sets rejects self-parenting", selfParent.isError, selfParent.text.slice(0, 120));

	// 9. Completing, and the refusal to reopen
	const completed = await call("set_update_set_state", { updateSet: other.json.created.sys_id, state: "complete" });
	record(
		"set_update_set_state completes and warns about the empty set",
		!completed.isError && completed.json?.update_set?.state === "complete" && (completed.json?.warnings || []).some((w) => w.includes("no captured changes")),
		completed.isError ? completed.text.slice(0, 200) : `warnings: ${(completed.json.warnings || []).length}`
	);

	const reopen = await call("switch_dev_context", { updateSet: other.json.created.sys_id });
	record("switch_dev_context refuses a completed update set", reopen.isError, reopen.text.slice(0, 160));

	const recomplete = await call("set_update_set_state", { updateSet: other.json.created.sys_id, state: "complete" });
	record("set_update_state rejects a no-op state change", recomplete.isError, recomplete.text.slice(0, 120));
} catch (error) {
	record("run completed without throwing", false, error.message);
} finally {
	// Cleanup: unbatch, restore the caller's original context, then delete what we made.
	try {
		if (created.length > 1) {
			await call("batch_update_sets", { base: created[created.length - 1], children: created.slice(0, -1), action: "remove" }).catch(() => {});
		}

		if (baseline?.scope?.sys_id && baseline?.update_set?.sys_id) {
			const restored = await call("switch_dev_context", { scope: baseline.scope.sys_id, updateSet: baseline.update_set.sys_id });
			record(
				"original context restored",
				!restored.isError && restored.json?.context?.update_set?.sys_id === baseline.update_set.sys_id,
				restored.isError ? restored.text.slice(0, 160) : `${restored.json.context.scope.scope} / '${restored.json.context.update_set.name}'`
			);
		}

		let deleted = 0;
		for (const sysId of created) {
			const result = await call("delete_record", { table: "sys_update_set", sysId });
			if (!result.isError) deleted++;
			else console.log(`      note: could not delete update set ${sysId} — ${result.text.slice(0, 120)}`);
		}
		record("test update sets deleted", deleted === created.length, `${deleted}/${created.length}`);
	} catch (error) {
		record("cleanup completed", false, error.message);
	}

	await client.close().catch(() => {});
}

const failed = checks.filter((c) => !c.passed).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
