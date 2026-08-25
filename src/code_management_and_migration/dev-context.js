/**
 * Development context and update set tools.
 *
 * ServiceNow decides the application scope and update set of a change from three per-user rows in
 * sys_user_preference, read at the start of each REST transaction:
 *
 *   apps.current_app                  — sys_scope sys_id; becomes sys_metadata.sys_scope on insert
 *   sys_update_set                    — sys_update_set sys_id; where sys_update_xml rows are written
 *   updateSetForScope<scopeSysId>     — the set last chosen for that scope (no separator in the name)
 *
 * Writing those preferences through the Table API takes effect on the very next call, which is what
 * makes scope/update-set control possible without a UI session. See AI.md in this folder for the
 * verification behind that and for the platform rules these tools enforce.
 */

import { z } from "zod";
import { ok, tableParams } from "../mcp-helpers.js";

// ── Constants ───────────────────────────────────────────────────────────────

const PREF_CURRENT_APP = "apps.current_app";
const PREF_CURRENT_UPDATE_SET = "sys_update_set";

/** The Global application record's sys_id is the literal string "global", not a GUID. */
const GLOBAL_SCOPE_SYS_ID = "global";

const SCOPE_FIELDS = ["sys_id", "scope", "name", "version", "sys_class_name"];

const UPDATE_SET_FIELDS = [
	"sys_id", "name", "state", "application", "is_default", "parent", "base_update_set",
	"description", "release_date", "merged_to", "sys_created_by", "sys_created_on", "sys_updated_on",
];

const UPDATE_XML_FIELDS = [
	"sys_id", "name", "type", "target_name", "action", "update_set", "application",
	"sys_created_on", "sys_created_by",
];

/** Guards against walking a corrupt or self-referential batch hierarchy forever. */
const MAX_BATCH_DEPTH = 10;

/**
 * @name prefNameForScope
 * @description Builds the per-scope "remembered update set" preference name. The scope sys_id is
 * appended raw — there is no separator or delimiter (e.g. "updateSetForScopeglobal").
 * @param {string} scopeSysId - The sys_scope sys_id
 * @returns {string} The preference name
 */
const prefNameForScope = (scopeSysId) => `updateSetForScope${scopeSysId}`;

// ── Query helpers ───────────────────────────────────────────────────────────

/**
 * @name assertQuerySafe
 * @description Rejects values that would break out of an encoded query clause. ServiceNow encoded
 * queries have no escape syntax, so a caret in a user-supplied value has to be refused outright.
 * @param {string} value - The value being interpolated into a query
 * @param {string} label - Parameter name, for the error message
 * @returns {string} The value, unchanged
 */
function assertQuerySafe(value, label) {
	if (typeof value !== "string" || !value.length) {
		throw new Error(`${label} must be a non-empty string`);
	}
	if (value.includes("^")) {
		throw new Error(`${label} cannot contain '^' — ServiceNow encoded queries have no escape for it. Pass a sys_id instead.`);
	}
	return value;
}

/**
 * @name looksLikeSysId
 * @description Whether a reference is a sys_id rather than a human-readable name.
 * @param {string} value - The reference to test
 * @returns {boolean} True for a 32-char hex string or the literal "global"
 */
const looksLikeSysId = (value) => value === GLOBAL_SCOPE_SYS_ID || /^[0-9a-f]{32}$/i.test(value);

/**
 * @name firstResult
 * @description Returns the first record of a Table API response, or null.
 * @param {object} response - The parsed Table API response
 * @returns {object|null} The first record
 */
const firstResult = (response) => response?.result?.[0] || null;

// ── Lookup helpers ──────────────────────────────────────────────────────────

/**
 * @name getCurrentUser
 * @description Resolves the user the REST calls authenticate as. Uses the server-side
 * javascript:gs.getUserID() query so it works identically under basic auth and OAuth.
 * @param {object} client - The SnClient instance
 * @returns {{sys_id: string, user_name: string, name: string}} The calling user
 */
async function getCurrentUser(client) {
	const response = await client.get("/api/now/table/sys_user", {
		sysparm_query: "sys_id=javascript:gs.getUserID()",
		sysparm_fields: "sys_id,user_name,name",
		sysparm_limit: "1",
	});

	const user = firstResult(response);
	if (!user) throw new Error("dev-context: could not resolve the current user via gs.getUserID()");
	return user;
}

/**
 * @name resolveScope
 * @description Resolves an application scope from either a sys_id or a scope name (e.g. "x_myapp").
 * @param {object} client - The SnClient instance
 * @param {string} scopeRef - A sys_scope sys_id or scope name
 * @returns {object} The sys_scope record
 */
async function resolveScope(client, scopeRef) {
	assertQuerySafe(scopeRef, "scope");

	const response = await client.get("/api/now/table/sys_scope", tableParams({
		query: `sys_id=${scopeRef}^ORscope=${scopeRef}`,
		fields: SCOPE_FIELDS,
		limit: 2,
	}));

	const scope = firstResult(response);
	if (!scope) throw new Error(`dev-context: no application scope found for '${scopeRef}' — pass a sys_scope sys_id or a scope name like 'x_myapp' or 'global'`);
	return scope;
}

/**
 * @name resolveUpdateSet
 * @description Resolves an update set from a sys_id or an exact name. Names are not unique across
 * scopes (every scope has a "Default"), so a name lookup that matches more than one set is an error
 * unless a scope narrows it down.
 * @param {object} client - The SnClient instance
 * @param {string} updateSetRef - A sys_update_set sys_id or exact name
 * @param {object} [options]
 * @param {string} [options.scopeSysId] - Restrict a name lookup to this application scope
 * @returns {object} The sys_update_set record
 */
async function resolveUpdateSet(client, updateSetRef, { scopeSysId } = {}) {
	assertQuerySafe(updateSetRef, "updateSet");

	let query = looksLikeSysId(updateSetRef) ? `sys_id=${updateSetRef}` : `name=${updateSetRef}`;
	if (scopeSysId && !looksLikeSysId(updateSetRef)) query += `^application=${scopeSysId}`;

	const response = await client.get("/api/now/table/sys_update_set", tableParams({
		query,
		fields: UPDATE_SET_FIELDS,
		limit: 10,
	}));

	const matches = response?.result || [];
	if (!matches.length) throw new Error(`dev-context: no update set found for '${updateSetRef}'`);

	if (matches.length > 1) {
		const candidates = matches.map((m) => `${m.sys_id} (application ${m.application}, ${m.state})`).join("; ");
		throw new Error(`dev-context: '${updateSetRef}' matches ${matches.length} update sets — pass a sys_id. Candidates: ${candidates}`);
	}

	return matches[0];
}

/**
 * @name getUpdateSetBySysId
 * @description Fetches a single update set, returning null when it no longer exists.
 * @param {object} client - The SnClient instance
 * @param {string} sysId - The sys_update_set sys_id
 * @returns {object|null} The update set record
 */
async function getUpdateSetBySysId(client, sysId) {
	const response = await client.get("/api/now/table/sys_update_set", tableParams({
		query: `sys_id=${sysId}`,
		fields: UPDATE_SET_FIELDS,
		limit: 1,
	}));
	return firstResult(response);
}

/**
 * @name findDefaultUpdateSet
 * @description Finds the in-progress default update set for a scope — the set the platform itself
 * falls back to when no other set is current.
 * @param {object} client - The SnClient instance
 * @param {string} scopeSysId - The sys_scope sys_id
 * @returns {object|null} The default update set
 */
async function findDefaultUpdateSet(client, scopeSysId) {
	const response = await client.get("/api/now/table/sys_update_set", tableParams({
		query: `application=${scopeSysId}^is_default=true^state=in progress`,
		fields: UPDATE_SET_FIELDS,
		limit: 1,
	}));
	return firstResult(response);
}

/**
 * @name countUpdates
 * @description Counts sys_update_xml rows per update set in a single aggregate call. Every requested
 * set is present in the result: a set with no changes is absent from the group-by response, so it is
 * seeded to zero rather than left undefined. Returns null when the stats endpoint is restricted, so
 * callers can tell "no changes" apart from "could not tell".
 * @param {object} client - The SnClient instance
 * @param {string[]} updateSetSysIds - The update sets to count
 * @returns {Record<string, number>|null} Map of update set sys_id → change count, or null
 */
async function countUpdates(client, updateSetSysIds) {
	if (!updateSetSysIds.length) return {};

	const counts = Object.fromEntries(updateSetSysIds.map((sysId) => [sysId, 0]));

	try {
		const response = await client.get("/api/now/stats/sys_update_xml", {
			sysparm_query: `update_setIN${updateSetSysIds.join(",")}`,
			sysparm_count: "true",
			sysparm_group_by: "update_set",
		});

		for (const group of response?.result || []) {
			const key = (group.groupby_fields || []).find((f) => f.field === "update_set")?.value;
			if (key) counts[key] = Number(group.stats?.count ?? 0);
		}
		return counts;
	} catch {
		// sys_package is API-ACL blocked on stock instances and sys_update_xml may be too — a missing
		// count is not worth failing the whole tool over.
		return null;
	}
}

// ── Preference helpers ──────────────────────────────────────────────────────

/**
 * @name readPreference
 * @description Reads one of the caller's user preferences.
 * @param {object} client - The SnClient instance
 * @param {string} userSysId - The sys_user sys_id
 * @param {string} name - The preference name
 * @returns {object|null} The sys_user_preference record
 */
async function readPreference(client, userSysId, name) {
	const response = await client.get("/api/now/table/sys_user_preference", tableParams({
		query: `user=${userSysId}^name=${name}`,
		fields: ["sys_id", "name", "value", "user"],
		limit: 1,
	}));
	return firstResult(response);
}

/**
 * @name upsertPreference
 * @description Sets one of the caller's user preferences, creating the row if it doesn't exist.
 * These are per-user, not per-session — every client authenticated as this user shares them.
 * @param {object} client - The SnClient instance
 * @param {string} userSysId - The sys_user sys_id
 * @param {string} name - The preference name
 * @param {string} value - The value to store
 * @returns {object} The written sys_user_preference record
 */
async function upsertPreference(client, userSysId, name, value) {
	const existing = await readPreference(client, userSysId, name);

	if (existing) {
		const response = await client.patch(`/api/now/table/sys_user_preference/${existing.sys_id}`, { value });
		return response.result;
	}

	const response = await client.post("/api/now/table/sys_user_preference", {
		user: userSysId,
		name,
		value,
		type: "string",
		system: "false",
	});
	return response.result;
}

/**
 * @name applyContext
 * @description Writes all three preferences that define the development context. Scope is never
 * written on its own: changing scope alone makes the platform fall back to that scope's default
 * update set, which silently misfiles the work.
 * @param {object} client - The SnClient instance
 * @param {string} userSysId - The sys_user sys_id
 * @param {string} scopeSysId - The target sys_scope sys_id
 * @param {string} updateSetSysId - The target sys_update_set sys_id
 * @returns {void}
 */
async function applyContext(client, userSysId, scopeSysId, updateSetSysId) {
	await upsertPreference(client, userSysId, PREF_CURRENT_APP, scopeSysId);
	await upsertPreference(client, userSysId, PREF_CURRENT_UPDATE_SET, updateSetSysId);
	await upsertPreference(client, userSysId, prefNameForScope(scopeSysId), updateSetSysId);
}

// ── Context assembly ────────────────────────────────────────────────────────

/**
 * @name buildContext
 * @description Assembles the caller's current scope and update set, plus warnings for every state
 * that would cause a write to land somewhere unexpected.
 * @param {object} client - The SnClient instance
 * @returns {object} The development context report
 */
async function buildContext(client) {
	const user = await getCurrentUser(client);

	const [currentAppPref, currentSetPref] = await Promise.all([
		readPreference(client, user.sys_id, PREF_CURRENT_APP),
		readPreference(client, user.sys_id, PREF_CURRENT_UPDATE_SET),
	]);

	const warnings = [];

	// An absent apps.current_app means the user has never picked a scope — the platform treats that
	// as global rather than as an error.
	const scopeSysId = currentAppPref?.value || GLOBAL_SCOPE_SYS_ID;
	if (!currentAppPref) warnings.push(`No ${PREF_CURRENT_APP} preference is set — the current scope is Global by default.`);

	const scope = await resolveScope(client, scopeSysId).catch(() => null);
	if (!scope) warnings.push(`${PREF_CURRENT_APP} points at '${scopeSysId}', which is not a valid application scope.`);

	const [updateSet, rememberedPref] = await Promise.all([
		currentSetPref?.value ? getUpdateSetBySysId(client, currentSetPref.value) : Promise.resolve(null),
		readPreference(client, user.sys_id, prefNameForScope(scopeSysId)),
	]);

	if (!currentSetPref) {
		warnings.push(`No ${PREF_CURRENT_UPDATE_SET} preference is set — changes will land in the scope's Default update set.`);
	} else if (!updateSet) {
		warnings.push(`${PREF_CURRENT_UPDATE_SET} points at '${currentSetPref.value}', which no longer exists.`);
	}

	// These two are the blocking conditions: a write now would be misfiled.
	let scopeMatches = true;
	let stateUsable = true;

	if (updateSet) {
		if (updateSet.application !== scopeSysId) {
			scopeMatches = false;
			warnings.push(`The current update set belongs to application '${updateSet.application}' but the current scope is '${scopeSysId}'. Switch context before writing — an update set only captures changes for its own scope.`);
		}
		if (updateSet.state !== "in progress") {
			stateUsable = false;
			warnings.push(`The current update set is '${updateSet.state}', not 'in progress'. Completed sets do not capture changes and must never be reopened — create a new set instead.`);
		}
		if (updateSet.is_default === "true") {
			warnings.push("The current update set is the scope's Default set. Changes there are not transportable as a unit — create a named update set for real work.");
		}
		if (updateSet.parent) {
			warnings.push(`The current update set is a child in a batch (parent ${updateSet.parent}). It cannot be committed on its own — the batch base is committed instead.`);
		}
	}

	return {
		user: { sys_id: user.sys_id, user_name: user.user_name, name: user.name },
		scope: scope
			? { sys_id: scope.sys_id, scope: scope.scope, name: scope.name, sys_class_name: scope.sys_class_name }
			: { sys_id: scopeSysId, scope: null, name: null, sys_class_name: null },
		update_set: updateSet || null,
		remembered_update_set_for_scope: rememberedPref?.value || null,
		preference_names: {
			current_app: PREF_CURRENT_APP,
			current_update_set: PREF_CURRENT_UPDATE_SET,
			update_set_for_scope: prefNameForScope(scopeSysId),
		},
		ready_to_write: Boolean(updateSet) && scopeMatches && stateUsable,
		warnings,
	};
}

/**
 * @name collectBatchDescendants
 * @description Walks the parent links downward from a batch base to collect every set in the batch.
 * base_update_set is platform-maintained and can lag, so the parent chain is the reliable source.
 * @param {object} client - The SnClient instance
 * @param {string} rootSysId - The sys_id of the batch base
 * @returns {object[]} Descendant update sets, nearest level first
 */
async function collectBatchDescendants(client, rootSysId) {
	const descendants = [];
	const seen = new Set([rootSysId]);
	let frontier = [rootSysId];

	for (let depth = 0; depth < MAX_BATCH_DEPTH && frontier.length; depth++) {
		const response = await client.get("/api/now/table/sys_update_set", tableParams({
			query: `parentIN${frontier.join(",")}`,
			fields: UPDATE_SET_FIELDS,
			limit: 200,
		}));

		const children = (response?.result || []).filter((child) => !seen.has(child.sys_id));
		if (!children.length) break;

		for (const child of children) seen.add(child.sys_id);
		descendants.push(...children);
		frontier = children.map((child) => child.sys_id);
	}

	return descendants;
}

// ── Tool registration ───────────────────────────────────────────────────────

/**
 * @name registerDevContextTools
 * @description Registers the development context and update set tools on the MCP server.
 * @param {object} server - The McpServer instance
 * @param {object} client - The SnClient instance
 * @returns {void}
 */
export function registerDevContextTools(server, client) {
	server.registerTool(
		"get_dev_context",
		{
			description: "Report which ServiceNow application scope and update set the calling user's changes will land in. CALL THIS BEFORE ANY insert_record/update_record/delete_record against a sys_metadata-derived table (sys_script_include, sys_script, sys_script_client, sys_ui_action, sys_security_acl, and so on) — the Table API silently accepts writes that land in the wrong scope or an untracked update set. Returns the current scope, current update set, the set remembered for that scope, a ready_to_write flag, and warnings for every misconfiguration. Use switch_dev_context to fix anything it flags.",
			inputSchema: {},
		},
		async () => ok(await buildContext(client))
	);

	server.registerTool(
		"switch_dev_context",
		{
			description: "Set the calling user's current application scope and update set. This is the ONLY tool that changes development context — the CRUD tools never do it implicitly. The change takes effect on the next Table API call. Provide a scope, an update set, or both: with only an update set the scope is taken from that set; with only a scope the set remembered for that scope is reused, falling back to its Default set. Refuses update sets that are not 'in progress' or that belong to a different scope. NOTE: these preferences are per-user, not per-connection — another client signed in as the same account shares them.",
			inputSchema: {
				scope: z.string().optional().describe("Target application scope — a sys_scope sys_id or a scope name such as 'x_myapp' or 'global'"),
				updateSet: z.string().optional().describe("Target update set — a sys_update_set sys_id, or an exact name if it is unambiguous within the scope"),
			},
		},
		async ({ scope, updateSet }) => {
			if (!scope && !updateSet) throw new Error("switch_dev_context: provide at least one of 'scope' or 'updateSet'");

			const user = await getCurrentUser(client);

			// The scope comes from the update set when it wasn't named, so the two can never disagree.
			const targetScope = scope
				? await resolveScope(client, scope)
				: await resolveScope(client, (await resolveUpdateSet(client, updateSet)).application);

			let targetSet;
			if (updateSet) {
				targetSet = await resolveUpdateSet(client, updateSet, { scopeSysId: targetScope.sys_id });
			} else {
				// Continue where this scope left off, then fall back the way the platform would.
				const remembered = await readPreference(client, user.sys_id, prefNameForScope(targetScope.sys_id));
				const rememberedSet = remembered?.value ? await getUpdateSetBySysId(client, remembered.value) : null;

				targetSet = rememberedSet && rememberedSet.state === "in progress" && rememberedSet.application === targetScope.sys_id
					? rememberedSet
					: await findDefaultUpdateSet(client, targetScope.sys_id);

				if (!targetSet) {
					throw new Error(`switch_dev_context: no usable in-progress update set for scope '${targetScope.scope}' — pass 'updateSet' explicitly or create one with create_update_set`);
				}
			}

			if (targetSet.application !== targetScope.sys_id) {
				throw new Error(`switch_dev_context: update set '${targetSet.name}' belongs to application '${targetSet.application}', not '${targetScope.sys_id}' (${targetScope.scope}). An update set only captures changes for its own scope.`);
			}
			if (targetSet.state !== "in progress") {
				throw new Error(`switch_dev_context: update set '${targetSet.name}' is '${targetSet.state}'. Completed sets must never be reopened — create a new update set instead.`);
			}

			await applyContext(client, user.sys_id, targetScope.sys_id, targetSet.sys_id);

			return ok({ switched: true, context: await buildContext(client) });
		}
	);

	server.registerTool(
		"create_update_set",
		{
			description: "Create a new update set and, by default, make it the current one. IMPORTANT: ServiceNow forces a new update set's application to the caller's CURRENT scope and ignores any value sent for it, so this tool switches scope before inserting and restores it afterwards when makeCurrent is false. Set 'parent' to add the new set to an existing batch. Never writes base_update_set — the platform derives that from the parent chain.",
			inputSchema: {
				name: z.string().describe("Name for the update set. Use a convention that includes the ticket or story number"),
				scope: z.string().optional().describe("Application scope for the set — a sys_scope sys_id or scope name. Defaults to the current scope"),
				description: z.string().optional().describe("Description of what the update set contains"),
				releaseDate: z.string().optional().describe("Planned release date, 'yyyy-MM-dd' or 'yyyy-MM-dd HH:mm:ss'"),
				parent: z.string().optional().describe("Parent update set (sys_id or unambiguous name) to batch this set under"),
				makeCurrent: z.boolean().optional().default(true).describe("Make the new set the current update set for the calling user"),
			},
		},
		async ({ name, scope, description, releaseDate, parent, makeCurrent = true }) => {
			const user = await getCurrentUser(client);
			const startingContext = await buildContext(client);
			const startingScopeSysId = startingContext.scope.sys_id;

			const targetScope = scope ? await resolveScope(client, scope) : await resolveScope(client, startingScopeSysId);

			const parentSet = parent ? await resolveUpdateSet(client, parent, { scopeSysId: targetScope.sys_id }) : null;
			if (parentSet && parentSet.sys_id === undefined) throw new Error("create_update_set: could not resolve the parent update set");

			// The application field is not settable — it is stamped from apps.current_app at insert
			// time — so the scope has to be switched before the insert rather than passed in.
			const mustSwitchScope = targetScope.sys_id !== startingScopeSysId;
			if (mustSwitchScope) await upsertPreference(client, user.sys_id, PREF_CURRENT_APP, targetScope.sys_id);

			let created;
			try {
				const fieldMap = { name, state: "in progress" };
				if (description) fieldMap.description = description;
				if (releaseDate) fieldMap.release_date = releaseDate;
				if (parentSet) fieldMap.parent = parentSet.sys_id;

				const response = await client.post("/api/now/table/sys_update_set", fieldMap);
				created = response.result;
			} catch (error) {
				if (mustSwitchScope) await upsertPreference(client, user.sys_id, PREF_CURRENT_APP, startingScopeSysId);
				throw error;
			}

			// The Table API returns reference fields as objects here, unlike the query path.
			const createdApplication = created.application?.value ?? created.application;

			if (createdApplication !== targetScope.sys_id) {
				if (mustSwitchScope) await upsertPreference(client, user.sys_id, PREF_CURRENT_APP, startingScopeSysId);
				throw new Error(`create_update_set: the new set was stamped with application '${createdApplication}' instead of '${targetScope.sys_id}'. The scope switch did not take effect; the set was created and may need to be deleted manually (sys_id ${created.sys_id}).`);
			}

			const warnings = [];
			if (parentSet && parentSet.state === "complete") {
				warnings.push(`Parent update set '${parentSet.name}' is Complete. Adding an in-progress set to a completed batch returns the batch to In progress.`);
			}

			if (makeCurrent) {
				await applyContext(client, user.sys_id, targetScope.sys_id, created.sys_id);
			} else if (mustSwitchScope) {
				await upsertPreference(client, user.sys_id, PREF_CURRENT_APP, startingScopeSysId);
			}

			return ok({
				created: { ...created, application: createdApplication },
				made_current: makeCurrent,
				warnings,
				context: await buildContext(client),
			});
		}
	);

	server.registerTool(
		"list_update_sets",
		{
			description: "List update sets with their batch structure and change counts. Use it to find an existing set to continue work in before creating a new one, or to review what is ready to migrate. Returns state, is_default, parent and base_update_set (Batch Base) for each set. Change counts are omitted when the stats endpoint is restricted on the instance.",
			inputSchema: {
				scope: z.string().optional().describe("Restrict to one application scope — a sys_scope sys_id or scope name"),
				state: z.enum(["in progress", "complete", "ignore"]).optional().describe("Restrict to update sets in this state"),
				nameContains: z.string().optional().describe("Restrict to update sets whose name contains this text"),
				includeCounts: z.boolean().optional().default(true).describe("Include the number of captured changes per update set"),
				limit: z.number().optional().default(50).describe("Max update sets to return. Default 50"),
			},
		},
		async ({ scope, state, nameContains, includeCounts = true, limit = 50 }) => {
			const clauses = [];

			if (scope) clauses.push(`application=${(await resolveScope(client, scope)).sys_id}`);
			if (state) clauses.push(`state=${state}`);
			if (nameContains) clauses.push(`nameLIKE${assertQuerySafe(nameContains, "nameContains")}`);
			clauses.push("ORDERBYDESCsys_updated_on");

			const response = await client.get("/api/now/table/sys_update_set", tableParams({
				query: clauses.join("^"),
				fields: UPDATE_SET_FIELDS,
				limit,
			}));

			const updateSets = response?.result || [];
			const counts = includeCounts ? await countUpdates(client, updateSets.map((s) => s.sys_id)) : null;

			return ok({
				count: updateSets.length,
				counts_available: includeCounts ? counts !== null : undefined,
				update_sets: updateSets.map((set) => ({
					...set,
					change_count: counts ? counts[set.sys_id] : undefined,
				})),
			});
		}
	);

	server.registerTool(
		"get_update_set_contents",
		{
			description: "List the changes captured in an update set — the Customer Update [sys_update_xml] rows — grouped by type. Use it to review what an update set will carry before completing or migrating it, or to confirm a change was captured where you expected. When the set is a batch base, the whole batch is included and each change is labelled with its own set. Payloads are excluded by default because they are large XML blobs.",
			inputSchema: {
				updateSet: z.string().describe("The update set — a sys_update_set sys_id, or an exact name if unambiguous"),
				includeBatchChildren: z.boolean().optional().default(true).describe("Include changes from update sets batched beneath this one"),
				includePayload: z.boolean().optional().default(false).describe("Include the full XML payload of each change. Verbose — leave off unless inspecting a specific change"),
				limit: z.number().optional().default(500).describe("Max changes to return. Default 500"),
			},
		},
		async ({ updateSet, includeBatchChildren = true, includePayload = false, limit = 500 }) => {
			const targetSet = await resolveUpdateSet(client, updateSet);

			const children = includeBatchChildren ? await collectBatchDescendants(client, targetSet.sys_id) : [];
			const setNamesById = { [targetSet.sys_id]: targetSet.name };
			for (const child of children) setNamesById[child.sys_id] = child.name;

			const setSysIds = [targetSet.sys_id, ...children.map((c) => c.sys_id)];
			const fields = includePayload ? [...UPDATE_XML_FIELDS, "payload"] : UPDATE_XML_FIELDS;

			const response = await client.get("/api/now/table/sys_update_xml", tableParams({
				query: `update_setIN${setSysIds.join(",")}^ORDERBYtype^ORDERBYtarget_name`,
				fields,
				limit,
			}));

			const changes = response?.result || [];

			const changesByType = {};
			for (const change of changes) {
				const type = change.type || "unknown";
				if (!changesByType[type]) changesByType[type] = [];
				changesByType[type].push({
					name: change.name,
					target_name: change.target_name,
					action: change.action,
					application: change.application,
					update_set: setNamesById[change.update_set] || change.update_set,
					sys_created_on: change.sys_created_on,
					sys_created_by: change.sys_created_by,
					...(includePayload ? { payload: change.payload } : {}),
				});
			}

			return ok({
				update_set: targetSet,
				batch_children: children.map((c) => ({ sys_id: c.sys_id, name: c.name, state: c.state, application: c.application })),
				change_count: changes.length,
				truncated: changes.length >= limit,
				changes_by_type: changesByType,
			});
		}
	);

	server.registerTool(
		"set_update_set_state",
		{
			description: "Mark an update set Complete (ready to migrate) or Ignore (abandoned, never transferred). Completing is one-way: ServiceNow requires that a Complete set is never reopened, so this tool refuses to move a set back to 'in progress' — create a follow-up set and commit them in order instead. Warns when the set is the caller's current one, when it is the scope's Default set (the platform will auto-generate a replacement), and when it is empty.",
			inputSchema: {
				updateSet: z.string().describe("The update set — a sys_update_set sys_id, or an exact name if unambiguous"),
				state: z.enum(["complete", "ignore"]).optional().default("complete").describe("Target state. 'complete' makes it available to migrate; 'ignore' abandons it"),
				description: z.string().optional().describe("Set or replace the description before changing state"),
			},
		},
		async ({ updateSet, state = "complete", description }) => {
			const targetSet = await resolveUpdateSet(client, updateSet);

			if (targetSet.state === state) throw new Error(`set_update_set_state: update set '${targetSet.name}' is already '${state}'`);

			const context = await buildContext(client);
			const warnings = [];

			if (context.update_set?.sys_id === targetSet.sys_id) {
				warnings.push(`This was the current update set. Subsequent changes will fall back to the scope's Default set — call switch_dev_context to choose a new one.`);
			}
			if (targetSet.is_default === "true") {
				warnings.push("This is the scope's Default update set. ServiceNow immediately auto-generates a replacement default for the scope.");
			}
			if (targetSet.parent) {
				warnings.push(`This set is a child in a batch (parent ${targetSet.parent}) and cannot be committed on its own — the batch base carries it.`);
			}

			const counts = await countUpdates(client, [targetSet.sys_id]);
			if (counts?.[targetSet.sys_id] === 0) warnings.push("This update set contains no captured changes.");

			const fieldMap = { state };
			if (description) fieldMap.description = description;

			const response = await client.patch(`/api/now/table/sys_update_set/${targetSet.sys_id}`, fieldMap);

			return ok({ update_set: response.result, previous_state: targetSet.state, warnings });
		}
	);

	server.registerTool(
		"batch_update_sets",
		{
			description: "Add update sets to a batch, or remove them from one, by setting their parent. Batching lets the platform preview and commit a group in the right order and detect conflicts by ancestry; ServiceNow recommends it over merging. Only the 'parent' field is written — base_update_set (Batch Base) is read-only and derived by the platform. A child in a batch cannot be committed on its own; the batch base is committed instead. Returns the resulting hierarchy.",
			inputSchema: {
				base: z.string().describe("The parent update set the children attach to — a sys_update_set sys_id, or an exact name if unambiguous. Required for 'remove' too, so the resulting tree can be reported"),
				children: z.array(z.string()).describe("Update sets to add or remove — sys_ids, or exact names if unambiguous"),
				action: z.enum(["add", "remove"]).optional().default("add").describe("'add' parents each child to the base; 'remove' clears each child's parent"),
			},
		},
		async ({ base, children, action = "add" }) => {
			if (!children.length) throw new Error("batch_update_sets: provide at least one child update set");

			const baseSet = await resolveUpdateSet(client, base);
			const childSets = [];
			for (const child of children) childSets.push(await resolveUpdateSet(client, child));

			const warnings = [];

			// Walk up from the base so a child can never be made its own ancestor.
			const ancestors = new Set([baseSet.sys_id]);
			let cursor = baseSet;
			for (let depth = 0; depth < MAX_BATCH_DEPTH && cursor?.parent; depth++) {
				cursor = await getUpdateSetBySysId(client, cursor.parent);
				if (!cursor) break;
				ancestors.add(cursor.sys_id);
			}

			for (const child of childSets) {
				if (child.sys_id === baseSet.sys_id) throw new Error("batch_update_sets: an update set cannot be its own parent");
				if (action === "add" && ancestors.has(child.sys_id)) {
					throw new Error(`batch_update_sets: '${child.name}' is already an ancestor of '${baseSet.name}' — parenting it would create a cycle`);
				}
			}

			const updated = [];
			for (const child of childSets) {
				const response = await client.patch(`/api/now/table/sys_update_set/${child.sys_id}`, {
					parent: action === "add" ? baseSet.sys_id : "",
				});
				updated.push(response.result);

				if (action === "add" && baseSet.state === "complete" && child.state === "in progress") {
					warnings.push(`'${child.name}' is In progress — adding it returns the completed batch '${baseSet.name}' to In progress.`);
				}
			}

			const refreshedBase = await getUpdateSetBySysId(client, baseSet.sys_id);
			const descendants = await collectBatchDescendants(client, baseSet.sys_id);

			return ok({
				action,
				base: refreshedBase,
				updated_count: updated.length,
				batch: descendants.map((set) => ({
					sys_id: set.sys_id,
					name: set.name,
					state: set.state,
					application: set.application,
					parent: set.parent,
					base_update_set: set.base_update_set,
				})),
				warnings,
			});
		}
	);
}
