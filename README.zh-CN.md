# @nl4ever/sshmcp

[![npm version](https://img.shields.io/npm/v/@nl4ever/sshmcp)](https://www.npmjs.com/package/@nl4ever/sshmcp)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**[English](./README.md)**

**让 AI 管理你的远程服务器。** 基于 MCP（模型上下文协议）的 SSH 服务端，让 AI 助手直接通过对话执行命令、传输文件、同时管理多台服务器。

```
你：  "把最新的构建部署到生产服务器"
AI：   连接 → 上传构建产物 → 重启服务 → 验证状态
```

## 特性

- **21 个工具** — 连接、执行、上传、下载、写文件等一应俱全
- **连接池** — 同时操作多台服务器，每条指令带 `server_id`，AI 不再搞混当前连的是哪台
- **零 Token 文件传输** — SFTP 路径直传，文件内容不经过 AI 上下文，不浪费 Token
- **目录压缩上传** — 自动 tar.gz 压缩 → 上传 → 远程解压（大量小文件场景极快）
- **异步传输 + 进度查询** — 大文件后台传输，随时查看进度、速度、预计剩余时间
- **临时连接** — `quick_connect` 用完即走，返回 `host:port` 作为临时 ID
- **SOCKS4/5 代理** — 每个连接可独立配置代理
- **跳板机** — 支持 SSH ProxyJump，穿透堡垒机/网关
- **多种认证** — 密码、私钥、ssh-agent、键盘交互式（OTP/2FA）

## 快速开始

### 全局安装

```bash
npm install -g @nl4ever/sshmcp
```

### 添加到 Claude Code

```bash
claude mcp add sshmcp sshmcp
```

### 添加到 Claude Desktop

编辑 `claude_desktop_config.json`：

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

### 添加到 Cursor

设置 → MCP Servers → 添加：

```json
{
  "sshmcp": {
    "command": "npx",
    "args": ["-y", "@nl4ever/sshmcp"]
  }
}
```

## 工具一览

### 连接管理

| 工具 | 说明 |
|------|------|
| `list_servers` | 列出所有已配置的服务器和活跃连接 |
| `get_server` | 查看服务器配置详情 |
| `add_server` | 添加/更新服务器（支持密码、密钥、agent、OTP） |
| `update_server` | 修改服务器配置（只传要改的字段） |
| `delete_server` | 删除服务器配置 |
| `rename_server` | 重命名服务器 ID（别名） |
| `connect` | 手动连接（通常不需要，操作工具会自动连接） |
| `quick_connect` | 临时连接，不保存配置，返回 `host:port` 作为 ID |
| `disconnect` | 断开指定服务器或全部连接 |
| `test_connection` | 测试连通性（不影响现有连接） |

### 命令执行

| 工具 | 说明 |
|------|------|
| `execute` | 在远程服务器执行 shell 命令（可配置超时） |

### 文件操作

| 工具 | 说明 |
|------|------|
| `read_file` | 读取远程文件内容（支持行数限制） |
| `write_file` | 将文本内容写入远程文件 |
| `upload_file` | 上传本地文件到远程（支持异步模式） |
| `upload_directory` | 上传目录，自动压缩 → 传输 → 解压 |
| `download_file` | 下载远程文件到本地（支持异步模式） |
| `download_directory` | 下载远程目录，远程压缩 → 传输 → 本地解压 |
| `transfer_status` | 查看异步传输进度（大小/速度/预计时间） |

### 代理管理

| 工具 | 说明 |
|------|------|
| `list_proxies` | 列出所有 SOCKS 代理预设 |
| `add_proxy` | 添加 SOCKS4/5 代理预设 |
| `delete_proxy` | 删除代理预设 |

## 连接池：同时操作多台服务器

v2.0 核心改进 —— 所有操作工具都带 `server_id`，内部自动管理连接池，不需要手动 connect/disconnect：

```
AI: execute(server_id="prod", command="nginx -s reload")         ← 自动连接 prod
AI: execute(server_id="dev", command="tail -f /var/log/app.log") ← 自动连接 dev，prod 不断
AI: execute(server_id="prod", command="curl localhost")           ← 复用 prod 连接
```

临时服务器用 `quick_connect`，返回 `host:port` 作为后续操作的 ID：

```
AI: quick_connect(host="1.2.3.4", username="root", password="***")
→ "已临时连接: root@1.2.3.4:22，后续操作使用 server_id="1.2.3.4:22""

AI: execute(server_id="1.2.3.4:22", command="df -h")
AI: disconnect(server_id="1.2.3.4:22")
```

## 异步传输（大文件）

大文件开启后台传输模式，避免阻塞对话：

```
AI: upload_file(server_id="prod", local_path="big.tar.gz", remote_path="/data/", async_transfer=true)
→ "后台上传已启动: tf_1"

AI: transfer_status("tf_1")
→ "🔄 上传中: 638.2 MB / 1.2 GB (53.2%) — 12.4 MB/s，预计剩余 46s"

AI: transfer_status("tf_1")
→ "✅ 上传完成: 1.2 GB，耗时 98s，12.3 MB/s"
```

小文件默认同步模式，无需任何配置。

## 使用示例

### 密码认证

```
AI: add_server(server_id="prod", name="生产服务器", host="10.0.0.1", username="deploy", password="***")
AI: execute(server_id="prod", command="systemctl status nginx")
```

### 私钥认证

```
AI: add_server(server_id="aws", name="AWS EC2", host="ec2-xx.compute.amazonaws.com", username="ubuntu", private_key="~/.ssh/id_rsa")
```

### 临时连接（不保存配置）

```
AI: quick_connect(host="192.168.1.100", username="root", password="***")
→ server_id="192.168.1.100:22"

AI: execute(server_id="192.168.1.100:22", command="df -h")
AI: disconnect(server_id="192.168.1.100:22")
```

### 通过 SOCKS5 代理

```
AI: add_proxy(proxy_id="tunnel", name="SSH隧道", host="127.0.0.1", port=1080, type="5")
AI: add_server(server_id="internal", ..., proxy="tunnel")
```

### 通过跳板机

```
AI: add_server(server_id="bastion", name="堡垒机", host="bastion.example.com", username="admin", private_key="~/.ssh/id_rsa")
AI: add_server(server_id="internal", name="内网数据库", host="10.0.0.5", username="dbadmin", password="***", jump_host="bastion")
```

## 配置文件位置

服务器和代理配置保存在：

```
~/.ssh-mcp/config.json
```

密码以明文存储。生产环境建议使用私钥认证。

## 环境要求

- Node.js >= 18
- 支持 MCP 的客户端（Claude Code、Claude Desktop、Cursor 等）
- 有 SSH 访问权限的远程服务器

## 开源协议

MIT
