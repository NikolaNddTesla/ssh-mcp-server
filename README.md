# SSH MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for managing remote servers via SSH. Supports **file upload/download without consuming tokens**, multi-server management, and per-connection SOCKS proxy.

> Unlike other SSH MCP tools, file transfers go directly through SFTP — file contents never pass through the AI context window, so you can transfer files of **any size** at zero token cost.

## Features

- **Command Execution** — Run shell commands on remote servers
- **File Transfer** — Upload/download files and directories via SFTP (path-based, not through context)
- **Multi-Server** — Manage multiple servers with persistent configuration
- **SOCKS4/5 Proxy** — Per-connection proxy support for network-restricted environments
- **Multiple Auth Methods** — Password, private key (file or inline), ssh-agent, keyboard-interactive (OTP/2FA)
- **Jump Host** — ProxyJump / bastion host support
- **Zero Install** — Run directly with `npx`, no global installation needed

## Installation

### npx (No Install)

```bash
npx @nl4ever/sshmcp
```

### Global Install

```bash
npm install -g @nl4ever/sshmcp
sshmcp
```

### From Source

```bash
git clone https://github.com/NikolaNddTesla/ssh-mcp-server.git
cd ssh-mcp-server
npm install && npm run build
node dist/index.js
```

## Integration

### Claude Code

```bash
claude mcp add sshmcp npx @nl4ever/sshmcp
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

### Cursor

Go to `Settings → MCP` and add:

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

### Windsurf / Cline / Other MCP Clients

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

## Tools

### Connection Management

| Tool | Description |
|------|-------------|
| `list_servers` | List all configured servers |
| `get_server` | View server configuration details (passwords masked) |
| `add_server` | Add or update a server |
| `delete_server` | Remove a server |
| `connect` | Connect to a server |
| `disconnect` | Disconnect current session |
| `test_connection` | Test connectivity without switching active connection |

### Command Execution

| Tool | Description |
|------|-------------|
| `execute` | Run a shell command on the connected server (with configurable timeout) |

### File Operations

| Tool | Description |
|------|-------------|
| `upload_file` | Upload a local file to the remote server |
| `upload_directory` | Recursively upload a local directory |
| `download_file` | Download a remote file to local |
| `write_file` | Write text content to a remote file |

### Proxy Management

| Tool | Description |
|------|-------------|
| `list_proxies` | List all configured SOCKS proxies |
| `add_proxy` | Add or update a SOCKS4/5 proxy |
| `delete_proxy` | Remove a proxy |

## Configuration

All server and proxy configurations are stored persistently in `~/.ssh-mcp/config.json`. You only need to configure once — settings are preserved across sessions.

### Add a Server

```
add_server({
  server_id: "my-server",
  name: "Production",
  host: "192.168.1.100",
  port: 22,
  username: "root",
  password: "your-password"
})
```

### Add a Server with Proxy

```
# First, add a proxy
add_proxy({
  proxy_id: "my-proxy",
  name: "US Proxy",
  host: "proxy.example.com",
  port: 1080,
  type: "5"
})

# Then, add a server using that proxy
add_server({
  server_id: "overseas",
  name: "Overseas Server",
  host: "1.2.3.4",
  port: 22,
  username: "root",
  password: "your-password",
  proxy: "my-proxy"
})
```

### Authentication Methods

| Method | Parameter | Description |
|--------|-----------|-------------|
| Password | `password` | Simple password authentication |
| Private Key File | `private_key` | Path to a local `.pem` / `id_rsa` file |
| Private Key Inline | `private_key_content` | Paste the key content directly |
| SSH Agent | `use_agent: true` | Use system ssh-agent (no password needed) |
| Keyboard Interactive | `keyboard_interactive: true` | For OTP / 2FA prompts |
| Jump Host | `jump_host` | Server ID of a bastion/jump server |

## How File Transfer Works

```
AI says: "Upload C:/app/config.json to /etc/app/config.json"
         |
         v
MCP Server reads local file --> SFTP --> Remote server
         |
         v
AI receives: "Upload successful"
```

- File contents **never enter the AI context window**
- Works with files of **any size**
- Token cost: **near zero** (only the file path and result message)

## Requirements

- Node.js >= 18.0.0
- SSH access to target servers

## License

MIT
