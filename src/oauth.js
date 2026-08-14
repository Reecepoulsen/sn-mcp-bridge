/**
 * OAuth 2.0 support for ServiceNow using the Authorization Code grant.
 *
 * The bridge runs as a stdio MCP server, so there is no UI to host a redirect. Instead the
 * first authorization spins up a short-lived loopback HTTP listener, opens the instance's
 * /oauth_auth.do page in the default browser, and catches the redirect back to
 * http://localhost:<port>/callback. Tokens are cached on disk so later runs are silent.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const CACHE_DIR = path.join(os.homedir(), ".sn-mcp-bridge");
const CACHE_FILE = path.join(CACHE_DIR, "tokens.json");

/** Treat a token as expired this many ms early to absorb clock skew and in-flight latency. */
const EXPIRY_SKEW_MS = 60 * 1000;

/** How long to wait for the user to complete the browser consent before giving up. */
const CONSENT_TIMEOUT_MS = 180 * 1000;

export const DEFAULT_REDIRECT_URI = "http://localhost:33380/callback";

export class OAuthProvider {
	/**
	 * @param {object} options
	 * @param {string} options.instance - The instance URL (e.g. https://mydev01.service-now.com)
	 * @param {string} options.clientId - OAuth client id from the SN Application Registry
	 * @param {string} options.clientSecret - OAuth client secret
	 * @param {string} [options.redirectUri] - Loopback redirect URL registered on the OAuth app
	 * @param {string} [options.refreshToken] - Optional pre-obtained refresh token to seed the cache
	 * @param {boolean} [options.usePkce] - Send an S256 code challenge with the authorization request
	 */
	constructor({ instance, clientId, clientSecret, redirectUri, refreshToken, usePkce = false }) {
		this.baseUrl = instance.replace(/\/+$/, "");
		this.clientId = clientId;
		this.clientSecret = clientSecret;
		this.redirectUri = redirectUri || DEFAULT_REDIRECT_URI;
		this.usePkce = usePkce;

		this.cacheKey = `${new URL(this.baseUrl).host}|${clientId}`;

		// In-memory view of the token state. Seeded from disk, then from the env var if provided.
		const cached = readCache()[this.cacheKey] || {};
		this.accessToken = cached.access_token || null;
		this.refreshToken = refreshToken || cached.refresh_token || null;
		this.expiresAt = cached.expires_at || 0;

		// Single-flight guard so concurrent tool calls can't open two browser windows.
		this._inFlight = null;
	}

	/**
	 * @name getAccessToken
	 * @description Returns a valid bearer token, refreshing or re-authorizing as needed.
	 * @param {object} [options]
	 * @param {boolean} [options.forceRefresh] - Ignore the in-memory token and mint a new one
	 * @returns {string} A valid access token
	 */
	async getAccessToken({ forceRefresh = false } = {}) {
		if (!forceRefresh && this.accessToken && Date.now() < this.expiresAt - EXPIRY_SKEW_MS) {
			return this.accessToken;
		}

		// Coalesce concurrent callers onto a single refresh/authorize round trip.
		if (!this._inFlight) {
			this._inFlight = this._acquire().finally(() => {
				this._inFlight = null;
			});
		}

		return this._inFlight;
	}

	/**
	 * @name prime
	 * @description Acquires a token up front so browser consent and misconfiguration surface at
	 * startup rather than on the first tool call.
	 * @returns {void}
	 */
	async prime() {
		await this.getAccessToken();
	}

	/**
	 * @name _acquire
	 * @description Mints a new access token — via refresh_token if one is available, otherwise via
	 * the interactive authorization code flow.
	 * @returns {string} The new access token
	 */
	async _acquire() {
		if (this.refreshToken) {
			try {
				return await this._refresh();
			} catch (error) {
				// Refresh tokens expire (100 days by default on ServiceNow). Rather than hard-failing,
				// drop the stale token and fall through to a fresh browser authorization.
				console.error(`sn-mcp-bridge: token refresh failed (${error.message}) — re-authorizing`);
				this.refreshToken = null;
			}
		}

		return this._authorizeInteractive();
	}

	/**
	 * @name _refresh
	 * @description Exchanges the stored refresh token for a new access token.
	 * @returns {string} The new access token
	 */
	async _refresh() {
		const tokens = await this._tokenRequest({
			grant_type: "refresh_token",
			refresh_token: this.refreshToken,
		});

		return this._storeTokens(tokens);
	}

	/**
	 * @name _authorizeInteractive
	 * @description Runs the full authorization code flow: starts a loopback listener, opens the
	 * browser to the instance's consent page, and exchanges the returned code for tokens.
	 * @returns {string} The new access token
	 */
	async _authorizeInteractive() {
		const state = crypto.randomBytes(16).toString("hex");
		const authUrl = new URL("/oauth_auth.do", this.baseUrl);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("client_id", this.clientId);
		authUrl.searchParams.set("redirect_uri", this.redirectUri);
		authUrl.searchParams.set("state", state);

		let codeVerifier = null;
		if (this.usePkce) {
			codeVerifier = base64Url(crypto.randomBytes(32));
			const challenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
			authUrl.searchParams.set("code_challenge", challenge);
			authUrl.searchParams.set("code_challenge_method", "S256");
		}

		// Start listening before opening the browser so a fast redirect can't race us.
		const codePromise = this._awaitCallback(state);

		console.error("sn-mcp-bridge: ServiceNow authorization required. Opening your browser…");
		console.error(`sn-mcp-bridge: if it does not open, visit this URL manually:\n${authUrl.href}`);
		openBrowser(authUrl.href);

		const code = await codePromise;

		const tokens = await this._tokenRequest({
			grant_type: "authorization_code",
			code,
			redirect_uri: this.redirectUri,
			...(codeVerifier ? { code_verifier: codeVerifier } : {}),
		});

		console.error("sn-mcp-bridge: authorization complete");
		return this._storeTokens(tokens);
	}

	/**
	 * @name _awaitCallback
	 * @description Runs a loopback HTTP server on the redirect URI's port and resolves with the
	 * authorization code once ServiceNow redirects the browser back to it.
	 * @param {string} expectedState - The state value sent on the authorize request
	 * @returns {string} The authorization code
	 */
	_awaitCallback(expectedState) {
		const redirect = new URL(this.redirectUri);
		const port = Number(redirect.port || 80);

		return new Promise((resolve, reject) => {
			let settled = false;
			const server = http.createServer();

			const finish = (fn, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				server.close();
				fn(value);
			};

			const timer = setTimeout(() => {
				finish(reject, new Error(
					`OAuthProvider - authorization timed out after ${CONSENT_TIMEOUT_MS / 1000}s waiting for the browser redirect to ${this.redirectUri}`
				));
			}, CONSENT_TIMEOUT_MS);

			server.on("request", (req, res) => {
				const requestUrl = new URL(req.url, redirect.origin);

				// The browser will also ask for /favicon.ico — ignore anything but the callback path.
				if (requestUrl.pathname !== redirect.pathname) {
					res.writeHead(404).end();
					return;
				}

				const error = requestUrl.searchParams.get("error");
				const code = requestUrl.searchParams.get("code");
				const state = requestUrl.searchParams.get("state");

				if (error) {
					respondHtml(res, 400, "Authorization failed", requestUrl.searchParams.get("error_description") || error);
					finish(reject, new Error(`OAuthProvider - authorization denied by ServiceNow: ${error}`));
					return;
				}

				if (state !== expectedState) {
					respondHtml(res, 400, "Authorization failed", "State mismatch — the response did not match this request.");
					finish(reject, new Error("OAuthProvider - state mismatch on the authorization callback"));
					return;
				}

				if (!code) {
					respondHtml(res, 400, "Authorization failed", "No authorization code was returned.");
					finish(reject, new Error("OAuthProvider - no authorization code in the callback"));
					return;
				}

				respondHtml(res, 200, "Authorized", "sn-mcp-bridge is connected. You can close this tab.");
				finish(resolve, code);
			});

			server.on("error", (err) => {
				const hint = err.code === "EADDRINUSE"
					? ` — port ${port} is already in use; set SN_<INSTANCE>_REDIRECT_URI to a free port and update the Redirect URL on the ServiceNow OAuth app`
					: "";
				finish(reject, new Error(`OAuthProvider - could not start the loopback listener${hint}: ${err.message}`));
			});

			server.listen(port, "127.0.0.1");
		});
	}

	/**
	 * @name _tokenRequest
	 * @description POSTs a form-encoded grant request to the instance's /oauth_token.do endpoint.
	 * @param {object} params - Grant-specific parameters (grant_type plus its inputs)
	 * @returns {object} The parsed token response
	 */
	async _tokenRequest(params) {
		const body = new URLSearchParams({
			client_id: this.clientId,
			client_secret: this.clientSecret,
			...params,
		});

		const response = await fetch(`${this.baseUrl}/oauth_token.do`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: body.toString(),
		});

		const text = await response.text();

		if (!response.ok) {
			throw new Error(`OAuthProvider - ${params.grant_type} request returned ${response.status}: ${text}`);
		}

		let tokens;
		try {
			tokens = JSON.parse(text);
		} catch {
			throw new Error(`OAuthProvider - ${params.grant_type} response was not JSON: ${text.slice(0, 200)}`);
		}

		if (!tokens.access_token) {
			throw new Error(`OAuthProvider - ${params.grant_type} response contained no access_token: ${text.slice(0, 200)}`);
		}

		return tokens;
	}

	/**
	 * @name _storeTokens
	 * @description Updates the in-memory token state and persists it to the on-disk cache.
	 * @param {object} tokens - A token response from /oauth_token.do
	 * @returns {string} The new access token
	 */
	_storeTokens(tokens) {
		this.accessToken = tokens.access_token;
		// ServiceNow access tokens default to 1800s. Some grants omit refresh_token on refresh —
		// keep the existing one in that case.
		this.refreshToken = tokens.refresh_token || this.refreshToken;
		this.expiresAt = Date.now() + Number(tokens.expires_in || 1800) * 1000;

		writeCache(this.cacheKey, {
			access_token: this.accessToken,
			refresh_token: this.refreshToken,
			expires_at: this.expiresAt,
		});

		return this.accessToken;
	}
}

/**
 * @name readCache
 * @description Reads the token cache, tolerating a missing or corrupt file.
 * @returns {object} A map of cache key → token record
 */
function readCache() {
	try {
		return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
	} catch {
		return {};
	}
}

/**
 * @name writeCache
 * @description Merges a token record into the cache file, creating it with owner-only permissions.
 * @param {string} key - The cache key (host|client_id)
 * @param {object} record - The token record to store
 */
function writeCache(key, record) {
	try {
		fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
		const cache = readCache();
		cache[key] = record;
		fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
	} catch (error) {
		// A non-writable home directory shouldn't take the server down — the token still works for
		// this process, the user just re-authorizes on the next start.
		console.error(`sn-mcp-bridge: could not persist tokens to ${CACHE_FILE}: ${error.message}`);
	}
}

/**
 * @name openBrowser
 * @description Best-effort launch of the platform's default browser. Failures are non-fatal since
 * the URL is also printed to stderr for manual use.
 * @param {string} url - The URL to open
 */
function openBrowser(url) {
	const [command, args] = process.platform === "darwin"
		? ["open", [url]]
		: process.platform === "win32"
			? ["cmd", ["/c", "start", "", url]]
			: ["xdg-open", [url]];

	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {
		// Ignored — the user can open the URL printed above by hand.
	}
}

/**
 * @name respondHtml
 * @description Writes a minimal HTML page to the loopback response.
 * @param {http.ServerResponse} res - The response to write to
 * @param {number} status - HTTP status code
 * @param {string} title - Page heading
 * @param {string} message - Body text
 */
function respondHtml(res, status, title, message) {
	res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	res.end(
		`<!doctype html><meta charset="utf-8"><title>${title}</title>` +
		`<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;text-align:center">` +
		`<h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body>`
	);
}

/**
 * @name base64Url
 * @description Base64url-encodes a buffer (RFC 7636 PKCE encoding).
 * @param {Buffer} buffer - The bytes to encode
 * @returns {string} The base64url string
 */
function base64Url(buffer) {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
