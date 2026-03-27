# @nl4ever/sshmcp

[![npm version](https://img.shields.io/npm/v/@nl4ever/sshmcp)](https://www.npmjs.com/package/@nl4ever/sshmcp)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**[中文文档](./README.zh-CN.md)**

**Let AI manage your remote servers.** A Model Context Protocol (MCP) server that gives AI assistants full SSH access — execute commands, transfer files, manage multiple servers simultaneously, all through natural conversation.

```
You:   "Deploy the latest build to production server"
AI:    connects → uploads build → restarts service → verifies status
```

## Features

- **17 Tools** — Connect, execute, upload, download, write files, and more
- **Connection Pool** — Operate multiple servers simultaneously, each command tagged with `server_id`
- **Zero-Token File Transfer** — SFTP path-based transfer, file content never enters AI context
- **Directory Upload** — Auto tar.gz compress → upload → remote decompress (fast for many small files)
- **Async Transfer + Progress** — Background transfer for large files with real-time progress tracking
- **Quick Connect** — Temporary connections without saving config, returns `host:port` as temp ID
- **SOCKS4/5 Proxy** — Per-connection proxy support
- **Jump Host** — SSH ProxyJump for bastion/gateway access
- **Multi-Auth** — Password, private key, ssh-agent, keyboard-interactive (OTP/2FA)

## Quick Start

### Install globally

```bash
npm install -g @nl4ever/sshmcp
```

### Add to Claude Code

```bash
claude mcp add sshmcp sshmcp
```

### Add to Claude Desktop

Edit `claude_desktop_config.json`:

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

### Add to Cursor

Go to Settings → MCP Servers → Add:

```json
{
  "sshmcp": {
    "command": "npx",
    "args": ["-y", "@nl4ever/sshmcp"]
  }
}
```

## Tools Overview

### Connection Management

| Tool | Description |
|------|-------------|
| `list_servers` | List all configured servers and active connections |
| `get_server` | View server config details |
| `add_server` | Add/update server config (password, key, agent, OTP) |
| `delete_server` | Remove a server |
| `connect` | Manually connect (usually not needed, tools auto-connect) |
| `quick_connect` | Temporary connection, returns `host:port` as ID |
| `disconnect` | Disconnect specific server or all connections |
| `test_connection` | Test connectivity without affecting existing connections |

### Command Execution

| Tool | Description |
|------|-------------|
| `execute` | Run shell commands on remote server (with configurable timeout) |

### File Operations

| Tool | Description |
|------|-------------|
| `write_file` | Write text content to remote file |
| `upload_file` | Upload local file to remote (supports async mode) |
| `upload_directory` | Upload directory with auto compress → transfer → decompress |
| `download_file` | Download remote file to local (supports async mode) |
| `transfer_status` | Check progress of async transfers (size/speed/ETA) |

### Proxy Management

| Tool | Description |
|------|-------------|
| `list_proxies` | List all SOCKS proxy presets |
| `add_proxy` | Add SOCKS4/5 proxy preset |
| `delete_proxy` | Remove a proxy preset |

## Connection Pool: Multi-Server Operations

All operation tools take a `server_id` parameter. The connection pool auto-manages connections — no manual connect/disconnect needed:

```
AI: execute(server_id="prod", command="nginx -s reload")         ← auto-connects to prod
AI: execute(server_id="dev", command="tail -f /var/log/app.log") ← auto-connects to dev, prod stays
AI: execute(server_id="prod", command="curl localhost")           ← reuses prod connection
```

For temporary servers, use `quick_connect` which returns `host:port` as the ID:

```
AI: quick_connect(host="1.2.3.4", username="root", password="***")
→ "Connected: root@1.2.3.4:22, use server_id="1.2.3.4:22""

AI: execute(server_id="1.2.3.4:22", command="df -h")
AI: disconnect(server_id="1.2.3.4:22")
```

## Async Transfer (Large Files)

For large files, enable background transfer mode to avoid blocking:

```
AI: upload_file(server_id="prod", local_path="big.tar.gz", remote_path="/data/", async_transfer=true)
→ "Background upload started: tf_1"

AI: transfer_status("tf_1")
→ "🔄 Uploading: 638.2 MB / 1.2 GB (53.2%) — 12.4 MB/s, ETA 46s"

AI: transfer_status("tf_1")
→ "✅ Upload complete: 1.2 GB, 98s, 12.3 MB/s"
```

Small files use synchronous mode by default — no config needed.

## Connection Examples

### Password authentication

```
AI: add_server(server_id="prod", name="Production", host="10.0.0.1", username="deploy", password="***")
AI: execute(server_id="prod", command="systemctl status nginx")
```

### Private key authentication

```
AI: add_server(server_id="aws", name="AWS EC2", host="ec2-xx.compute.amazonaws.com", username="ubuntu", private_key="~/.ssh/id_rsa")
```

### Quick connect (no config saved)

```
AI: quick_connect(host="192.168.1.100", username="root", password="***")
→ server_id="192.168.1.100:22"

AI: execute(server_id="192.168.1.100:22", command="df -h")
AI: disconnect(server_id="192.168.1.100:22")
```

### Via SOCKS5 proxy

```
AI: add_proxy(proxy_id="tunnel", name="SSH Tunnel", host="127.0.0.1", port=1080, type="5")
AI: add_server(server_id="internal", ..., proxy="tunnel")
```

### Via jump host

```
AI: add_server(server_id="bastion", name="Bastion", host="bastion.example.com", username="admin", private_key="~/.ssh/id_rsa")
AI: add_server(server_id="internal", name="Internal DB", host="10.0.0.5", username="dbadmin", password="***", jump_host="bastion")
```

## Config Location

Server and proxy configurations are stored in:

```
~/.ssh-mcp/config.json
```

Passwords are stored in plaintext. For production use, prefer private key authentication.

## Requirements

- Node.js >= 18
- An MCP-compatible client (Claude Code, Claude Desktop, Cursor, etc.)
- Remote server with SSH access

## License

MIT
