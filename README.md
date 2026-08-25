# sn-mcp-bridge

A lightweight [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives AI coding assistants full development capability on ServiceNow — no installation required anywhere. It runs locally via `npx` and connects to ServiceNow through the Table API.

ServiceNow is a record-based development platform. Script includes, business rules, client scripts, UI actions, ACLs — every development artifact is a record in a system table. There is no separate "code layer"; the Table API **is** the development API. That means CRUD operations through this server aren't just for querying data — they're how you build:

- `insert_record` into `sys_script_include` → create a new script include
- `update_record` on `sys_script` → modify a business rule
- `query_data` on `sys_script_client` → read all client scripts for a table
- `delete_record` on `sys_ui_action` → remove a UI action

For tasks that go beyond CRUD — testing logic, running complex GlideRecord queries, calling script includes, or multi-step transactions — `execute_script` provides a full server-side JavaScript runtime.

The server runs with the permissions of whatever user account you provide credentials for — it can only read/write tables and fields that user has access to. The `execute_script` tool requires admin credentials since it runs background scripts via `sys.scripts.do`.

Authentication supports both **Basic Auth** and **OAuth 2.0 (authorization code)** — see [Authentication](#authentication).

There are plenty of open-source ServiceNow MCP servers being shared in the community. This one exists to stay simple, pure, and easy to improve — plain JS with no build step (5 source files, native `fetch`, Node.js 18+), and adding a tool is one `server.registerTool()` call.

## Tools

### CRUD

| Tool            | Description                                                                        |
| --------------- | ---------------------------------------------------------------------------------- |
| `query_data`    | Query records from any table with encoded queries, field selection, and pagination |
| `get_record`    | Retrieve a single record by sys_id                                                 |
| `insert_record` | Create a new record                                                                |
| `update_record` | Update an existing record                                                          |
| `delete_record` | Delete a record by sys_id                                                          |

### Schema & Discovery

| Tool                     | Description                                                                     |
| ------------------------ | ------------------------------------------------------------------------------- |
| `get_table_schema`       | Get table metadata including columns, types, choices, references, and hierarchy |
| `get_application_scopes` | List all application scopes on the instance                                     |
| `get_application_tables` | List tables belonging to a given scope                                          |
| `get_scoped_app_files`   | List all application files for a scope, grouped by type                         |

### Code Management

Every development artifact extends `sys_metadata`, so each write is stamped with an application scope and captured in an update set — both taken from the calling user's current context, not from the record you send. These tools make that context visible and controllable.

| Tool                       | Description                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `get_dev_context`          | Report the current application scope and update set, with warnings for anything that would misfile a write |
| `switch_dev_context`       | Set the current scope and update set. The only tool that changes context — the CRUD tools never do |
| `create_update_set`        | Create an update set (and make it current), optionally batched under a parent                     |
| `list_update_sets`         | List update sets with state, batch structure, and change counts                                   |
| `get_update_set_contents`  | List the changes an update set carries, grouped by type, following the batch hierarchy            |
| `set_update_set_state`     | Mark an update set Complete or Ignore, refusing to reopen a completed one                         |
| `batch_update_sets`        | Add update sets to a batch or remove them, by setting `parent`                                    |

Call `get_dev_context` before writing to any `sys_metadata`-derived table — a write made in the wrong context succeeds silently and lands in the wrong scope or an untracked update set. See [`src/code_management_and_migration/AI.md`](src/code_management_and_migration/AI.md) for the underlying platform rules.

### Analytics

| Tool               | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `aggregate_data`   | Run COUNT, AVG, MIN, MAX, SUM queries with optional grouping |
| `get_record_count` | Get a simple record count for a table and query              |

### Advanced

| Tool                    | Description                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `search_code`           | Search across script fields using the native Code Search API (falls back to table queries if the plugin is unavailable) |
| `generate_dbml`         | Generate a DBML schema diagram definition from the instance's tables and relationships                                  |
| `describe_catalog_item` | Get the full configuration of a catalog item, record producer, or order guide — variables (with choices and lookup options), variable sets, UI policies, client scripts, placement, and user criteria — in one call |
| `execute_script`        | Run a background script on the instance via sys.scripts.do ¹                                                            |

### Diagnostics

| Tool                         | Description                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `explore_syslog`             | Query the application log (`syslog`) — gs.info/warn/error output and exceptions ¹ |
| `explore_syslog_transaction` | Trace all log entries for a single transaction ¹                               |
| `explore_node_logs`          | Read node-level logs from the instance's log file browser ¹                    |

¹ These four tools require a username and password — see [Authentication](#authentication). They are not registered when only OAuth credentials are configured.

## Authentication

The bridge supports two modes. It picks OAuth when `CLIENT_ID`, `CLIENT_SECRET`, and `GRANT_TYPE` are set; otherwise it uses Basic Auth.

All variables follow the same naming convention: `<INSTANCE_NAME>` is the subdomain from `SN_INSTANCE`, uppercased with hyphens replaced by underscores (e.g. `https://mydev01.service-now.com` → `SN_MYDEV01_USERNAME`). If a prefixed variable isn't set, the bridge falls back to the unprefixed form (`SN_USERNAME`, `SN_CLIENT_ID`, …).

### Basic Auth

| Variable                      | Required | Description                                                |
| ----------------------------- | -------- | ---------------------------------------------------------- |
| `SN_INSTANCE`                 | yes      | Your instance URL (e.g. `https://mydev01.service-now.com`) |
| `SN_<INSTANCE_NAME>_USERNAME` | yes      | Username for basic auth                                    |
| `SN_<INSTANCE_NAME>_PASSWORD` | yes      | Password for basic auth                                    |

> **Warning:** The examples below use plaintext credentials to get you running quickly. This means your password is stored in a file on disk **and** visible to the AI assistant in every API call to the LLM provider. Once you've confirmed the connection works, it is highly recommended that you follow the [Securing Credentials with Secretless AI](#securing-credentials-with-secretless-ai) instructions to move plaintext secrets out of your config!

### OAuth 2.0 (Authorization Code)

OAuth keeps your ServiceNow password out of the config entirely. The bridge authorizes once through your browser, then refreshes a short-lived access token on its own.

**1. Register an OAuth application in ServiceNow.** Navigate to **System OAuth → Application Registry**, click **New**, and choose **Create an OAuth API endpoint for external clients**. Give it a name, set the **Redirect URL** to `http://localhost:33380/callback`, and save. Copy the generated **Client ID** and **Client Secret**.

**2. Configure the bridge:**

| Variable                          | Required | Description                                                                              |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `SN_INSTANCE`                     | yes      | Your instance URL                                                                        |
| `SN_<INSTANCE_NAME>_CLIENT_ID`     | yes      | Client ID from the Application Registry                                                  |
| `SN_<INSTANCE_NAME>_CLIENT_SECRET` | yes      | Client Secret from the Application Registry                                              |
| `SN_<INSTANCE_NAME>_GRANT_TYPE`    | yes      | `authorization_code` (the only supported grant type today)                               |
| `SN_<INSTANCE_NAME>_REDIRECT_URI`  | no       | Defaults to `http://localhost:33380/callback`. Must match the Redirect URL on the OAuth app |
| `SN_<INSTANCE_NAME>_REFRESH_TOKEN` | no       | Seed a refresh token obtained elsewhere to skip the browser step entirely                |
| `SN_<INSTANCE_NAME>_USE_PKCE`      | no       | Set to `true` to send an S256 code challenge. Off by default                             |

Setting any one of `CLIENT_ID` / `CLIENT_SECRET` / `GRANT_TYPE` without the others is a startup error rather than a silent fall-back to Basic Auth.

**3. First run.** The bridge opens your browser to the instance's consent page (the URL is also printed to stderr if it can't). After you approve, it captures the redirect on `localhost:33380` and exchanges the code for tokens.

> The first run blocks for up to three minutes waiting for you to approve in the browser. If your MCP client times out before you finish, the tokens have usually already been written — just reconnect and it will start silently.

**Token storage.** Tokens are cached in `~/.sn-mcp-bridge/tokens.json` (directory `0700`, file `0600`), keyed by instance host and client ID so multiple instances coexist in one file. Subsequent runs reuse the cached refresh token with no browser interaction. When the refresh token expires (100 days by default on ServiceNow), the browser flow re-triggers automatically. Delete the file to force a fresh authorization.

### Using both together

OAuth only covers the REST/Table API. `execute_script`, `explore_syslog`, `explore_syslog_transaction`, and `explore_node_logs` hit ServiceNow UI endpoints (`sys.scripts.do`, `ui_page_process.do`) that need a form-login session, which a bearer token cannot provide.

If you supply `USERNAME` and `PASSWORD` **alongside** the OAuth variables, REST traffic goes over OAuth and those four tools use the credentials for their session login. If you don't, the four tools are simply not registered — the assistant never sees them.

## Quick Start

### Claude Code

Add to `.mcp.json` in your project root (only available in that project) or `~/.claude/claude_code_config.json` (available in all projects):

```json
{
	"mcpServers": {
		"sn_mydev01": {
			"command": "npx",
			"args": ["-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://mydev01.service-now.com",
				"SN_MYDEV01_USERNAME": "your_username",
				"SN_MYDEV01_PASSWORD": "your_password"
			}
		}
	}
}
```

### OpenAI Codex

Add to `.codex/config.toml` in your project root (project-only, requires a trusted project) or `~/.codex/config.toml` (available in all projects):

```toml
[mcp_servers.sn_mydev01]
command = "npx"
args = ["-y", "sn-mcp-bridge"]

[mcp_servers.sn_mydev01.env]
SN_INSTANCE = "https://mydev01.service-now.com"
SN_MYDEV01_USERNAME = "your_username"
SN_MYDEV01_PASSWORD = "your_password"
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your project:

```json
{
	"servers": {
		"sn_mydev01": {
			"type": "stdio",
			"command": "npx",
			"args": ["-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://mydev01.service-now.com",
				"SN_MYDEV01_USERNAME": "your_username",
				"SN_MYDEV01_PASSWORD": "your_password"
			}
		}
	}
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
	"mcpServers": {
		"sn_mydev01": {
			"command": "npx",
			"args": ["-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://mydev01.service-now.com",
				"SN_MYDEV01_USERNAME": "your_username",
				"SN_MYDEV01_PASSWORD": "your_password"
			}
		}
	}
}
```

### Using OAuth instead

Swap the username/password pair for the OAuth variables. The `env` block below applies to every editor above — only the surrounding config syntax differs:

```json
{
	"mcpServers": {
		"sn_mydev01": {
			"command": "npx",
			"args": ["-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://mydev01.service-now.com",
				"SN_MYDEV01_CLIENT_ID": "your_client_id",
				"SN_MYDEV01_CLIENT_SECRET": "your_client_secret",
				"SN_MYDEV01_GRANT_TYPE": "authorization_code"
			}
		}
	}
}
```

To keep `execute_script` and the diagnostics tools available, add `SN_MYDEV01_USERNAME` and `SN_MYDEV01_PASSWORD` to that same block — see [Using both together](#using-both-together).

### Multiple Instances

Add a separate server entry for each instance. The config format is the same as above — just repeat the pattern with a different server name and instance-specific credentials.

## Securing Credentials with [Secretless AI](https://github.com/opena2a-org/secretless-ai)

[Secretless AI](https://github.com/opena2a-org/secretless-ai) stores your credentials in a secure backend and injects them at runtime via `secretless-ai run`.

The examples below secure a username and password, but the same approach works for `SN_MYDEV01_CLIENT_SECRET` if you're using OAuth.

### Setup

**1. Store your credentials:**

```bash
npx secretless-ai secret set SN_MYDEV01_USERNAME=your_username

# Omit the value so it prompts interactively — keeps the password out of shell history
npx secretless-ai secret set SN_MYDEV01_PASSWORD
```

**2. Update your MCP config** to use `secretless-ai run` as a wrapper. The `--only` flag tells it which secrets to inject. `SN_INSTANCE` is not a secret and stays in the env block:

```json
{
	"mcpServers": {
		"sn_mydev01": {
			"command": "npx",
			"args": ["-y", "secretless-ai", "run", "--only", "SN_MYDEV01_USERNAME,SN_MYDEV01_PASSWORD", "--", "npx", "-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://mydev01.service-now.com"
			}
		}
	}
}
```

For multiple instances, repeat the pattern — store each instance's credentials under its prefixed names and add a server entry with the corresponding `--only` list:

```json
{
	"mcpServers": {
		"sn_mydev01": {
			"command": "npx",
			"args": ["-y", "secretless-ai", "run", "--only", "SN_MYDEV01_USERNAME,SN_MYDEV01_PASSWORD", "--", "npx", "-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://mydev01.service-now.com"
			}
		},
		"sn_myprod01": {
			"command": "npx",
			"args": ["-y", "secretless-ai", "run", "--only", "SN_MYPROD01_USERNAME,SN_MYPROD01_PASSWORD", "--", "npx", "-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://myprod01.service-now.com"
			}
		}
	}
}
```

The config format for other editors follows the same pattern shown in [Quick Start](#quick-start) — just replace the `command`/`args` with the secretless wrapper.

### Supported Backends

| Backend              | Flag                  | Best for                                                                                          |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| OS Keychain          | `--backend keychain`  | **macOS (recommended)** — uses the built-in Keychain, secured by your login password and Touch ID |
| Local encrypted file | `--backend local`     | **Windows (recommended)** — AES-256-GCM encrypted file, no extra software needed                  |
| 1Password            | `--backend 1password` | Teams and CI/CD, or Windows users with 1Password already installed                                |
| HashiCorp Vault      | `--backend vault`     | Enterprise and self-hosted deployments                                                            |
| GCP Secret Manager   | `--backend gcp-sm`    | GCP-native workloads                                                                              |

### Alternative: `protect-mcp`

If your MCP configs are in **global** config paths (e.g. `~/.vscode/mcp.json`, `~/.cursor/mcp.json`), you can use `protect-mcp` to automatically scan and secure them in one shot:

```bash
npx secretless-ai protect-mcp --backend keychain
```

You can check status or revert with `mcp-status` and `mcp-unprotect`:

```bash
npx secretless-ai mcp-status
npx secretless-ai mcp-unprotect
```

> **Limitation:** `protect-mcp`, `mcp-status`, and `mcp-unprotect` only discover global config files. They do **not** find workspace-level configs like `.vscode/mcp.json`, `.mcp.json`, or `.codex/config.toml` inside project directories. For workspace configs, use the `secret set` + `run` approach above.

For more details on Secretless AI, see the [full documentation](https://github.com/opena2a-org/secretless-ai).

## Requirements

- Node.js 18+ (for native `fetch`)
- A ServiceNow instance with REST API access
- Either basic auth credentials for the instance, or a registered OAuth application (see [Authentication](#authentication))

## License

MIT
