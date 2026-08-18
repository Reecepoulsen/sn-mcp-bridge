/**
 * Small helpers shared by the tool modules. Kept out of index.js so feature modules can import them
 * without pulling in the server entrypoint.
 */

/**
 * @name ok
 * @description Wraps data in the MCP tool response format
 * @param {any} data - The data to return to the client
 * @returns {object} An MCP-compliant tool result with text content
 */
export function ok(data) {
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
export function tableParams({ query, fields, limit, displayValue } = {}) {
	const params = { sysparm_exclude_reference_link: "true" };
	if (query) params.sysparm_query = query;
	if (fields) params.sysparm_fields = Array.isArray(fields) ? fields.join(",") : fields;
	if (limit) params.sysparm_limit = limit;
	if (displayValue !== undefined) params.sysparm_display_value = displayValue;
	return params;
}
