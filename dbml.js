/**
 * DBML generation for ServiceNow table schemas.
 * Fetches enriched schema data via the Table API and converts it to DBML strings.
 */

const SYS_COLUMNS = [
	"sys_class_name", "sys_created_by", "sys_created_on",
	"sys_mod_count", "sys_updated_by", "sys_updated_on",
];

const REF_FIELD_TYPES = ["reference", "glide_list"];

// ── API Helpers ────────────────────────────────────────────────────────────

/**
 * @name qp
 * @description Builds sysparm query parameters for a Table API request
 * @param {object} [options]
 * @param {string} [options.query] - Encoded query string
 * @param {string[]} [options.fields] - Fields to include
 * @param {number} [options.limit] - Max records
 * @returns {object} Query parameters object
 */
function qp({ query, fields, limit } = {}) {
	const p = { sysparm_exclude_reference_link: "true" };
	if (query) p.sysparm_query = query;
	if (fields) p.sysparm_fields = fields.join(",");
	if (limit) p.sysparm_limit = limit;
	return p;
}

// ── Schema Fetching ────────────────────────────────────────────────────────

/**
 * @name getTableHierarchy
 * @description Walks up the super_class chain to build the full table hierarchy.
 *              Starts from the known first parent to avoid re-querying the base table.
 * @param {SnClient} client - The ServiceNow client
 * @param {string} tableName - The starting table name
 * @param {string} firstParent - The immediate parent table name (from initial metadata query)
 * @returns {string[]} Hierarchy array, child first (e.g. ["incident", "task"])
 */
async function getTableHierarchy(client, tableName, firstParent) {
	const hierarchy = [tableName];
	let current = firstParent;

	while (current) {
		hierarchy.push(current);
		const resp = await client.get("/api/now/table/sys_db_object", qp({
			query: `name=${current}`,
			fields: ["super_class.name"],
			limit: 1,
		}));
		current = resp.result?.[0]?.["super_class.name"] || null;
	}

	return hierarchy;
}

/**
 * @name fetchTableSchema
 * @description Fetches an enriched table schema for DBML generation via the Table API.
 * @param {SnClient} client - The ServiceNow client
 * @param {string} tableName - The table name
 * @param {object} [options]
 * @param {boolean} [options.getInheritedColumns] - Include columns from parent tables
 * @param {boolean} [options.getSysColumns] - Include system columns
 * @param {boolean} [options.onlyReferences] - Only reference fields and primary keys
 * @returns {object} The enriched table schema object
 */
async function fetchTableSchema(client, tableName, options = {}) {
	const { getInheritedColumns, getSysColumns, onlyReferences } = options;

	// Get table metadata with dot-walked parent and scope info
	const metaResp = await client.get("/api/now/table/sys_db_object", qp({
		query: `name=${tableName}`,
		fields: [
			"name", "label",
			"super_class.name", "super_class.label", "super_class.sys_scope.scope",
			"sys_scope.scope",
		],
		limit: 1,
	}));

	const meta = metaResp.result?.[0];
	if (!meta) throw new Error(`generate_dbml: table '${tableName}' not found`);

	const tableSchema = {
		name: tableName,
		label: meta.label || tableName,
		scope: meta["sys_scope.scope"] || "global",
		columns: [],
		referencedTables: [],
	};

	// Set up parent/extends info if this table has a parent
	const parentName = meta["super_class.name"];
	if (parentName) {
		tableSchema.extends = {
			name: parentName,
			label: meta["super_class.label"] || parentName,
			scope: meta["super_class.sys_scope.scope"] || "global",
		};
	}

	// Build hierarchy for inherited columns
	let hierarchy = [tableName];
	if (getInheritedColumns && parentName) {
		hierarchy = await getTableHierarchy(client, tableName, parentName);
		tableSchema.hierarchy = hierarchy;
	}

	// Build dictionary query
	let dictQuery = getInheritedColumns
		? `nameIN${hierarchy.join(",")}`
		: `name=${tableName}`;
	if (onlyReferences) dictQuery += "^internal_typeINreference,glide_list^ORprimary=true";
	if (!getSysColumns) dictQuery += `^elementNOT IN${SYS_COLUMNS.join(",")}`;
	dictQuery += "^active=true^internal_type!=collection";
	dictQuery += "^ORDERBYDESCprimary^ORDERBYname^ORDERBYinternal_type^ORDERBYelement";

	// Fetch dictionary and choices in parallel
	const [dictResp, choiceResp] = await Promise.all([
		client.get("/api/now/table/sys_dictionary", qp({
			query: dictQuery,
			fields: [
				"element", "column_label", "internal_type", "name",
				"mandatory", "primary", "unique",
				"reference", "reference_qual", "reference_cascade_rule",
			],
			limit: 500,
		})),
		client.get("/api/now/table/sys_choice", qp({
			query: `name=${tableName}^inactive=false^ORDERBYelement^ORDERBYsequence`,
			fields: ["element", "value", "label", "sequence"],
			limit: 1000,
		})),
	]);

	// Build choices lookup keyed by field name
	const choicesByField = {};
	for (const c of choiceResp.result || []) {
		(choicesByField[c.element] ||= []).push({
			label: c.label,
			value: c.value,
			sequence: c.sequence,
		});
	}

	// Process columns
	const referencedTableNames = new Set();

	for (const col of dictResp.result || []) {
		if (!col.element) continue;

		const columnTable = col.name;
		const inherited = columnTable !== tableName;

		// Skip inherited sys_id to prevent duplicates
		if (inherited && col.element === "sys_id") continue;

		const column = { label: col.column_label, name: col.element, type: col.internal_type };

		if (inherited) column.inheritedFrom = columnTable;
		if (col.primary === "true") column.primary = true;
		if (col.unique === "true") column.unique = true;
		if (col.mandatory === "true") column.mandatory = true;

		// Track inherited column source tables as referenced
		if (inherited && !tableSchema.referencedTables.includes(columnTable)) {
			tableSchema.referencedTables.push(columnTable);
		}

		// Reference details
		const refTable = col.reference;
		if (REF_FIELD_TYPES.includes(col.internal_type) && refTable) {
			column.reference = { table: refTable, field: "sys_id" };

			const qualifier = col.reference_qual;
			if (qualifier) column.reference.qualifier = qualifier;

			const cascadeRule = col.reference_cascade_rule;
			if (cascadeRule && cascadeRule !== "none") column.reference.cascadeRule = cascadeRule;

			referencedTableNames.add(refTable);
			if (!tableSchema.referencedTables.includes(refTable)) {
				tableSchema.referencedTables.push(refTable);
			}
		}

		// Add choices for choice-type columns
		if (col.internal_type === "choice" && choicesByField[col.element]) {
			column.choices = choicesByField[col.element];
		}

		tableSchema.columns.push(column);
	}

	// Resolve scopes for all referenced tables in a single batch query
	if (referencedTableNames.size > 0) {
		const scopeResp = await client.get("/api/now/table/sys_db_object", qp({
			query: `nameIN${[...referencedTableNames].join(",")}`,
			fields: ["name", "sys_scope.scope"],
			limit: referencedTableNames.size,
		}));

		const scopeMap = {};
		for (const r of scopeResp.result || []) {
			scopeMap[r.name] = r["sys_scope.scope"] || "global";
		}

		for (const col of tableSchema.columns) {
			if (col.reference) col.reference.scope = scopeMap[col.reference.table] || "global";
		}
	}

	return tableSchema;
}

// ── DBML String Generation ─────────────────────────────────────────────────

/**
 * @name tableToDBML
 * @description Converts a table schema object to a DBML table definition string
 * @param {object} tableSchema - The enriched table schema
 * @returns {string} DBML string for the table (including any choice enums)
 */
function tableToDBML(tableSchema) {
	const lines = [];
	const enums = [];

	// Table header with optional extends note
	let header = `Table ${tableSchema.scope}.${tableSchema.name}`;
	if (tableSchema.extends) header += ` [note: "Extends ${tableSchema.extends.name}"]`;
	header += " {";
	lines.push(header);

	for (const column of tableSchema.columns) {
		const details = [];

		// Column flags
		const flags = [];
		if (column.primary) flags.push("pk");
		if (column.unique) flags.push("unique");
		if (column.mandatory) flags.push("not null");
		if (flags.length > 0) details.push(flags.join(", "));

		// One-to-one relationship between child and parent primary keys
		if (tableSchema.extends && column.primary) {
			details.push(`ref: - ${tableSchema.extends.scope}.${tableSchema.extends.name}.sys_id`);
		}

		// Reference relationships
		if (column.reference) {
			const symbol = column.type === "glide_list" ? "<>" : ">"; // Many-to-many vs many-to-one
			details.push(`ref: ${symbol} ${column.reference.scope}.${column.reference.table}.${column.reference.field}`);
		}

		// Notes for extra context
		const notes = [];
		if (column.inheritedFrom) notes.push(`Inherited: ${column.inheritedFrom}`);
		if (column.name.split("_").join(" ").toLowerCase() !== column.label.toLowerCase()) {
			notes.push(`Label: ${column.label}`);
		}
		if (column.reference?.qualifier) notes.push(`Ref Qualifier: ${column.reference.qualifier}`);
		if (column.reference?.cascadeRule) notes.push(`Cascade Rule: ${column.reference.cascadeRule}`);
		if (notes.length > 0) {
			const noteText = notes.join(", ").replace(/"/g, '\\"');
			details.push(`note: "${noteText}"`);
		}

		// Build choice enum and swap the type to the enum name
		let type = column.type;
		if (type === "choice" && column.choices?.length > 0) {
			const enumName = `${tableSchema.name}.${column.name}`;
			type = enumName;
			enums.push(choiceEnumToDBML(enumName, column.choices));
		}

		// Build the column line
		let line = `${column.name} ${type}`;
		if (details.length > 0) line += ` [${details.join(", ")}]`;
		lines.push(`\t${line}`);
	}

	lines.push("}");

	return [...lines, ...enums].join("\n");
}

/**
 * @name choiceEnumToDBML
 * @description Generates a DBML enum definition for a choice field
 * @param {string} enumName - The enum name (tableName.columnName)
 * @param {Array} choices - Array of {label, value, sequence} objects
 * @returns {string} DBML enum string
 */
function choiceEnumToDBML(enumName, choices) {
	const lines = [`\nEnum ${enumName} {`];
	for (const choice of choices) {
		lines.push(`\t"${choice.label} | ${choice.value}"`);
	}
	lines.push("}");
	return lines.join("\n");
}

// ── Main Entry Point ───────────────────────────────────────────────────────

/**
 * @name generateDBML
 * @description Generates DBML for all ServiceNow tables matching the given encoded query.
 *              Includes reference helper stubs for any tables that are referenced but not
 *              part of the main result set.
 * @param {SnClient} client - The ServiceNow client instance
 * @param {string} encodedQuery - An encoded query against the sys_db_object table
 * @param {object} [options]
 * @param {boolean} [options.getInheritedColumns] - Include inherited columns from parent tables
 * @param {boolean} [options.getSysColumns] - Include system columns
 * @param {boolean} [options.onlyReferences] - Only reference fields and primary keys
 * @param {number} [options.limit] - Max tables to include
 * @returns {string} The complete DBML string
 */
export async function generateDBML(client, encodedQuery, options = {}) {
	const { limit } = options;

	// Query sys_db_object for all matching tables
	const tableResp = await client.get("/api/now/table/sys_db_object", qp({
		query: encodedQuery + "^ORDERBYname",
		fields: ["name"],
		limit: limit || 200,
	}));

	const tableNames = (tableResp.result || []).map((r) => r.name);
	if (tableNames.length === 0) return "";

	// Fetch enriched schemas for all tables in parallel
	const tableSchemas = await Promise.all(
		tableNames.map((name) => fetchTableSchema(client, name, options))
	);

	// Convert each schema to DBML
	const includedTables = new Set(tableNames);
	const dbmlChunks = tableSchemas.map(tableToDBML);

	// Collect out-of-scope referenced tables (referenced but not in the main result set)
	const refHelperNames = new Set();
	for (const schema of tableSchemas) {
		for (const ref of schema.referencedTables || []) {
			if (!includedTables.has(ref)) refHelperNames.add(ref);
		}
		if (schema.extends && !includedTables.has(schema.extends.name)) {
			refHelperNames.add(schema.extends.name);
		}
	}

	// Build lightweight reference helper stubs
	let refHelpers = [];
	if (refHelperNames.size > 0) {
		const refResp = await client.get("/api/now/table/sys_db_object", qp({
			query: `nameIN${[...refHelperNames].join(",")}`,
			fields: ["name", "sys_scope.scope"],
			limit: refHelperNames.size,
		}));

		refHelpers = (refResp.result || []).map((r) => {
			const scope = r["sys_scope.scope"] || "global";
			return `\nTable ${scope}.${r.name} {\n\tsys_id GUID [pk]\n}`;
		});
	}

	// Assemble final DBML
	let dbml = dbmlChunks.join("\n\n");
	if (refHelpers.length > 0) {
		dbml += `\n\n// REFERENCE HELPERS\n${refHelpers.join("\n")}`;
	}

	return dbml;
}
