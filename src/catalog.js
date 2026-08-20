/**
 * Full-configuration description of a Service Catalog item, record producer, or order guide.
 *
 * The Service Catalog REST API (GET /api/sn_sc/servicecatalog/items/{sys_id}) only returns a
 * runtime-rendered view of an item — variable sets are flattened into containers, item config
 * (workflow, user criteria, catalogs) is absent, record producer fields are missing, and it 400s
 * when the calling user has no access to the item. So the Table API records are treated as the
 * source of truth here and the sn_sc payload rides along under "rendered_view" as best-effort.
 */

import { tableParams } from "./sn-client.js";

// Variable types (item_option_new.type) — mirrors the sys_choice list on question.type.
const VARIABLE_TYPES = {
	1: "Yes / No",
	2: "Multi Line Text",
	3: "Multiple Choice",
	4: "Numeric Scale",
	5: "Select Box",
	6: "Single Line Text",
	7: "CheckBox",
	8: "Reference",
	9: "Date",
	10: "Date/Time",
	11: "Label",
	12: "Break",
	14: "Custom",
	15: "UI Page",
	16: "Wide Single Line Text",
	17: "Custom with Label",
	18: "Lookup Select Box",
	19: "Container Start",
	20: "Container End",
	21: "List Collector",
	22: "Lookup Multiple Choice",
	23: "HTML",
	24: "Container Split",
	25: "Masked",
	26: "Email",
	27: "URL",
	28: "IP Address",
	29: "Duration",
	31: "Requested For",
	32: "Rich Text Label",
	33: "Attachment",
	40: "Table Name",
};

// Variable types whose options live in the question_choice table
const CHOICE_TYPES = ["1", "3", "5"];

// Variable types whose options live in an arbitrary lookup table (item_option_new.lookup_table)
const LOOKUP_TYPES = ["18", "22"];

// Record producer columns worth surfacing on their own, outside the raw item record
const PRODUCER_FIELDS = [
	"table_name", "script", "save_script", "post_insert_script",
	"redirect_url", "view", "allow_edit", "can_cancel", "save_options",
];

const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;

// Caps — every one of these reports when it truncates rather than silently dropping rows
const NAME_MATCH_LIMIT = 20;
const LOOKUP_OPTION_LIMIT = 100;
const MAX_LOOKUP_QUERIES = 20;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @name compact
 * @description Strips empty values from a record. The Table API returns every column on the table,
 * and item_option_new alone has ~60 of them — on a 30-variable item the empty strings drown out
 * the actual configuration.
 * @param {object} record - A record returned by the Table API
 * @returns {object} The record without its empty keys
 */
function compact(record) {
	if (!record || typeof record !== "object") return record;

	const compacted = {};
	for (const [key, value] of Object.entries(record)) {
		if (value === "" || value === null || value === undefined) continue;

		// With sysparm_display_value=all, each field is a { value, display_value } pair
		if (typeof value === "object" && "value" in value) {
			if (value.value === "" && !value.display_value) continue;
		}

		compacted[key] = value;
	}
	return compacted;
}

/**
 * @name rawValue
 * @description Reads a field that may be either a raw string or a display-value pair
 * @param {object} record - The record to read from
 * @param {string} field - The field name
 * @returns {string} The raw value, or "" when absent
 */
function rawValue(record, field) {
	const value = record?.[field];
	if (value && typeof value === "object") return value.value ?? "";
	return value ?? "";
}

/**
 * @name sysIdsOf
 * @description Collects the sys_ids of a set of records
 * @param {object[]} records - The records to read
 * @returns {string[]} The sys_ids
 */
function sysIdsOf(records) {
	return records.map((record) => rawValue(record, "sys_id")).filter(Boolean);
}

/**
 * @name groupBy
 * @description Groups records into a lookup keyed by one of their reference fields
 * @param {object[]} records - The records to group
 * @param {string} field - The field to group on
 * @returns {object} A map of field value to the matching records
 */
function groupBy(records, field) {
	const grouped = {};
	for (const record of records) {
		const key = rawValue(record, field);
		if (!key) continue;
		(grouped[key] ||= []).push(record);
	}
	return grouped;
}

/**
 * @name query
 * @description Runs a Table API query and returns the result rows
 * @param {SnClient} client - The ServiceNow client
 * @param {string} table - The table to query
 * @param {object} params - Options forwarded to tableParams
 * @returns {object[]} The matching records
 */
async function query(client, table, params) {
	const data = await client.get(`/api/now/table/${table}`, tableParams(params));
	return data.result || [];
}

// ── Identifier Resolution ───────────────────────────────────────────────────

/**
 * @name describeCandidates
 * @description Renders catalog item candidates as a JSON block for an error message, annotated with
 * the catalogs each one belongs to — usually the deciding factor when names collide.
 * @param {SnClient} client - The ServiceNow client
 * @param {object[]} candidates - The matching sc_cat_item records
 * @returns {string} A formatted JSON list
 */
async function describeCandidates(client, candidates) {
	const catalogLinks = await query(client, "sc_cat_item_catalog", {
		query: `sc_cat_itemIN${sysIdsOf(candidates).join(",")}`,
		fields: ["sc_cat_item", "sc_catalog"],
		displayValue: "all",
		limit: 200,
	});
	const catalogsByItem = groupBy(catalogLinks, "sc_cat_item");

	const described = candidates.map((candidate) => ({
		sys_id: rawValue(candidate, "sys_id"),
		name: candidate.name?.display_value ?? rawValue(candidate, "name"),
		sys_class_name: candidate.sys_class_name?.display_value ?? rawValue(candidate, "sys_class_name"),
		active: rawValue(candidate, "active"),
		short_description: rawValue(candidate, "short_description"),
		scope: candidate.sys_scope?.display_value ?? rawValue(candidate, "sys_scope"),
		updated: rawValue(candidate, "sys_updated_on"),
		catalogs: (catalogsByItem[rawValue(candidate, "sys_id")] || [])
			.map((link) => link.sc_catalog?.display_value)
			.filter(Boolean),
	}));

	return JSON.stringify(described, null, 2);
}

/**
 * @name resolveByName
 * @description Resolves a catalog item name to a single sys_id. Names are not unique in ServiceNow
 * — the same item can live in several catalogs, be cloned, or exist as an active/inactive pair — so
 * an ambiguous name throws with the candidate list instead of guessing.
 * @param {SnClient} client - The ServiceNow client
 * @param {string} name - The catalog item name
 * @param {boolean} [looksLikeSysId] - The input was shaped like a sys_id and failed to resolve as one
 * @returns {string} The resolved sys_id
 */
async function resolveByName(client, name, looksLikeSysId = false) {
	const candidateFields = [
		"sys_id", "name", "sys_class_name", "active",
		"short_description", "sys_scope", "sys_updated_on",
	];

	// sc_cat_item is the base table, so this covers record producers, order guides and content items
	const matches = await query(client, "sc_cat_item", {
		query: `name=${name}`,
		fields: candidateFields,
		displayValue: "all",
		limit: NAME_MATCH_LIMIT,
	});

	if (matches.length === 1) return rawValue(matches[0], "sys_id");

	if (matches.length > 1) {
		const truncated = matches.length === NAME_MATCH_LIMIT
			? `\n\nOnly the first ${NAME_MATCH_LIMIT} matches are shown — there may be more.`
			: "";
		throw new Error(
			`describe_catalog_item: "${name}" matches ${matches.length} catalog items. ` +
			`Re-run with the sys_id of the one you want:\n${await describeCandidates(client, matches)}${truncated}`
		);
	}

	// No exact match — look for near misses purely to make the error actionable
	const similar = await query(client, "sc_cat_item", {
		query: `nameLIKE${name}`,
		fields: candidateFields,
		displayValue: "all",
		limit: NAME_MATCH_LIMIT,
	});

	if (!similar.length) {
		// Report against whichever identifier the caller actually supplied
		throw new Error(looksLikeSysId
			? `describe_catalog_item: no catalog item found with sys_id ${name}, and no item is named that either`
			: `describe_catalog_item: no catalog item named "${name}" — no similar names found either`);
	}

	throw new Error(
		`describe_catalog_item: no catalog item named exactly "${name}". Similar items:\n` +
		`${await describeCandidates(client, similar)}`
	);
}

/**
 * @name resolveItem
 * @description Resolves a sys_id or name to the item's full record, read from its actual class
 * table. The base sc_cat_item table does not return subclass columns, so a record producer's
 * table_name/script only appear after re-reading from sc_cat_item_producer.
 * @param {SnClient} client - The ServiceNow client
 * @param {string} identifier - A sys_id or catalog item name
 * @returns {{ item: object, sysId: string, resolvedBy: string }}
 */
async function resolveItem(client, identifier) {
	let sysId = null;
	let resolvedBy = "name";
	const looksLikeSysId = SYS_ID_PATTERN.test(identifier);

	if (looksLikeSysId) {
		try {
			await client.get(`/api/now/table/sc_cat_item/${identifier}`, tableParams({ fields: ["sys_id"] }));
			sysId = identifier;
			resolvedBy = "sys_id";
		} catch {
			// Not a catalog item sys_id — a name can legitimately be 32 hex characters, so fall through
		}
	}

	if (!sysId) sysId = await resolveByName(client, identifier, looksLikeSysId);

	const base = await client.get(`/api/now/table/sc_cat_item/${sysId}`, tableParams());
	const className = base.result?.sys_class_name;

	if (!className || className === "sc_cat_item") return { item: base.result, sysId, resolvedBy };

	const actual = await client.get(`/api/now/table/${className}/${sysId}`, tableParams());
	return { item: actual.result || base.result, sysId, resolvedBy };
}

// ── Variable Enrichment ─────────────────────────────────────────────────────

/**
 * @name fetchLookupOptions
 * @description Resolves the selectable options for Lookup Select Box / Lookup Multiple Choice
 * variables by reading their lookup table. The sn_sc API does not return these. Identical lookups
 * are deduplicated so N variables pointing at the same table cost one call.
 * @param {SnClient} client - The ServiceNow client
 * @param {object[]} variables - The item_option_new records
 * @returns {object} A map of variable sys_id to { options, truncated, note }
 */
async function fetchLookupOptions(client, variables) {
	const lookupVariables = variables.filter(
		(variable) => LOOKUP_TYPES.includes(String(variable.type)) && variable.lookup_table
	);
	if (!lookupVariables.length) return {};

	// Build one request per distinct (table, query, fields) combination
	const requests = new Map();
	const byVariable = {};

	for (const variable of lookupVariables) {
		const referenceQual = variable.reference_qual || "";
		// A javascript: qualifier can only be evaluated server-side, so the options come back unfiltered
		const isScripted = referenceQual.trim().toLowerCase().startsWith("javascript:");
		const encodedQuery = isScripted ? "" : referenceQual;

		const fields = [...new Set([
			"sys_id",
			variable.lookup_value,
			...(variable.lookup_label || "").split(",").map((field) => field.trim()),
			variable.lookup_price,
			variable.rec_lookup_price,
		].filter(Boolean))];

		const key = `${variable.lookup_table}|${encodedQuery}|${fields.join(",")}`;
		if (!requests.has(key)) requests.set(key, { table: variable.lookup_table, encodedQuery, fields });

		byVariable[variable.sys_id] = {
			key,
			note: isScripted
				? "reference_qual is a script and was not evaluated server-side; options are unfiltered"
				: undefined,
		};
	}

	const keys = [...requests.keys()];
	const capped = keys.slice(0, MAX_LOOKUP_QUERIES);

	const results = await Promise.all(capped.map(async (key) => {
		const { table, encodedQuery, fields } = requests.get(key);
		try {
			const rows = await query(client, table, {
				query: encodedQuery,
				fields,
				limit: LOOKUP_OPTION_LIMIT,
			});
			return [key, { options: rows.map(compact), truncated: rows.length === LOOKUP_OPTION_LIMIT }];
		} catch (error) {
			return [key, { error: error.message }];
		}
	}));

	const resultsByKey = Object.fromEntries(results);
	const skipped = keys.slice(MAX_LOOKUP_QUERIES);

	const optionsByVariable = {};
	for (const [variableId, { key, note }] of Object.entries(byVariable)) {
		if (skipped.includes(key)) {
			optionsByVariable[variableId] = {
				note: `lookup options not resolved — this item exceeds the limit of ${MAX_LOOKUP_QUERIES} distinct lookup queries`,
			};
			continue;
		}
		optionsByVariable[variableId] = { ...resultsByKey[key], note };
	}

	return optionsByVariable;
}

/**
 * @name enrichVariables
 * @description Decorates variable records with their human-readable type, their question_choice
 * rows, and their resolved lookup options
 * @param {object[]} variables - The item_option_new records
 * @param {object} choicesByQuestion - question_choice records grouped by question
 * @param {object} lookupsByVariable - Lookup options keyed by variable sys_id
 * @returns {object[]} The enriched, compacted variables
 */
function enrichVariables(variables, choicesByQuestion, lookupsByVariable) {
	return variables.map((variable) => {
		const enriched = compact(variable);
		enriched.type_label = VARIABLE_TYPES[variable.type] || `Unknown (${variable.type})`;

		if (CHOICE_TYPES.includes(String(variable.type))) {
			enriched.choices = (choicesByQuestion[variable.sys_id] || []).map(compact);
		}

		const lookup = lookupsByVariable[variable.sys_id];
		if (lookup) {
			if (lookup.options) enriched.lookup_options = lookup.options;
			if (lookup.truncated) enriched.lookup_options_truncated = true;
			if (lookup.note) enriched.lookup_options_note = lookup.note;
			if (lookup.error) enriched.lookup_options_error = lookup.error;
		}

		return enriched;
	});
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * @name describeCatalogItem
 * @description Assembles the complete configuration of a catalog item, record producer, or order
 * guide: the item record, its variables and variable sets, catalog UI policies and their actions,
 * catalog client scripts, catalog/category placement, user criteria, and the rendered sn_sc view.
 * @param {SnClient} client - The ServiceNow client
 * @param {string} identifier - The sys_id or exact name of the item
 * @returns {object} The grouped configuration document
 */
export async function describeCatalogItem(client, identifier) {
	const { item, sysId, resolvedBy } = await resolveItem(client, identifier);

	const [
		itemVariables,
		setLinks,
		itemPolicies,
		itemScripts,
		catalogs,
		categories,
		availableFor,
		notAvailableFor,
		renderedView,
	] = await Promise.all([
		query(client, "item_option_new", { query: `cat_item=${sysId}^ORDERBYorder` }),
		query(client, "io_set_item", { query: `sc_cat_item=${sysId}^ORDERBYorder`, fields: ["sys_id", "variable_set", "order"], displayValue: "all" }),
		query(client, "catalog_ui_policy", { query: `catalog_item=${sysId}^ORDERBYorder` }),
		query(client, "catalog_script_client", { query: `cat_item=${sysId}` }),
		// The m2m rows only exist to carry one reference each — asking for every column would bury it
		query(client, "sc_cat_item_catalog", { query: `sc_cat_item=${sysId}`, fields: ["sys_id", "sc_catalog"], displayValue: "all" }),
		query(client, "sc_cat_item_category", { query: `sc_cat_item=${sysId}`, fields: ["sys_id", "sc_category"], displayValue: "all" }),
		query(client, "sc_cat_item_user_criteria_mtom", { query: `sc_cat_item=${sysId}`, fields: ["sys_id", "user_criteria"], displayValue: "all" }),
		query(client, "sc_cat_item_user_criteria_no_mtom", { query: `sc_cat_item=${sysId}`, fields: ["sys_id", "user_criteria"], displayValue: "all" }),
		// Best effort: sn_sc 400s when the caller has no access to the item, which is exactly when a
		// developer most needs to inspect it. Never let it fail the whole description.
		client.get(`/api/sn_sc/servicecatalog/items/${sysId}`)
			.then((data) => data.result)
			.catch((error) => ({ error: error.message })),
	]);

	// Variable sets carry their own variables, UI policies and client scripts
	const setIds = setLinks.map((link) => rawValue(link, "variable_set")).filter(Boolean);
	const [setRecords, setVariables, setPolicies, setScripts] = setIds.length
		? await Promise.all([
			query(client, "item_option_new_set", { query: `sys_idIN${setIds.join(",")}` }),
			query(client, "item_option_new", { query: `variable_setIN${setIds.join(",")}^ORDERBYorder` }),
			query(client, "catalog_ui_policy", { query: `variable_setIN${setIds.join(",")}^ORDERBYorder` }),
			query(client, "catalog_script_client", { query: `variable_setIN${setIds.join(",")}` }),
		])
		: [[], [], [], []];

	const allVariables = [...itemVariables, ...setVariables];
	const allPolicies = [...itemPolicies, ...setPolicies];

	const [choices, policyActions, lookupsByVariable] = await Promise.all([
		allVariables.length
			? query(client, "question_choice", { query: `questionIN${sysIdsOf(allVariables).join(",")}^ORDERBYorder`, limit: 1000 })
			: [],
		allPolicies.length
			? query(client, "catalog_ui_policy_action", { query: `ui_policyIN${sysIdsOf(allPolicies).join(",")}^ORDERBYorder` })
			: [],
		fetchLookupOptions(client, allVariables),
	]);

	const choicesByQuestion = groupBy(choices, "question");
	const actionsByPolicy = groupBy(policyActions, "ui_policy");

	const withActions = (policies) => policies.map((policy) => ({
		...compact(policy),
		actions: (actionsByPolicy[policy.sys_id] || []).map(compact),
	}));

	const variablesBySet = groupBy(setVariables, "variable_set");
	const policiesBySet = groupBy(setPolicies, "variable_set");
	const scriptsBySet = groupBy(setScripts, "variable_set");
	const setsById = Object.fromEntries(setRecords.map((set) => [set.sys_id, set]));

	const variableSets = setLinks.map((link) => {
		const setId = rawValue(link, "variable_set");
		return {
			...compact(setsById[setId] || { sys_id: setId }),
			order: rawValue(link, "order"),
			variables: enrichVariables(variablesBySet[setId] || [], choicesByQuestion, lookupsByVariable),
			ui_policies: withActions(policiesBySet[setId] || []),
			client_scripts: (scriptsBySet[setId] || []).map(compact),
		};
	});

	const className = item.sys_class_name || "sc_cat_item";
	const description = {
		resolved_by: resolvedBy,
		item_type: className,
		item: compact(item),
		placement: {
			catalogs: catalogs.map(compact),
			categories: categories.map(compact),
		},
		availability: {
			available_for: availableFor.map(compact),
			not_available_for: notAvailableFor.map(compact),
		},
		variables: enrichVariables(itemVariables, choicesByQuestion, lookupsByVariable),
		variable_sets: variableSets,
		ui_policies: withActions(itemPolicies),
		client_scripts: itemScripts.map(compact),
		rendered_view: renderedView,
		summary: {
			item_variables: itemVariables.length,
			variable_sets: variableSets.length,
			variable_set_variables: setVariables.length,
			// Totals — an item with no variables of its own can still inherit plenty from its sets
			ui_policies_total: allPolicies.length,
			client_scripts_total: itemScripts.length + setScripts.length,
		},
	};

	// Record producers carry their target table and scripts on the subclass — surface them up front.
	// Detected by the presence of table_name rather than an exact class match, so this also covers
	// sc_cat_item_composite_producer and any custom producer subclass.
	if ("table_name" in item) {
		description.record_producer = compact(
			Object.fromEntries(PRODUCER_FIELDS.map((field) => [field, item[field]]))
		);
	}

	return description;
}
