#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SnClient, tableParams } from "./sn-client.js";
import { generateDBML } from "./dbml.js";
import { describeCatalogItem } from "./catalog.js";
import { OAuthProvider, DEFAULT_REDIRECT_URI } from "./oauth.js";
import { ok, tableParams } from "./mcp-helpers.js";
import { registerDevContextTools } from "./code_management_and_migration/dev-context.js";

// ── Config ──────────────────────────────────────────────────────────────────

const instanceURL = process.env.SN_INSTANCE;

if (!instanceURL) {
	console.error("sn-mcp-bridge: Missing required env var: SN_INSTANCE");
	process.exit(1);
}

let instanceName;
try {
	instanceName = new URL(instanceURL).hostname.split('.')[0].toUpperCase().replace(/-/g, '_');
} catch {
	console.error(`sn-mcp-bridge: SN_INSTANCE is not a valid URL: ${instanceURL}`);
	process.exit(1);
}

const prefix = `SN_${instanceName}`;

/**
 * @name envFor
 * @description Reads an instance-prefixed env var, falling back to the unprefixed form.
 * e.g. for https://mydev01.service-now.com, "USERNAME" resolves SN_MYDEV01_USERNAME then SN_USERNAME.
 * @param {string} name - The unprefixed variable suffix (e.g. "USERNAME")
 * @returns {string|undefined} The resolved value
 */
const envFor = (name) => process.env[`${prefix}_${name}`] || process.env[`SN_${name}`];

const username = envFor("USERNAME");
const password = envFor("PASSWORD");

const clientId = envFor("CLIENT_ID");
const clientSecret = envFor("CLIENT_SECRET");
const grantType = envFor("GRANT_TYPE");

// OAuth is opt-in: presence of any OAuth var means the user intends the OAuth path, so a partial
// set is an error rather than a silent fall-back to basic auth.
const oauthVars = { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret, GRANT_TYPE: grantType };
const useOAuth = Object.values(oauthVars).some(Boolean);

let tokenProvider = null;

if (useOAuth) {
	const missing = Object.entries(oauthVars).filter(([, value]) => !value).map(([name]) => `${prefix}_${name}`);
	if (missing.length) {
		console.error(`sn-mcp-bridge: OAuth is partially configured — missing ${missing.join(", ")}. Set all of CLIENT_ID, CLIENT_SECRET, and GRANT_TYPE, or none of them to use basic auth.`);
		process.exit(1);
	}

	if (grantType !== "authorization_code") {
		console.error(`sn-mcp-bridge: unsupported grant_type '${grantType}' — only 'authorization_code' is supported`);
		process.exit(1);
	}

	tokenProvider = new OAuthProvider({
		instance: instanceURL,
		clientId,
		clientSecret,
		redirectUri: envFor("REDIRECT_URI") || DEFAULT_REDIRECT_URI,
		refreshToken: envFor("REFRESH_TOKEN"),
		usePkce: envFor("USE_PKCE") === "true",
	});
} else if (!username || !password) {
	console.error("sn-mcp-bridge: Missing required env vars: SN_INSTANCE, SN_USERNAME, SN_PASSWORD");
	process.exit(1);
}

const client = new SnClient({ instance: instanceURL, username, password, tokenProvider });
const server = new McpServer(
	{ name: "sn-mcp-bridge", version: "1.5.0" },
	{
		instructions: [
			"ServiceNow is a record-based development platform. All development artifacts — script includes, business rules, client scripts, UI actions, ACLs, UI policies, scheduled jobs, and more — are records in system tables. Creating, reading, updating, and deleting these records through the CRUD tools IS how you develop on the platform. There is no separate 'code layer'; the Table API is the development API.",
			"",
			"Key development tables:",
			"- sys_script_include — Script includes (reusable server-side classes/functions)",
			"- sys_script — Business rules (server-side triggers on table operations)",
			"- sys_script_client — Client scripts (browser-side form logic)",
			"- sys_ui_action — UI actions (buttons, links, context menus)",
			"- sys_ui_policy — UI policies (form field visibility/mandatory/read-only rules)",
			"- sys_security_acl — Access controls (row/field-level security)",
			"- sys_ws_operation — Scripted REST API operations",
			"- sysauto_script — Scheduled script executions",
			"- sys_update_set — Update sets (change tracking and deployment units)",
			"- sys_properties — System properties (configuration values)",
			"",
			"Every development table above extends sys_metadata, so each write is stamped with an application scope and captured in an update set — both taken from the calling user's current context, not from the record you send. Call get_dev_context before writing to any of them, and switch_dev_context to correct anything it flags. A write made in the wrong context succeeds silently and lands in the wrong scope or an untracked update set.",
			"",
			"Use execute_script as a server-side runtime for tasks that go beyond what CRUD operations can accomplish — testing logic, running GlideRecord queries with complex conditions, calling script includes, performing multi-step transactions, or any operation that requires server-side JavaScript execution.",
		].join("\n"),
	}
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @name ok
 * @description Wraps data in the MCP tool response format
 * @param {any} data - The data to return to the client
 * @returns {object} An MCP-compliant tool result with text content
 */
function ok(data) {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── CRUD Tools ──────────────────────────────────────────────────────────────

server.registerTool(
	"query_data",
	{
		description: "Use this tool any time that you need to query data from a ServiceNow table. Table names can be discovered by querying the sys_db_object table. Use application scopes as an indicator for which tables belong to what applications. Table names often start with the application scope prefix that they belong to",
		inputSchema: {
			table: z.string().describe("The table to retrieve data from"),
			options: z.object({
				encodedQuery: z.string().optional().describe("A ServiceNow encoded query string to filter records"),
				fields: z.array(z.string()).optional().describe("An array of field names to include in results"),
				limit: z.number().optional().describe("Max records to return"),
				addDisplayValue: z.boolean().optional().default(false).describe("When true, returns display values alongside raw values"),
			}).optional(),
		},
	},
	async ({ table, options = {} }) => {
		const data = await client.get(`/api/now/table/${table}`, tableParams({
			query: options.encodedQuery,
			fields: options.fields,
			limit: options.limit,
			displayValue: options.addDisplayValue ? "all" : undefined,
		}));
		return ok(data.result);
	}
);

server.registerTool(
	"get_record",
	{
		description: "Use this tool to retrieve a single record by its sys_id from any ServiceNow table.",
		inputSchema: {
			table: z.string().describe("The ServiceNow table name"),
			sysId: z.string().describe("The sys_id of the record"),
			addDisplayValue: z.boolean().optional().default(false).describe("Include display values alongside raw values"),
		},
	},
	async ({ table, sysId, addDisplayValue }) => {
		const data = await client.get(
			`/api/now/table/${table}/${sysId}`,
			tableParams({ displayValue: addDisplayValue ? "all" : undefined })
		);
		return ok(data.result);
	}
);

server.registerTool(
	"insert_record",
	{
		description: "Use this tool to insert a new record into a ServiceNow table",
		inputSchema: {
			table: z.string().describe("The ServiceNow table name"),
			fieldMap: z.record(z.unknown()).describe("Key/value map of field names and values to set on the record"),
		},
	},
	async ({ table, fieldMap }) => {
		const data = await client.post(`/api/now/table/${table}`, fieldMap);
		return ok(data.result);
	}
);

server.registerTool(
	"update_record",
	{
		description: "Use this tool to modify an existing record in a ServiceNow table",
		inputSchema: {
			table: z.string().describe("The ServiceNow table name"),
			sysId: z.string().describe("The sys_id of the record to update"),
			fieldMap: z.record(z.unknown()).describe("Key/value map of field names and values to update"),
		},
	},
	async ({ table, sysId, fieldMap }) => {
		const data = await client.patch(`/api/now/table/${table}/${sysId}`, fieldMap);
		return ok(data.result);
	}
);

server.registerTool(
	"delete_record",
	{
		description: "Deletes a single record from a ServiceNow table by its sys_id. Use with caution — this permanently removes the record.",
		inputSchema: {
			table: z.string().describe("The ServiceNow table name"),
			sysId: z.string().describe("The sys_id of the record to delete"),
		},
	},
	async ({ table, sysId }) => {
		await client.del(`/api/now/table/${table}/${sysId}`);
		return ok({ success: true, sys_id: sysId });
	}
);

// ── Schema Tool ─────────────────────────────────────────────────────────────

const SYS_COLUMNS = [
	"sys_class_name", "sys_created_by", "sys_created_on",
	"sys_mod_count", "sys_updated_by", "sys_updated_on",
];

const REF_FIELD_TYPES = ["reference", "glide_list"];

server.registerTool(
	"get_table_schema",
	{
		description: "Use this tool to retrieve a descriptive table schema JSON object for a given ServiceNow table",
		inputSchema: {
			table: z.string().describe("The table name (e.g. 'incident', 'cmdb_ci')"),
			includeSysColumns: z.boolean().optional().default(false).describe("When true, includes system columns like sys_created_on, sys_updated_by, etc."),
		},
	},
	async ({ table, includeSysColumns }) => {
		// Build the dictionary query, optionally excluding system columns
		let dictQuery = `name=${table}^active=true^internal_type!=collection`;
		if (!includeSysColumns) dictQuery += `^element NOT IN${SYS_COLUMNS.join(",")}`;
		dictQuery += "^ORDERBYDESCprimary^ORDERBYname^ORDERBYinternal_type^ORDERBYelement";

		// Query table metadata, dictionary, and choices in parallel
		const [metaResp, dictResp, choiceResp] = await Promise.all([
			client.get("/api/now/table/sys_db_object", tableParams({
				query: `name=${table}`,
				fields: ["name", "label", "super_class", "sys_scope"],
				displayValue: "true",
				limit: 1,
			})),
			client.get("/api/now/table/sys_dictionary", tableParams({
				query: dictQuery,
				fields: [
					"element", "column_label", "internal_type", "max_length",
					"mandatory", "read_only", "default_value", "reference",
					"primary", "unique", "display", "virtual",
					"reference_qual", "reference_cascade_rule",
				],
				limit: 500,
			})),
			client.get("/api/now/table/sys_choice", tableParams({
				query: `name=${table}^inactive=false^ORDERBYelement^ORDERBYsequence`,
				fields: ["element", "value", "label", "sequence"],
				limit: 1000,
			})),
		]);

		const meta = metaResp.result?.[0] || {};

		// Define the structure of the table schema object
		const tableSchema = {
			name: table,
			label: meta.label || table,
			scope: meta.sys_scope || null,
			columns: [],
			referencedTables: [],
		};

		// Add hierarchy/extends info if this table has a parent
		if (meta.super_class) {
			tableSchema.extends = { name: meta.super_class };
		}

		// Build a choices lookup keyed by field name
		const choicesByField = {};
		for (const choice of choiceResp.result || []) {
			if (!choicesByField[choice.element]) choicesByField[choice.element] = [];
			choicesByField[choice.element].push({
				label: choice.label,
				value: choice.value,
				sequence: choice.sequence,
			});
		}

		// Process each column from the dictionary
		for (const col of dictResp.result || []) {
			if (!col.element) continue;

			const type = col.internal_type;
			const column = { label: col.column_label, name: col.element, type };

			// Add extra fields if applicable
			if (col.primary === "true") column.primary = true;
			if (col.unique === "true") column.unique = true;
			if (col.display === "true") column.display = true;
			if (col.mandatory === "true") column.mandatory = true;
			if (col.read_only === "true") column.readOnly = true;
			if (col.virtual === "true") column.calculated = true;
			if (col.default_value) column.defaultValue = col.default_value;
			if (col.max_length) column.maxLength = col.max_length;

			// Add reference details for reference columns
			const refTable = col.reference;
			if (REF_FIELD_TYPES.includes(type) && refTable) {
				column.reference = { table: refTable, field: "sys_id" };

				const qualifier = col.reference_qual;
				if (qualifier) column.reference.qualifier = qualifier;

				const cascadeRule = col.reference_cascade_rule;
				if (cascadeRule && cascadeRule !== "none") column.reference.cascadeRule = cascadeRule;

				// Add this table to the referenced tables if not already in it
				if (!tableSchema.referencedTables.includes(refTable)) {
					tableSchema.referencedTables.push(refTable);
				}
			}

			// Add choices for choice columns
			if (choicesByField[col.element]) {
				column.choices = choicesByField[col.element];
			}

			tableSchema.columns.push(column);
		}

		return ok(tableSchema);
	}
);

// ── App Discovery Tools ─────────────────────────────────────────────────────

server.registerTool(
	"get_application_scopes",
	{
		description: "Use this tool to fetch all of the application scopes on an instance",
		inputSchema: {
			includeStoreApps: z.boolean().describe("Whether to include store application scopes"),
		},
	},
	async ({ includeStoreApps }) => {
		// Get custom scoped apps
		const appsResp = await client.get("/api/now/table/sys_app", tableParams({
			fields: ["scope", "name", "version"],
		}));

		const appScopes = {};
		for (const app of appsResp.result || []) {
			appScopes[app.scope] = app.name;
		}

		// Optionally include store apps
		if (includeStoreApps) {
			const storeResp = await client.get("/api/now/table/sys_store_app", tableParams({
				fields: ["scope", "name", "version"],
			}));
			for (const app of storeResp.result || []) {
				appScopes[app.scope] = app.name;
			}
		}

		return ok(appScopes);
	}
);

server.registerTool(
	"get_application_tables",
	{
		description: "Use this tool to get all of the tables in a given application scope",
		inputSchema: {
			scope: z.string().describe("The application scope to get tables for"),
		},
	},
	async ({ scope }) => {
		const resp = await client.get("/api/now/table/sys_db_object", tableParams({
			query: `sys_scope.scope=${scope}^ORDERBYname`,
			fields: ["name"],
		}));

		const tables = (resp.result || []).map((r) => r.name);
		return ok(tables);
	}
);

server.registerTool(
	"get_scoped_app_files",
	{
		description: "Use this tool to get all of the application files (sys_metadata) for a given scoped application",
		inputSchema: {
			scope: z.string().describe("The application scope to get app files for"),
		},
	},
	async ({ scope }) => {
		// Get all metadata for the scoped app
		const resp = await client.get("/api/now/table/sys_metadata", tableParams({
			query: `sys_scope.scope=${scope}^ORDERBYsys_class_name^ORDERBYsys_name`,
			fields: ["sys_name", "sys_class_name", "sys_update_name"],
			displayValue: "all",
			limit: 1000,
		}));

		// Group the output by table
		const appFilesByTable = {};
		for (const record of resp.result || []) {
			// Use raw sys_class_name for the key (e.g. "sys_script_include")
			const table = record.sys_class_name?.value || record.sys_class_name || "unknown";

			// Set the file name to the display value, fallback to the update name if empty
			const fileName = record.sys_name?.display_value || record.sys_update_name?.value || record.sys_name?.value;

			if (!appFilesByTable[table]) appFilesByTable[table] = [];
			appFilesByTable[table].push(fileName);
		}

		return ok(appFilesByTable);
	}
);

// ── Code Management Tools ───────────────────────────────────────────────────
// Application scope and update set control. Registered here because every sys_metadata write made by
// the CRUD tools above depends on the context these manage.

registerDevContextTools(server, client);

// ── Aggregate Tools ─────────────────────────────────────────────────────────

server.registerTool(
	"aggregate_data",
	{
		description: "Run aggregate queries (COUNT, AVG, MIN, MAX, SUM) on a ServiceNow table with optional grouping. Use this instead of query_data when you need totals, sums, or averages — it handles the math on the server so you get exact results without needing to sum records yourself.",
		inputSchema: {
			table: z.string().describe("The table to aggregate"),
			encodedQuery: z.string().optional().describe("Encoded query to filter records before aggregating"),
			groupBy: z.string().optional().describe("Field name to group results by"),
			aggregates: z.array(z.object({
				type: z.enum(["COUNT", "AVG", "MIN", "MAX", "SUM"]).describe("The aggregation type"),
				field: z.string().optional().describe("The field to aggregate (required for AVG, MIN, MAX, SUM; optional for COUNT)"),
			})).describe("Array of aggregations to perform"),
		},
	},
	async ({ table, encodedQuery, groupBy, aggregates }) => {
		const params = { sysparm_exclude_reference_link: "true" };
		if (encodedQuery) params.sysparm_query = encodedQuery;
		if (groupBy) params.sysparm_group_by = groupBy;

		// Map aggregation types to their corresponding sysparm parameter names
		const typeToParam = {
			AVG: "sysparm_avg_fields",
			MIN: "sysparm_min_fields",
			MAX: "sysparm_max_fields",
			SUM: "sysparm_sum_fields",
		};

		// Group the requested aggregate fields by type and build each sysparm
		const fieldsByType = {};
		for (const aggregate of aggregates) {
			const type = aggregate.type.toUpperCase();
			if (type === "COUNT") {
				params.sysparm_count = "true";
			} else {
				if (!aggregate.field) throw new Error(`aggregate_data: field is required for ${type} aggregation`);
				if (!fieldsByType[type]) fieldsByType[type] = [];
				fieldsByType[type].push(aggregate.field);
			}
		}

		for (const [type, fields] of Object.entries(fieldsByType)) {
			params[typeToParam[type]] = fields.join(",");
		}

		const data = await client.get(`/api/now/stats/${table}`, params);
		return ok(data.result);
	}
);

server.registerTool(
	"get_record_count",
	{
		description: "Get the count of records matching a query on a ServiceNow table. Lighter than aggregate_data when you only need a count.",
		inputSchema: {
			table: z.string().describe("The table to count records from"),
			encodedQuery: z.string().optional().describe("Encoded query to filter which records are counted"),
		},
	},
	async ({ table, encodedQuery }) => {
		const params = { sysparm_count: "true" };
		if (encodedQuery) params.sysparm_query = encodedQuery;

		const data = await client.get(`/api/now/stats/${table}`, params);
		const count = data.result?.stats?.count || "0";
		return ok({ count });
	}
);

// ── Code Search Tool ────────────────────────────────────────────────────────

const DEFAULT_SCRIPT_TABLES = [
	"sys_script_include",
	"sys_script",
	"sys_script_client",
	"sys_ws_operation",
	"sys_ui_script",
];

server.registerTool(
	"search_code",
	{
		description: "Search for code across ServiceNow script fields. Tries the native Code Search API first (/api/sn_codesearch), falls back to querying script tables directly if the plugin is not available.",
		inputSchema: {
			searchTerm: z.string().describe("The text to search for in script fields"),
			scope: z.string().optional().describe("App scope to filter results (e.g. 'x_myapp_scope')"),
			tables: z.array(z.string()).optional().describe("Specific tables to search (only used in fallback mode). Defaults to sys_script_include, sys_script, sys_script_client, sys_ws_operation, sys_ui_script"),
		},
	},
	async ({ searchTerm, scope, tables }) => {
		// Try the native Code Search API first
		try {
			const searchParams = {
				search_group: "sn_codesearch.Default Search Group",
				term: searchTerm,
				search_all_scopes: scope ? "false" : "true",
			};

			// If a scope is provided, look up its sys_id to use as current_app
			if (scope) {
				const scopeResp = await client.get("/api/now/table/sys_app", tableParams({
					query: `scope=${scope}`,
					fields: ["sys_id"],
					limit: 1,
				}));
				const scopeSysId = scopeResp.result?.[0]?.sys_id;
				if (scopeSysId) searchParams.current_app = scopeSysId;
			}

			const data = await client.get("/api/sn_codesearch/code_search/search", searchParams);
			return ok(data.result);
		} catch (error) {
			// If the Code Search API is not available, fall back to table queries
			const errorMsg = error.message || "";
			if (!errorMsg.includes("404") && !errorMsg.includes("Not Found")) {
				throw error;
			}
		}

		// Fallback: query script tables directly when the Code Search plugin is not installed
		const searchTables = tables || DEFAULT_SCRIPT_TABLES;
		const scriptFieldMap = { sys_ws_operation: "operation_script" };

		const queries = searchTables.map(async (tableName) => {
			const scriptField = scriptFieldMap[tableName] || "script";
			let query = `${scriptField}CONTAINS${searchTerm}`;
			if (scope) query += `^sys_scope.scope=${scope}`;
			query += "^ORDERBYname";

			const resp = await client.get(`/api/now/table/${tableName}`, tableParams({
				query,
				fields: ["sys_id", "name", "sys_scope"],
				displayValue: "true",
				limit: 50,
			}));
			return { table: tableName, results: resp.result || [] };
		});

		const allResults = await Promise.all(queries);

		// Group results by table, skip tables with no matches
		const resultsByTable = {};
		for (const { table: tableName, results: records } of allResults) {
			if (records.length > 0) {
				resultsByTable[tableName] = records.map((record) => ({
					name: record.name,
					sys_id: record.sys_id,
					scope: record.sys_scope,
				}));
			}
		}

		return ok(resultsByTable);
	}
);

// ── DBML Generation Tool ───────────────────────────────────────────────────

server.registerTool(
	"generate_dbml",
	{
		description: "Generate DBML (Database Markup Language) for ServiceNow tables. Provide 'table' for a single table, 'scope' for all tables in an app scope, or 'encodedQuery' for a custom sys_db_object query. Output includes table definitions with column types, reference relationships, choice enums, inheritance, and reference helper stubs for out-of-scope tables.",
		inputSchema: {
			table: z.string().optional().describe("Generate DBML for a single table by name (e.g. 'incident')"),
			scope: z.string().optional().describe("Generate DBML for all tables in an application scope (e.g. 'x_myapp')"),
			encodedQuery: z.string().optional().describe("Generate DBML for tables matching this encoded query against sys_db_object"),
			options: z.object({
				getInheritedColumns: z.boolean().optional().default(false).describe("Include columns inherited from parent tables in the hierarchy"),
				getSysColumns: z.boolean().optional().default(false).describe("Include system columns (sys_created_on, sys_updated_by, etc.)"),
				onlyReferences: z.boolean().optional().default(false).describe("Only include reference fields and primary keys — useful for relationship diagrams"),
				limit: z.number().optional().describe("Max number of tables to include"),
			}).optional(),
		},
	},
	async ({ table, scope, encodedQuery, options = {} }) => {
		let query;
		if (table) query = `name=${table}`;
		else if (scope) query = `sys_scope.scope=${scope}`;
		else if (encodedQuery) query = encodedQuery;
		else throw new Error("generate_dbml: provide at least one of 'table', 'scope', or 'encodedQuery'");

		const dbml = await generateDBML(client, query, options);
		if (!dbml) return { content: [{ type: "text", text: "No tables matched the query." }] };
		return { content: [{ type: "text", text: dbml }] };
	}
);

// ── Service Catalog Tool ───────────────────────────────────────────────────

server.registerTool(
	"describe_catalog_item",
	{
		description: [
			"Use this tool to retrieve the entire configuration of a Service Catalog item, record producer, or order guide in one call — the item record, its variables (with choices and resolved lookup options), variable sets, catalog UI policies and their actions, catalog client scripts, catalog/category placement, and user criteria.",
			"",
			"Prefer this over stitching together get_record/query_data calls against sc_cat_item, item_option_new, io_set_item, catalog_ui_policy and catalog_script_client, and over running a background script.",
			"",
			"Empty fields are stripped from every record to keep the response readable — a missing key means the field is empty, not that it does not exist. The 'rendered_view' section holds the raw /api/sn_sc/servicecatalog/items response (how the form renders at runtime); it reports an error when the authenticated user has no access to the item, while every other section still populates.",
		].join("\n"),
		inputSchema: {
			item: z.string().describe("The sys_id OR the exact name of the catalog item, record producer, or order guide. Prefer sys_id — names are not unique in ServiceNow, and an ambiguous name returns an error listing the candidates to choose from."),
		},
	},
	async ({ item }) => {
		return ok(await describeCatalogItem(client, item));
	}
);

// ── Session-based Tools ─────────────────────────────────────────────────────
// The tools below hit UI endpoints (sys.scripts.do, ui_page_process.do) that require a form-login
// session, which an OAuth bearer token cannot provide. When only OAuth credentials are configured
// they are not registered at all, so the model never sees a tool it cannot call.

const registerSessionTool = client.hasSessionAuth
	? server.registerTool.bind(server)
	: () => {};

// ── Background Script Tool ──────────────────────────────────────────────────

registerSessionTool(
	"execute_script",
	{
		description: "Execute a background script on the ServiceNow instance. Runs server-side JavaScript via sys.scripts.do. Use with caution — scripts execute with the authenticated user's permissions and can modify data.",
		inputSchema: {
			script: z.string().describe("The JavaScript code to execute on the instance"),
			scope: z.string().optional().default("global").describe("The app scope to run in ('global' or a scope sys_id)"),
		},
	},
	async ({ script, scope }) => {
		const output = await client.executeScript(script, scope);
		return ok({ output });
	}
);

// ── Diagnostics Tools ───────────────────────────────────────────────────────

registerSessionTool(
	"explore_syslog",
	{
		description: "Query the ServiceNow application log (syslog table). Shows gs.info/warn/error output, script include logs, and application exceptions. Runs in global scope — required because syslog is not accessible via the Table API. Use this as layer 3 of the diagnostic stack: did our scripts run and what did they log?",
		inputSchema: {
			encodedQuery: z.string().optional().describe("ServiceNow encoded query string applied directly to the syslog table (overrides other filters)"),
			minutesAgo: z.number().optional().describe("Only return logs from the last N minutes. Defaults to 15 when no encodedQuery is provided."),
			level: z.enum(["info", "warning", "error"]).optional().describe("Filter by log level"),
			messageContains: z.string().optional().describe("Filter to logs whose message contains this string"),
			sourceContains: z.string().optional().describe("Filter by source (script include name, class name, etc.)"),
			session: z.string().optional().describe("Filter to a specific session ID"),
			limit: z.number().optional().describe("Max records to return. Default 100, max 500."),
		},
	},
	async ({ encodedQuery, minutesAgo, level, messageContains, sourceContains, session, limit }) => {
		// Default to last 15 minutes when no time or encoded query is provided
		const effectiveMinutes = minutesAgo ?? (encodedQuery ? undefined : 15);

		const lines = ["var gr = new GlideRecord('syslog');"];
		if (encodedQuery) lines.push(`gr.addEncodedQuery(${JSON.stringify(encodedQuery)});`);
		if (effectiveMinutes) lines.push(`gr.addQuery('sys_created_on', '>', gs.minutesAgoStart(${Math.floor(Number(effectiveMinutes))}));`);
		if (level) lines.push(`gr.addQuery('level', ${JSON.stringify(level)});`);
		if (messageContains) lines.push(`gr.addQuery('message', 'CONTAINS', ${JSON.stringify(messageContains)});`);
		if (sourceContains) lines.push(`gr.addQuery('source', 'CONTAINS', ${JSON.stringify(sourceContains)});`);
		if (session) lines.push(`gr.addQuery('session', ${JSON.stringify(session)});`);
		lines.push(`gr.orderByDesc('sys_created_on');`);
		lines.push(`gr.setLimit(${Math.min(Math.floor(Number(limit) || 100), 500)});`);
		lines.push("gr.query();");
		lines.push("var results = [];");
		lines.push("while (gr.next()) {");
		lines.push("    results.push({");
		lines.push("        created: gr.getValue('sys_created_on'),");
		lines.push("        level:   gr.getValue('level'),");
		lines.push("        source:  gr.getValue('source'),");
		lines.push("        message: gr.getValue('message'),");
		lines.push("        session: gr.getValue('session')");
		lines.push("    });");
		lines.push("}");
		lines.push("gs.print(JSON.stringify({ count: results.length, logs: results }));");
		const script = lines.join("\n");

		const rawOutput = await client.executeScript(script, "global");
		const jsonStart = rawOutput.indexOf("{");
		if (jsonStart === -1) throw new Error(`explore_syslog: no JSON in script output: ${rawOutput.slice(0, 300)}`);
		return ok(JSON.parse(rawOutput.slice(jsonStart)));
	}
);

registerSessionTool(
	"explore_syslog_transaction",
	{
		description: "Query the ServiceNow transaction log (syslog_transaction table). Shows every HTTP request that reached the SN application layer — URL, user, response code, session. Runs in global scope — required because syslog_transaction is not accessible via the Table API. IMPORTANT: if a transaction does not appear here, the request never reached the application layer — it was blocked at the network/ADC level. Use this as layer 2 of the diagnostic stack: did the request reach the application?",
		inputSchema: {
			encodedQuery: z.string().optional().describe("ServiceNow encoded query string applied directly to the syslog_transaction table"),
			minutesAgo: z.number().optional().describe("Only return transactions from the last N minutes. Defaults to 15 when no encodedQuery is provided."),
			urlContains: z.string().optional().describe("Filter transactions where the URL contains this string"),
			session: z.string().optional().describe("Filter to a specific session ID"),
			user: z.string().optional().describe("Filter by username"),
			responseCode: z.string().optional().describe("Filter by HTTP response code (e.g. '200', '401')"),
			limit: z.number().optional().describe("Max records to return. Default 50, max 200."),
		},
	},
	async ({ encodedQuery, minutesAgo, urlContains, session, user, responseCode, limit }) => {
		const effectiveMinutes = minutesAgo ?? (encodedQuery ? undefined : 15);

		const lines = ["var gr = new GlideRecord('syslog_transaction');"];
		if (encodedQuery) lines.push(`gr.addEncodedQuery(${JSON.stringify(encodedQuery)});`);
		if (effectiveMinutes) lines.push(`gr.addQuery('sys_created_on', '>', gs.minutesAgoStart(${Math.floor(Number(effectiveMinutes))}));`);
		if (urlContains) lines.push(`gr.addQuery('url', 'CONTAINS', ${JSON.stringify(urlContains)});`);
		if (session) lines.push(`gr.addQuery('session', ${JSON.stringify(session)});`);
		if (user) lines.push(`gr.addQuery('user_name', ${JSON.stringify(user)});`);
		if (responseCode) lines.push(`gr.addQuery('response_code', ${JSON.stringify(responseCode)});`);
		lines.push(`gr.orderByDesc('sys_created_on');`);
		lines.push(`gr.setLimit(${Math.min(Math.floor(Number(limit) || 50), 200)});`);
		lines.push("gr.query();");
		lines.push("var results = [];");
		lines.push("while (gr.next()) {");
		lines.push("    results.push({");
		lines.push("        created:  gr.getValue('sys_created_on'),");
		lines.push("        url:      gr.getValue('url'),");
		lines.push("        response: gr.getValue('response_code'),");
		lines.push("        session:  gr.getValue('session'),");
		lines.push("        user:     gr.getValue('user_name'),");
		lines.push("        source:   gr.getValue('source'),");
		lines.push("        type:     gr.getValue('type')");
		lines.push("    });");
		lines.push("}");
		lines.push("gs.print(JSON.stringify({ count: results.length, transactions: results }));");
		const script = lines.join("\n");

		const rawOutput = await client.executeScript(script, "global");
		const jsonStart = rawOutput.indexOf("{");
		if (jsonStart === -1) throw new Error(`explore_syslog_transaction: no JSON in script output: ${rawOutput.slice(0, 300)}`);
		return ok(JSON.parse(rawOutput.slice(jsonStart)));
	}
);

registerSessionTool(
	"explore_node_logs",
	{
		description: "Read the raw instance node logs — the deepest observability layer. Shows everything including requests blocked before scripts run, auth failures at the platform layer, scheduler activity, and session management. The only way to confirm whether a request reached the physical server at all. Uses the SN log file browser UI (ui_page_process.do) via HTTP + HTML parse, since the underlying Java API is security-restricted from scripts. Use this as layer 1 of the diagnostic stack: did the request reach the server? Time parameters are in UTC.",
		inputSchema: {
			minutesAgo: z.number().optional().describe("Look at the last N minutes. Takes precedence over startTime/endTime. Defaults to 15 when no startTime is provided."),
			startTime: z.string().optional().describe("Start of time window in SN datetime format: 'yyyy-MM-dd HH:mm:ss' (instance local time, same as gs.nowDateTime())"),
			endTime: z.string().optional().describe("End of time window in SN datetime format: 'yyyy-MM-dd HH:mm:ss' (instance local time). Defaults to now."),
			level: z.enum(["all", "trace", "debug", "info", "warning", "error", "fatal"]).optional().default("all").describe("Minimum log level to include. Default: all."),
			session: z.string().optional().describe("Filter to a specific session ID (32-char hex from the Session Id column)"),
			messageContains: z.string().optional().describe("Filter to entries whose message contains this string"),
			thread: z.string().optional().describe("Filter by thread name (e.g. 'http-34')"),
			omitWorkers: z.boolean().optional().default(true).describe("Omit background worker thread entries. Default true — keeps output focused on HTTP transactions."),
			maxRows: z.number().optional().describe("Maximum log entries to return. Default 500, max 2000."),
		},
	},
	async ({ minutesAgo, startTime, endTime, level = "all", session, messageContains, thread, omitWorkers = true, maxRows }) => {
		const LEVEL_CODES = { all: 4, trace: 5, debug: 3, info: 0, warning: 1, error: 2, fatal: 6 };
		const levelCode = LEVEL_CODES[level] ?? 4;

		// Compute time window: minutesAgo takes precedence, then explicit startTime, then default 15 minutes.
		// Times must be in instance local time — fetch the configured timezone first.
		let effectiveStart = startTime;
		let effectiveEnd = endTime;

		if (minutesAgo || !startTime) {
			const effectiveMinutes = minutesAgo || 15;

			// Resolve effective timezone. Priority:
			//   1. sys_user.time_zone (user override)
			//   2. glide.sys.default.tz system property
			//   3. execute_script fallback — when both are unset the instance uses the JVM
			//      timezone, which is not queryable via REST.
			const [userResp, propResp] = await Promise.all([
				client.get("/api/now/table/sys_user", {
					// Resolve the caller server-side so this works under basic auth and OAuth alike.
					sysparm_query: "sys_id=javascript:gs.getUserID()",
					sysparm_fields: "time_zone",
					sysparm_limit: "1",
				}),
				client.get("/api/now/table/sys_properties", {
					sysparm_query: "name=glide.sys.default.tz",
					sysparm_fields: "value",
					sysparm_limit: "1",
				}),
			]);

			const tz = userResp.result?.[0]?.time_zone || propResp.result?.[0]?.value || null;

			if (tz) {
				const fmt = (date) => {
					const parts = new Intl.DateTimeFormat("en-CA", {
						timeZone: tz,
						year: "numeric", month: "2-digit", day: "2-digit",
						hour: "2-digit", minute: "2-digit", second: "2-digit",
						hour12: false,
					}).formatToParts(date);
					const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
					return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
				};
				const now = new Date();
				effectiveStart = fmt(new Date(now.getTime() - effectiveMinutes * 60 * 1000));
				effectiveEnd = fmt(now);
			} else {
				// JVM timezone fallback: get server's local "now" from gs.nowDateTime() and
				// subtract minutes via pure string arithmetic (no timezone conversion needed).
				const timeOutput = await client.executeScript("gs.print(gs.nowDateTime());", "global");
				const serverNow = timeOutput.replace(/\*\*\* Script:\s*/i, "").trim();
				const [datePart, timePart] = serverNow.split(" ");
				const [year, month, day] = datePart.split("-").map(Number);
				const [hour, min, sec] = timePart.split(":").map(Number);
				const d = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
				d.setUTCMinutes(d.getUTCMinutes() - effectiveMinutes);
				const pad = (n) => String(n).padStart(2, "0");
				effectiveStart = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
				effectiveEnd = serverNow;
			}
		}

		const result = await client.fetchNodeLogs({
			startTime: effectiveStart,
			endTime: effectiveEnd,
			levelCode,
			session,
			messageFilter: messageContains,
			threadFilter: thread,
			omitWorkers,
			maxRows,
		});

		return ok(result);
	}
);

// ── Start ───────────────────────────────────────────────────────────────────

// Acquire a token before connecting so browser consent and any OAuth misconfiguration surface at
// startup rather than partway through the first tool call.
if (tokenProvider) {
	try {
		await tokenProvider.prime();
	} catch (error) {
		console.error(`sn-mcp-bridge: OAuth authorization failed — ${error.message}`);
		process.exit(1);
	}
}

const transport = new StdioServerTransport();
await server.connect(transport);

const mode = tokenProvider ? "oauth" : "basic";
const sessionTools = client.hasSessionAuth ? "session tools enabled" : "session tools disabled (no username/password)";
console.error(`sn-mcp-bridge running — ${instanceURL} (${mode}, ${sessionTools})`);
