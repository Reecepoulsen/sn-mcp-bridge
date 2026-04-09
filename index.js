#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SnClient } from "./sn-client.js";

// ── Config ──────────────────────────────────────────────────────────────────

const instanceURL = process.env.SN_INSTANCE;
const instanceName = instanceURL ? new URL(instanceURL).hostname.split('.')[0].toUpperCase().replace(/-/g, '_') : null;
const prefix = instanceName ? `SN_${instanceName}` : null;

const username = (prefix && process.env[`${prefix}_USERNAME`]) || process.env.SN_USERNAME;
const password = (prefix && process.env[`${prefix}_PASSWORD`]) || process.env.SN_PASSWORD;

if (!instanceURL || !username || !password) {
	console.error("sn-mcp-bridge: Missing required env vars: SN_INSTANCE, SN_USERNAME, SN_PASSWORD");
	process.exit(1);
}

const client = new SnClient({ instance: instanceURL, username, password });
const server = new McpServer(
	{ name: "sn-mcp-bridge", version: "1.0.0" },
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

/**
 * @name tableParams
 * @description Builds the sysparm query parameters for a Table API request
 * @param {object} [options] - Options to map to sysparm parameters
 * @param {string} [options.query] - An encoded query string (sysparm_query)
 * @param {string|string[]} [options.fields] - Field names to include (sysparm_fields)
 * @param {number} [options.limit] - Max records to return (sysparm_limit)
 * @param {string} [options.displayValue] - Display value mode: "true", "false", or "all" (sysparm_display_value)
 * @returns {object} A query parameters object ready for the client
 */
function tableParams({ query, fields, limit, displayValue } = {}) {
	const params = { sysparm_exclude_reference_link: "true" };
	if (query) params.sysparm_query = query;
	if (fields) params.sysparm_fields = Array.isArray(fields) ? fields.join(",") : fields;
	if (limit) params.sysparm_limit = limit;
	if (displayValue !== undefined) params.sysparm_display_value = displayValue;
	return params;
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

// ── Background Script Tool ──────────────────────────────────────────────────

server.registerTool(
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

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`sn-mcp-bridge running — ${instanceURL}`);
