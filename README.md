<p align="center">
  <h1 align="center">SSH MCP Server</h1>
  <p align="center">
    <strong>Let AI manage your servers — with zero-token file transfers.</strong>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@nl4ever/sshmcp"><img src="https://img.shields.io/npm/v/@nl4ever/sshmcp?color=blue&label=npm" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/@nl4ever/sshmcp"><img src="https://img.shields.io/npm/dm/@nl4ever/sshmcp?color=green" alt="npm downloads"></a>
    <a href="https://github.com/NikolaNddTesla/ssh-mcp-server/blob/main/LICENSE"><img src="https://img.shields.io/github/license/NikolaNddTesla/ssh-mcp-server" alt="license"></a>
    <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-compatible-purple" alt="MCP compatible"></a>
  </p>
</p>

---

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives AI the power to manage remote servers via SSH — execute commands, transfer files, and manage multi-server environments with per-connection proxy support.

## Features

- 🚀 **Remote Command Execution** — Run any shell command on your servers
- 📦 **SFTP File Transfer** — Upload / download files and directories with zero token cost
- 🌐 **Per-Connection SOCKS Proxy** — Route each server through its own SOCKS4/5 proxy
- 🖥️ **Multi-Server Management** — Save and switch between unlimited server configs
- 🔗 **Jump Host / Bastion Support** — Reach servers behind firewalls
- 🔑 **Flexible Auth** — Password, private key, SSH agent, keyboard-interactive
- 💾 **Persistent Configuration** — Configure once, use across all sessions

### Zero-Token File Transfer

File transfers go directly through SFTP between your machine and the server. The AI only sends a file path — **it never sees or processes the file content**. Transfer a 10GB database dump at the same token cost as a 1KB config file: **near zero**.

```
You: "Deploy the build to production"

AI:  upload_directory("./dist", "/var/www/app")  ← just the path
                     |
     MCP Server: local disk --SFTP--> remote server  ← direct transfer
                     |
AI:  "Deployed successfully (142 files, 38MB)"  ← only the result
```

## Quick Start

**One command. No config files to edit.**

```bash
# Claude Code
claude mcp add sshmcp npx -- -y @nl4ever/sshmcp

# Or install globally first
npm install -g @nl4ever/sshmcp
claude mcp add sshmcp sshmcp
```

Then just tell Claude:

> *"Connect to my server 192.168.1.100 as root and check disk usage"*

Claude will call `add_server` + `connect` + `execute("df -h")` automatically.

## Installation

### npx (No Install)

```bash
npx @nl4ever/sshmcp
```

### Global Install (Recommended)

```bash
npm install -g @nl4ever/sshmcp
```

### From Source

```bash
git clone https://github.com/NikolaNddTesla/ssh-mcp-server.git
cd ssh-mcp-server
npm install && npm run build
node dist/index.js
```

## Integration

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add sshmcp sshmcp
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sshmcp": {
      "command": "npx",
      "args": ["-y", "@nl4ever/sshmcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Go to `Settings > MCP` and add:

```json
{
  "mcpServers": {
    "sshmcp": {
      "command": "npx",
      "args": ["-y", "@nl4ever/sshmcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>Windsurf / Cline / Other MCP Clients</strong></summary>

Any MCP-compatible client can use this server via stdio transport:

```json
{
  "mcpServers": {
    "sshmcp": {
      "command": "npx",
      "args": ["-y", "@nl4ever/sshmcp"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "sshmcp": {
      "command": "sshmcp"
    }
  }
}
```

</details>

## What Can It Do?

### 15 Tools at AI's Fingertips

**Connection & Servers**
| Tool | What it does |
|------|-------------|
| `connect` | Connect to a server |
| `disconnect` | End current session |
| `test_connection` | Test connectivity without switching active connection |
| `list_servers` | Show all configured servers |
| `get_server` | View server details (passwords auto-masked) |
| `add_server` | Add or update a server |
| `delete_server` | Remove a server |

**Remote Execution**
| Tool | What it does |
|------|-------------|
| `execute` | Run any shell command (with configurable timeout) |
| `write_file` | Write text content to a remote file |

**File Transfer (Zero Token Cost)**
| Tool | What it does |
|------|-------------|
| `upload_file` | Upload a local file to the server |
| `upload_directory` | Recursively upload an entire directory |
| `download_file` | Download a file from the server |

**Proxy Management**
| Tool | What it does |
|------|-------------|
| `list_proxies` | Show all configured SOCKS proxies |
| `add_proxy` | Add a SOCKS4/5 proxy |
| `delete_proxy` | Remove a proxy |

## Configuration

All settings persist in `~/.ssh-mcp/config.json`. Configure once, use across all sessions.

### Server with Password

```
add_server({
  server_id: "prod",
  name: "Production",
  host: "192.168.1.100",
  port: 22,
  username: "root",
  password: "your-password"
})
```

### Server with Proxy (for restricted networks)

```
add_proxy({ proxy_id: "us", name: "US Proxy", host: "proxy.example.com", port: 1080 })

add_server({
  server_id: "overseas",
  name: "Overseas Server",
  host: "1.2.3.4",
  port: 22,
  username: "root",
  password: "your-password",
  proxy: "us"
})
```

### All Authentication Methods

| Method | Parameter | Use Case |
|--------|-----------|----------|
| Password | `password` | Most common |
| Private Key File | `private_key` | `.pem` / `id_rsa` on your machine |
| Private Key Inline | `private_key_content` | Paste key directly (CI/CD friendly) |
| SSH Agent | `use_agent: true` | Use system ssh-agent, no password needed |
| Keyboard Interactive | `keyboard_interactive: true` | OTP / 2FA |
| Jump Host | `jump_host` | Connect through a bastion server |

## Requirements

- Node.js >= 18.0.0
- SSH access to target servers

## Contributing

Issues and PRs are welcome! If you find a bug or have a feature request, please [open an issue](https://github.com/NikolaNddTesla/ssh-mcp-server/issues).

## License

MIT
