/**
 * ServiceNow Table API client using native fetch with Basic Auth.
 * Wraps the standard REST Table API endpoints for CRUD operations.
 */
export class SnClient {
	constructor({ instance, username, password }) {
		this.baseUrl = instance.replace(/\/+$/, "");
		this.username = username;
		this.password = password;
		this.authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
	}

	/**
	 * @name request
	 * @description Executes an HTTP request against the ServiceNow instance
	 * @param {string} method - The HTTP method (GET, POST, PATCH, DELETE)
	 * @param {string} path - The API path (e.g. /api/now/table/incident)
	 * @param {object} [options] - Optional request options
	 * @param {object} [options.params] - Query parameters to append to the URL
	 * @param {object} [options.body] - JSON body for POST/PATCH requests
	 * @returns {object|null} The parsed JSON response, or null for 204 responses
	 */
	async request(method, path, { params, body } = {}) {
		const url = new URL(path, this.baseUrl);

		// Append query parameters to the URL
		if (params) {
			for (const [paramName, paramValue] of Object.entries(params)) {
				if (paramValue === undefined || paramValue === null) continue;

				url.searchParams.set(paramName, String(paramValue));
			}
		}

		const headers = {
			Authorization: this.authHeader,
			Accept: "application/json",
		};
		if (body) headers["Content-Type"] = "application/json";

		const response = await fetch(url, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			const badResponseText = await response.text();
			throw new Error(`SnClient - request: ${method} ${path} returned ${response.status}: ${badResponseText}`);
		}

		// DELETE returns 204 No Content
		if (response.status === 204) return null;

		return response.json();
	}

	/**
	 * @name get
	 * @description Executes a GET request
	 * @param {string} path - The API path
	 * @param {object} [params] - Query parameters
	 * @returns {object} The parsed JSON response
	 */
	get(path, params) {
		return this.request("GET", path, { params });
	}

	/**
	 * @name post
	 * @description Executes a POST request with a JSON body
	 * @param {string} path - The API path
	 * @param {object} body - The request body
	 * @returns {object} The parsed JSON response
	 */
	post(path, body) {
		return this.request("POST", path, { body });
	}

	/**
	 * @name patch
	 * @description Executes a PATCH request with a JSON body
	 * @param {string} path - The API path
	 * @param {object} body - The request body
	 * @returns {object} The parsed JSON response
	 */
	patch(path, body) {
		return this.request("PATCH", path, { body });
	}

	/**
	 * @name del
	 * @description Executes a DELETE request
	 * @param {string} path - The API path
	 * @returns {null} Returns null (204 No Content)
	 */
	del(path) {
		return this.request("DELETE", path);
	}

	/**
	 * @name executeScript
	 * @description Executes a background script on the ServiceNow instance via the sys.scripts.do form endpoint.
	 * @param {string} script - The JavaScript code to execute
	 * @param {string} [scope="global"] - The app scope to run in ("global" or a scope sys_id)
	 * @returns {string} The script output extracted from the response
	 */
	async executeScript(script, scope = "global") {
		const formHeaders = {
			"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
			"User-Agent": "sn-mcp-bridge",
			"Accept": "*/*",
		};

		// Step 1: Login with manual redirect handling to capture cookies from all responses
		const cookieMap = {};

		let response = await fetch(`${this.baseUrl}/login.do`, {
			method: "POST",
			headers: formHeaders,
			redirect: "manual",
			body: new URLSearchParams({
				user_name: this.username,
				user_password: this.password,
				remember_me: "true",
				sys_action: "sysverb_login",
			}).toString(),
		});

		// Collect cookies using a map to handle cookie updates/overwrites
		this._collectCookies(response, cookieMap);

		// Follow redirects manually to accumulate cookies across hops
		let maxRedirects = 10;
		while (response.status >= 300 && response.status < 400 && maxRedirects-- > 0) {
			// Consume the body to free the connection
			await response.text();

			const location = response.headers.get("location");
			if (!location) break;

			const redirectUrl = location.startsWith("http") ? location : new URL(location, this.baseUrl).href;
			response = await fetch(redirectUrl, {
				method: "GET",
				headers: { ...formHeaders, Cookie: this._cookieString(cookieMap) },
				redirect: "manual",
			});

			this._collectCookies(response, cookieMap);
		}

		const cookies = this._cookieString(cookieMap);
		if (!cookies) {
			throw new Error("SnClient - executeScript: no session cookies received from login");
		}

		// Step 2: Extract CSRF token from the final page HTML
		const loginHtml = await response.text();
		const ckMatch = loginHtml.split("var g_ck = '");
		if (ckMatch.length < 2) {
			throw new Error(`SnClient - executeScript: unable to extract CSRF token (g_ck) from login response (status: ${response.status}, length: ${loginHtml.length})`);
		}
		const sysparmCk = ckMatch[1].split("'")[0];

		// Step 3: Execute the background script
		const scriptResponse = await fetch(
			`${this.baseUrl}/sys.scripts.do?sysparm_transaction_scope=${scope}`,
			{
				method: "POST",
				headers: { ...formHeaders, Cookie: cookies },
				redirect: "follow",
				body: new URLSearchParams({
					script,
					sysparm_ck: sysparmCk,
					sys_scope: scope,
					runscript: "Run script",
					quota_managed_transaction: "on",
					record_for_rollback: "on",
				}).toString(),
			}
		);

		if (!scriptResponse.ok) {
			throw new Error(`SnClient - executeScript: script execution failed with status ${scriptResponse.status}`);
		}

		// Step 4: Extract output from <PRE> tags in the HTML response
		const scriptHtml = await scriptResponse.text();
		const preMatches = scriptHtml.match(/<PRE[^>]*>([\s\S]*?)<\/PRE>/gi);

		if (!preMatches || preMatches.length === 0) {
			return "(no output)";
		}

		// Strip the PRE tags and clean up HTML entities
		return preMatches
			.map((m) => m
				.replace(/<\/?PRE[^>]*>/gi, "")
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
				.trim()
			)
			.join("\n");
	}

	/**
	 * @name _collectCookies
	 * @description Extracts Set-Cookie headers from a response and merges them into a cookie map
	 * @param {Response} response - The fetch Response object
	 * @param {object} cookieMap - A map of cookie name → value to update
	 */
	_collectCookies(response, cookieMap) {
		for (const setCookieHeader of response.headers.getSetCookie?.() || []) {
			const cookiePair = setCookieHeader.split(";")[0];
			const separatorIndex = cookiePair.indexOf("=");
			if (separatorIndex > 0) {
				const cookieName = cookiePair.substring(0, separatorIndex);
				const cookieValue = cookiePair.substring(separatorIndex + 1);
				cookieMap[cookieName] = cookieValue;
			}
		}
	}

	/**
	 * @name _cookieString
	 * @description Builds a Cookie header string from a cookie map
	 * @param {object} cookieMap - A map of cookie name → value
	 * @returns {string} A Cookie header value string
	 */
	_cookieString(cookieMap) {
		return Object.entries(cookieMap)
			.map(([name, value]) => `${name}=${value}`)
			.join("; ");
	}
}
