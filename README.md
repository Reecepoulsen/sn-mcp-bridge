# sn-mcp-bridge

A lightweight [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for ServiceNow. Connects any MCP-compatible AI coding assistant to your ServiceNow instance through the standard REST APIs — no installation on the platform required.

- **13 tools** covering CRUD, schema introspection, app discovery, aggregation, code search, and background script execution
- **Plain JS, no build step** — 2 source files, native `fetch`, runs on Node.js 18+
- **Easy to extend** — adding a tool is one `server.registerTool()` call

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

### Analytics

| Tool               | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `aggregate_data`   | Run COUNT, AVG, MIN, MAX, SUM queries with optional grouping |
| `get_record_count` | Get a simple record count for a table and query              |

### Advanced

| Tool             | Description                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `search_code`    | Search across script fields using the native Code Search API (falls back to table queries if the plugin is unavailable) |
| `execute_script` | Run a background script on the instance via sys.scripts.do                                                              |

## Why CRUD = Full Development

ServiceNow is a record-based development platform. Script includes, business rules, client scripts, UI actions, ACLs — every development artifact is a record in a system table. There is no separate "code layer"; the Table API **is** the development API.

That means the CRUD tools in this server aren't just for querying data — they give you full development capability:

- `insert_record` into `sys_script_include` → create a new script include
- `update_record` on `sys_script` → modify a business rule
- `query_data` on `sys_script_client` → read all client scripts for a table
- `delete_record` on `sys_ui_action` → remove a UI action

For tasks that go beyond what CRUD can accomplish — testing logic, running complex GlideRecord queries, calling script includes, or performing multi-step transactions — use `execute_script` as a full server-side JavaScript runtime.

## Quick Start

```bash
npx sn-mcp-bridge
```

## Configuration

### Environment Variables

| Variable      | Required | Description                                                |
| ------------- | -------- | ---------------------------------------------------------- |
| `SN_INSTANCE` | Yes      | Your instance URL (e.g. `https://mydev01.service-now.com`) |
| `SN_USERNAME` | Yes      | Username for basic auth                                    |
| `SN_PASSWORD` | Yes      | Password for basic auth                                    |

The examples below use plaintext credentials to get you up and running quickly. **Once you've confirmed the connection works, we strongly recommend securing your credentials** using [Secretless AI](https://github.com/opena2a-org/secretless-ai) — see [Securing Credentials](#securing-credentials).

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
				"SN_USERNAME": "your_username",
				"SN_PASSWORD": "your_password"
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
SN_USERNAME = "your_username"
SN_PASSWORD = "your_password"
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your project:

```json
{
	"servers": {
		"sn_mydev01": {
			"command": "npx",
			"args": ["-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://mydev01.service-now.com",
				"SN_USERNAME": "your_username",
				"SN_PASSWORD": "your_password"
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
				"SN_USERNAME": "your_username",
				"SN_PASSWORD": "your_password"
			}
		}
	}
}
```

### Multiple Instances

Configure separate server entries for each instance. Use the instance identifier as the server name so credentials don't collide:

```json
{
	"mcpServers": {
		"sn_mydev01": {
			"command": "npx",
			"args": ["-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://mydev01.service-now.com",
				"SN_USERNAME": "your_username",
				"SN_PASSWORD": "your_password"
			}
		},
		"sn_myprod01": {
			"command": "npx",
			"args": ["-y", "sn-mcp-bridge"],
			"env": {
				"SN_INSTANCE": "https://myprod01.service-now.com",
				"SN_USERNAME": "your_username",
				"SN_PASSWORD": "your_password"
			}
		}
	}
}
```

## Securing Credentials

The configuration examples above store your username and password as plaintext in JSON/TOML files. This has two problems:

1. **On disk** — anyone with access to the file can read your password
2. **In AI context** — the credentials are visible to the AI assistant and included in API calls to the LLM provider

[Secretless AI](https://github.com/opena2a-org/secretless-ai) fixes this. It scans your MCP configs, moves credentials to a secure backend (like macOS Keychain), and rewrites the config so credentials are injected at runtime. Your MCP server starts exactly the same way — the only difference is that the password is no longer sitting in a plaintext file.

### How It Works

1. You store credentials in a secure backend (Keychain, 1Password, etc.)
2. Secretless rewrites your MCP config to reference the stored secrets instead of plaintext values
3. When your AI tool starts the MCP server, Secretless resolves the credentials from the backend and passes them as environment variables
4. The server runs normally — no code changes needed

### Quick Setup

Once you've confirmed sn-mcp-bridge works with plaintext credentials (as shown in the configuration examples above), run:

> **Note:** `protect-mcp` scans and protects **all** MCP server configs it finds, not just sn-mcp-bridge. If you have other MCP servers with plaintext API keys, those will be secured too. This is good from a security standpoint, but worth being aware of. You can always run `npx secretless-ai mcp-status` to see what was changed and `npx secretless-ai mcp-unprotect` to revert.

```bash
npx secretless-ai protect-mcp --backend keychain
```

Secretless will scan your MCP configs (Claude Code, Cursor, VS Code, Codex, etc.), find the plaintext `SN_USERNAME` and `SN_PASSWORD` values, move them to the selected backend, and rewrite the configs. Non-secret values like `SN_INSTANCE` are left as-is. This works across multiple instances automatically.

### Supported Backends

| Backend              | Flag                  | Best for                                                                                          |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| OS Keychain          | `--backend keychain`  | **macOS (recommended)** — uses the built-in Keychain, secured by your login password and Touch ID |
| Local encrypted file | `--backend local`     | **Windows (recommended)** — AES-256-GCM encrypted file, no extra software needed                  |
| 1Password            | `--backend 1password` | Teams and CI/CD, or Windows users with 1Password already installed                                |
| HashiCorp Vault      | `--backend vault`     | Enterprise and self-hosted deployments                                                            |
| GCP Secret Manager   | `--backend gcp-sm`    | GCP-native workloads                                                                              |

### Managing Protected Configs

```bash
# Check which MCP servers have protected credentials
npx secretless-ai mcp-status

# Restore original plaintext configs from backup
npx secretless-ai mcp-unprotect
```

For more details on Secretless AI, see the [full documentation](https://github.com/opena2a-org/secretless-ai).

## Requirements

- Node.js 18+ (for native `fetch`)
- A ServiceNow instance with REST API access
- Basic auth credentials for the instance

## License

MIT
