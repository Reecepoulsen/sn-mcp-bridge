# sn-mcp-bridge

A lightweight [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives AI coding assistants full development capability on ServiceNow — no installation required anywhere. It runs locally via `npx` and connects to ServiceNow through the Table API.

ServiceNow is a record-based development platform. Script includes, business rules, client scripts, UI actions, ACLs — every development artifact is a record in a system table. There is no separate "code layer"; the Table API **is** the development API. That means CRUD operations through this server aren't just for querying data — they're how you build:

- `insert_record` into `sys_script_include` → create a new script include
- `update_record` on `sys_script` → modify a business rule
- `query_data` on `sys_script_client` → read all client scripts for a table
- `delete_record` on `sys_ui_action` → remove a UI action

For tasks that go beyond CRUD — testing logic, running complex GlideRecord queries, calling script includes, or multi-step transactions — `execute_script` provides a full server-side JavaScript runtime.

The server runs with the permissions of whatever user account you provide credentials for — it can only read/write tables and fields that user has access to. The `execute_script` tool requires admin credentials since it runs background scripts via `sys.scripts.do`.

There are plenty of open-source ServiceNow MCP servers being shared in the community. This one exists to stay simple, pure, and easy to improve — plain JS with no build step (2 source files, native `fetch`, Node.js 18+), and adding a tool is one `server.registerTool()` call.

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

## Quick Start

### Environment Variables

| Variable                      | Description                                                |
| ----------------------------- | ---------------------------------------------------------- |
| `SN_INSTANCE`                 | Your instance URL (e.g. `https://mydev01.service-now.com`) |
| `SN_<INSTANCE_NAME>_USERNAME` | Username for basic auth                                    |
| `SN_<INSTANCE_NAME>_PASSWORD` | Password for basic auth                                    |

`<INSTANCE_NAME>` is the subdomain from `SN_INSTANCE`, uppercased with hyphens replaced by underscores (e.g. `https://mydev01.service-now.com` → `SN_MYDEV01_USERNAME`). If the prefixed vars aren't set, the bridge falls back to `SN_USERNAME` / `SN_PASSWORD`.

> **Warning:** The examples below use plaintext credentials to get you running quickly. This means your password is stored in a file on disk **and** visible to the AI assistant in every API call to the LLM provider. Once you've confirmed the connection works, it is highly recommended that you follow the [Securing Credentials with Secretless AI](#securing-credentials-with-secretless-ai) instructions to move plaintext secrets out of your config!

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

### Multiple Instances

Add a separate server entry for each instance. The config format is the same as above — just repeat the pattern with a different server name and instance-specific credentials.

## Securing Credentials with [Secretless AI](https://github.com/opena2a-org/secretless-ai)

[Secretless AI](https://github.com/opena2a-org/secretless-ai) stores your credentials in a secure backend and injects them at runtime via `secretless-ai run`.

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
- Basic auth credentials for the instance

## License

MIT
