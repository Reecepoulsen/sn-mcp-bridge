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
	 * @name _getSession
	 * @description Logs in via the SN form endpoint and returns session cookies and CSRF token.
	 * Shared by executeScript and fetchNodeLogs.
	 * @returns {{ cookies: string, csrfToken: string }}
	 */
	async _getSession() {
		const formHeaders = {
			"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
			"User-Agent": "sn-mcp-bridge",
			"Accept": "*/*",
		};

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

		this._collectCookies(response, cookieMap);

		// Follow redirects manually to accumulate cookies across hops
		let maxRedirects = 10;
		while (response.status >= 300 && response.status < 400 && maxRedirects-- > 0) {
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
			throw new Error("SnClient - _getSession: no session cookies received from login");
		}

		const loginHtml = await response.text();
		const ckMatch = loginHtml.split("var g_ck = '");
		if (ckMatch.length < 2) {
			throw new Error(`SnClient - _getSession: unable to extract CSRF token (g_ck) from login response (status: ${response.status}, length: ${loginHtml.length})`);
		}
		const csrfToken = ckMatch[1].split("'")[0];

		return { cookies, csrfToken };
	}

	/**
	 * @name executeScript
	 * @description Executes a background script on the ServiceNow instance via the sys.scripts.do form endpoint.
	 * @param {string} script - The JavaScript code to execute
	 * @param {string} [scope="global"] - The app scope to run in ("global" or a scope sys_id)
	 * @returns {string} The script output extracted from the response
	 */
	async executeScript(script, scope = "global") {
		const { cookies, csrfToken } = await this._getSession();

		const formHeaders = {
			"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
			"User-Agent": "sn-mcp-bridge",
			"Accept": "*/*",
		};

		const scriptResponse = await fetch(
			`${this.baseUrl}/sys.scripts.do?sysparm_transaction_scope=${scope}`,
			{
				method: "POST",
				headers: { ...formHeaders, Cookie: cookies },
				redirect: "follow",
				body: new URLSearchParams({
					script,
					sysparm_ck: csrfToken,
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

		const scriptHtml = await scriptResponse.text();
		const preMatches = scriptHtml.match(/<PRE[^>]*>([\s\S]*?)<\/PRE>/gi);

		if (!preMatches || preMatches.length === 0) {
			return "(no output)";
		}

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
	 * @name fetchNodeLogs
	 * @description Fetches node log entries from the SN log file browser UI page (sys_id 261f9548c0a80164000574e69b0a7b29).
	 * This is the only way to access node-level logs from outside the server — Java APIs are security-restricted from scripts.
	 * @param {object} params
	 * @param {string} [params.startTime] - Start of time window in 'yyyy-MM-dd HH:mm:ss' format (instance local time)
	 * @param {string} [params.endTime] - End of time window
	 * @param {number} params.levelCode - Numeric level code (all=4, trace=5, debug=3, info=0, warning=1, error=2, fatal=6)
	 * @param {string} [params.session] - Filter by session ID
	 * @param {string} [params.messageFilter] - Filter by message content
	 * @param {string} [params.threadFilter] - Filter by thread name
	 * @param {boolean} [params.omitWorkers=true] - Omit background worker thread entries
	 * @param {number} [params.maxRows=500] - Maximum log rows to return
	 * @returns {{ count: number, entries: Array<{ timestamp, level, thread, session, message }> }}
	 */
	async fetchNodeLogs({ startTime, endTime, levelCode, session, messageFilter, threadFilter, omitWorkers = true, maxRows = 500 }) {
		const { cookies, csrfToken } = await this._getSession();

		const formBody = new URLSearchParams({
			sysparm_ck: csrfToken,
			start_time: startTime || "",
			end_time: endTime || "",
			level: String(levelCode),
			max_rows: String(Math.min(maxRows, 2000)),
			filter_session: session || "",
			message: messageFilter || "",
			filter_thread: threadFilter || "",
			omit_workers: omitWorkers ? "true" : "false",
			match_session: "true",
			match_level: String(levelCode),
			sys_action: "none",
		});

		const response = await fetch(
			`${this.baseUrl}/ui_page_process.do?sys_id=261f9548c0a80164000574e69b0a7b29`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
					"User-Agent": "sn-mcp-bridge",
					"Accept": "text/html,*/*",
					Cookie: cookies,
				},
				redirect: "follow",
				body: formBody.toString(),
			}
		);

		if (!response.ok) {
			throw new Error(`SnClient - fetchNodeLogs: request failed with status ${response.status}`);
		}

		const html = await response.text();
		return this._parseNodeLogHtml(html);
	}

	/**
	 * @name _parseNodeLogHtml
	 * @description Parses the HTML table returned by the SN log file browser into structured JSON.
	 * Each row has 5 cells: Timestamp, Level, Thread name, Session Id, Message.
	 * @param {string} html - The raw HTML response from ui_page_process.do
	 * @returns {{ count: number, entries: Array }}
	 */
	_parseNodeLogHtml(html) {
		// Detect login redirect — means session establishment failed
		if (html.includes('name="user_name"') && html.includes('name="user_password"')) {
			throw new Error("SnClient - fetchNodeLogs: got login page — session was not established");
		}

		const clean = (raw) => raw
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<[^>]+>/g, "")
			.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
			.replace(/&nbsp;/g, " ")
			.trim();

		const entries = [];
		let pos = 0;

		while (true) {
			const trStart = html.indexOf("<tr", pos);
			if (trStart === -1) break;

			const trEnd = html.indexOf("</tr>", trStart);
			if (trEnd === -1) break;

			const row = html.slice(trStart, trEnd + 5);
			pos = trEnd + 5;

			// Skip header rows
			if (/class="header"/i.test(row)) continue;

			// Extract all <td> cell contents
			const cells = [];
			let cellPos = 0;
			while (true) {
				const tdStart = row.indexOf("<td", cellPos);
				if (tdStart === -1) break;
				const tdContentStart = row.indexOf(">", tdStart) + 1;
				const tdEnd = row.indexOf("</td>", tdContentStart);
				if (tdEnd === -1) break;
				cells.push(row.slice(tdContentStart, tdEnd));
				cellPos = tdEnd + 5;
			}

			if (cells.length < 5) continue;

			entries.push({
				timestamp: clean(cells[0]),
				level: clean(cells[1]),
				thread: clean(cells[2]),
				session: clean(cells[3]),
				message: clean(cells[4]),
			});
		}

		return { count: entries.length, entries };
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
