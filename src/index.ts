#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { ConfigManager } from './config.js';
import { SshManager, TransferProgress, TransferResult } from './ssh-manager.js';

// Config file in user home dir to survive builds
const CONFIG_DIR = path.join(os.homedir(), '.ssh-mcp');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

const config = new ConfigManager(CONFIG_PATH);

// ── Connection Pool ──────────────────────────────────────────────
// key: server_id (configured) or "host:port" (temporary)
const pool = new Map<string, SshManager>();

/** Get or auto-establish connection (auto-reconnect on drop) */
async function getConnection(server_id: string): Promise<{ ssh: SshManager; label: string } | { error: string }> {
  // Active connection exists? Reuse it
  const existing = pool.get(server_id);
  if (existing?.isConnected()) {
    return { ssh: existing, label: `[${server_id}] ` };
  }

  // Connection dropped, cleanup stale instance
  if (existing) {
    await existing.disconnect().catch(() => {});
    pool.delete(server_id);
  }

  // Try auto-connect from config (or reconnect)
  const s = config.getServer(server_id);
  if (!s) return { error: `Server not found and no active connection: ${server_id}\nUse add_server to add, or quick_connect for temporary connection.` };

  const proxy = s.proxy ? config.getProxy(s.proxy) ?? undefined : undefined;
  if (s.proxy && !proxy) return { error: `Proxy not found: ${s.proxy}. Use add_proxy to add it first.` };

  const jump = s.jumpHost ? config.getServer(s.jumpHost) ?? undefined : undefined;
  if (s.jumpHost && !jump) return { error: `Jump host not found: ${s.jumpHost}. Use add_server to add it first.` };

  const ssh = new SshManager();
  const ok = await ssh.connect(s, proxy, jump);
  if (!ok) return { error: `Connection failed: ${s.name} (${s.host}:${s.port})\nReason: ${ssh.lastError}` };

  pool.set(server_id, ssh);
  return { ssh, label: `[${server_id}] ` };
}

// ── Transfer Task Management ────────────────────────────────────────
interface TransferTask {
  id: string;
  serverId: string;
  type: 'upload' | 'download' | 'upload_dir';
  localPath: string;
  remotePath: string;
  status: 'running' | 'done' | 'error';
  progress: TransferProgress | null;
  result: TransferResult | null;
  error: string | null;
  startTime: number;
}

const transfers = new Map<string, TransferTask>();
let transferCounter = 0;

function newTransferId(): string {
  return `tf_${++transferCounter}`;
}

const server = new McpServer({
  name: 'ssh-mcp-server',
  version: '2.0.0',
});

// ── Utility Functions ──────────────────────────────────────────────

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatSize(bytesPerSec)}/s`;
}

function formatTransferResult(r: TransferResult, extra = ''): string {
  const parts = [formatSize(r.bytes), `${formatElapsed(r.elapsed)}`];
  if (r.speed > 0) parts.push(formatSpeed(r.speed));
  if (extra) parts.unshift(extra);
  return parts.join(' | ');
}

function formatProgress(p: TransferProgress): string {
  const pct = p.total > 0 ? ((p.transferred / p.total) * 100).toFixed(1) : '?';
  return `${formatSize(p.transferred)} / ${formatSize(p.total)} (${pct}%) — ${formatSpeed(p.speed)}`;
}

// server_id parameter, shared by all operation tools
const serverIdParam = z.string().describe('Server ID (configured server_id or host:port from quick_connect)');

// ── Connection Management ──────────────────────────────────────────────

server.tool('list_servers', 'List all configured servers and active connections', {}, async () => {
  const servers = config.getServers();
  const lines: string[] = [];

  // Configured servers
  if (Object.keys(servers).length > 0) {
    lines.push('Configured servers:');
    for (const [id, s] of Object.entries(servers)) {
      const tags: string[] = [];
      if (s.proxy) tags.push(`proxy: ${s.proxy}`);
      if (s.jumpHost) tags.push(`jump: ${s.jumpHost}`);
      if (s.useAgent) tags.push('agent');
      if (s.keyboardInteractive) tags.push('kbd-interactive');
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      const connected = pool.get(id)?.isConnected() ? ' ✅' : '';
      lines.push(`  ${id}: ${s.name} (${s.host}:${s.port})${tagStr}${connected}`);
    }
  }

  // Temporary connections
  const tmpConns = [...pool.entries()].filter(([id]) => !servers[id] && pool.get(id)?.isConnected());
  if (tmpConns.length > 0) {
    lines.push('Temporary connections:');
    for (const [id] of tmpConns) {
      lines.push(`  ${id} ✅`);
    }
  }

  if (lines.length === 0) return text('No configured servers. Use add_server to add one.');
  return text(lines.join('\n'));
});

server.tool(
  'get_server',
  'View server configuration details',
  { server_id: z.string().describe('Server ID') },
  async ({ server_id }) => {
    const s = config.getServer(server_id);
    if (!s) return text(`Server not found: ${server_id}`);
    const info = { ...s } as Record<string, unknown>;
    if (info.password) info.password = '***';
    if (info.passphrase) info.passphrase = '***';
    if (info.privateKeyContent) info.privateKeyContent = '(set)';
    const connected = pool.get(server_id)?.isConnected() ? '(connected)' : '(disconnected)';
    return text(`${connected}\n${JSON.stringify(info, null, 2)}`);
  },
);

server.tool(
  'connect',
  'Manually connect to server (usually not needed, tools auto-connect)',
  { server_id: z.string().describe('Server ID') },
  async ({ server_id }) => {
    const r = await getConnection(server_id);
    if ('error' in r) return text(r.error);
    const s = config.getServer(server_id);
    return text(`Connected: ${s?.name ?? server_id}`);
  },
);

server.tool(
  'quick_connect',
  'Temporary server connection (not saved). Returns host:port as server_id for subsequent operations',
  {
    host: z.string().describe('IP address or hostname'),
    username: z.string().describe('SSH username'),
    port: z.number().int().default(22).describe('SSH port, default 22'),
    password: z.string().optional().describe('SSH password'),
    private_key: z.string().optional().describe('Private key file path'),
  },
  async ({ host, username, port, password, private_key }) => {
    const connId = `${host}:${port}`;

    // Disconnect existing connection with same host:port
    const existing = pool.get(connId);
    if (existing) { await existing.disconnect(); pool.delete(connId); }

    const tmpServer = {
      id: connId, name: `${username}@${host}`,
      host, port, username,
      ...(password ? { password } : {}),
      ...(private_key ? { privateKey: private_key } : {}),
    };

    const ssh = new SshManager();
    const ok = await ssh.connect(tmpServer);
    if (!ok) return text(`Connection failed: ${connId}\nReason: ${ssh.lastError}`);

    pool.set(connId, ssh);
    return text(`Temporarily connected: ${username}@${connId} (not saved)\nUse server_id="${connId}" for subsequent operations`);
  },
);

server.tool(
  'disconnect',
  'Disconnect from server',
  { server_id: z.string().optional().describe('Server ID. Leave empty to disconnect all') },
  async ({ server_id }) => {
    if (!server_id) {
      // Disconnect all
      const ids = [...pool.keys()];
      if (ids.length === 0) return text('No active connections');
      for (const [id, ssh] of pool.entries()) {
        await ssh.disconnect();
        pool.delete(id);
      }
      return text(`Disconnected all (${ids.length}): ${ids.join(', ')}`);
    }

    const ssh = pool.get(server_id);
    if (!ssh?.isConnected()) return text(`No active connection: ${server_id}`);
    await ssh.disconnect();
    pool.delete(server_id);
    return text(`Disconnected: ${server_id}`);
  },
);

server.tool(
  'test_connection',
  'Test server connectivity (does not affect existing connections)',
  { server_id: z.string().describe('Server ID') },
  async ({ server_id }) => {
    const s = config.getServer(server_id);
    if (!s) return text(`Server not found: ${server_id}`);

    const proxy = s.proxy ? config.getProxy(s.proxy) ?? undefined : undefined;
    const jump = s.jumpHost ? config.getServer(s.jumpHost) ?? undefined : undefined;

    const tmp = new SshManager();
    const ok = await tmp.testConnection(s, proxy, jump);
    return text(ok
      ? `✅ Connection successful: ${s.name} (${s.host}:${s.port})`
      : `❌ Connection failed: ${s.host}\nReason: ${tmp.lastError}`
    );
  },
);

// ── Command Execution ──────────────────────────────────────────────

server.tool(
  'execute',
  'Execute shell command on remote server',
  {
    server_id: serverIdParam,
    command: z.string().describe('Command to execute'),
    timeout: z.number().int().optional().default(30).describe('Timeout in seconds, default 30'),
  },
  async ({ server_id, command, timeout }) => {
    const r = await getConnection(server_id);
    if ('error' in r) return text(r.error);
    const { ssh, label } = r;

    const { ok, stdout, stderr } = await ssh.execute(command, (timeout ?? 30) * 1000);
    const status = ok ? 'OK' : 'FAILED';
    let result = stdout || '';
    if (stderr) result += `\n[STDERR] ${stderr}`;
    if (!result.trim()) result = '(no output)';
    return text(`${label}[${status}] ${command}\n${result}`);
  },
);

// ── File Operations ──────────────────────────────────────────────

server.tool(
  'write_file',
  'Write content to remote file (overwrite)',
  {
    server_id: serverIdParam,
    remote_path: z.string().describe('Remote file path'),
    content: z.string().describe('Text content to write'),
  },
  async ({ server_id, remote_path, content }) => {
    const r = await getConnection(server_id);
    if ('error' in r) return text(r.error);
    const { ssh, label } = r;
    try {
      await ssh.writeFile(remote_path, content);
      return text(`${label}Written: ${remote_path}`);
    } catch (e) {
      return text(`${label}Write failed: ${e}`);
    }
  },
);

server.tool(
  'read_file',
  'Read remote file content (supports line range, suitable for logs and config files)',
  {
    server_id: serverIdParam,
    remote_path: z.string().describe('Remote file path'),
    offset: z.number().int().optional().default(0).describe('Start line (0-based), default 0'),
    limit: z.number().int().optional().describe('Number of lines to read. Leave empty for all'),
  },
  async ({ server_id, remote_path, offset, limit }) => {
    const r = await getConnection(server_id);
    if ('error' in r) return text(r.error);
    const { ssh, label } = r;
    try {
      const result = await ssh.readFile(remote_path, offset ?? 0, limit ?? undefined);
      const info = limit
        ? `${label}${remote_path} (lines ${offset + 1}-${offset + result.readLines} of ${result.totalLines})`
        : `${label}${remote_path} (${result.totalLines} lines)`;
      return text(`${info}\n${result.content}`);
    } catch (e) {
      return text(`${label}Read failed: ${e}`);
    }
  },
);

server.tool(
  'upload_file',
  'Upload local file to remote server (path-based, zero token cost. Use async mode for large files)',
  {
    server_id: serverIdParam,
    local_path: z.string().describe('Local file absolute path'),
    remote_path: z.string().describe('Remote destination path'),
    async_transfer: z.boolean().optional().default(false).describe('Recommended for large files. Runs in background and returns task ID. Use transfer_status to check progress'),
    skip_same: z.boolean().optional().default(false).describe('MD5 dedup: skip upload if remote file has same MD5, saving bandwidth and time'),
  },
  async ({ server_id, local_path, remote_path, async_transfer, skip_same }) => {
    const r = await getConnection(server_id);
    if ('error' in r) return text(r.error);
    const { ssh, label } = r;
    if (!fs.existsSync(local_path)) return text(`Local file not found: ${local_path}`);

    if (async_transfer) {
      const id = newTransferId();
      const task: TransferTask = { id, serverId: server_id, type: 'upload', localPath: local_path, remotePath: remote_path, status: 'running', progress: null, result: null, error: null, startTime: Date.now() };
      transfers.set(id, task);
      ssh.uploadFile(local_path, remote_path, (p) => { task.progress = p; }, skip_same)
        .then((res) => { task.status = 'done'; task.result = res; })
        .catch((e) => { task.status = 'error'; task.error = String(e); });
      const size = fs.statSync(local_path).size;
      return text(`${label}Background upload started: ${id}\n${local_path} → ${remote_path} (${formatSize(size)})${skip_same ? ' [MD5 dedup]' : ''}\nUse transfer_status("${id}") to check progress`);
    }

    try {
      const res = await ssh.uploadFile(local_path, remote_path, undefined, skip_same);
      if (res.skipped) {
        return text(`${label}Skipped (same MD5): ${local_path} → ${remote_path}`);
      }
      return text(`${label}Uploaded: ${local_path} → ${remote_path}\n${formatTransferResult(res)}`);
    } catch (e) {
      return text(`${label}Upload failed: ${e}`);
    }
  },
);

server.tool(
  'upload_directory',
  'Upload local directory to remote server (auto compress, transfer, and extract. Use async for large dirs)',
  {
    server_id: serverIdParam,
    local_path: z.string().describe('Local directory absolute path'),
    remote_path: z.string().describe('Remote destination path'),
    async_transfer: z.boolean().optional().default(false).describe('Recommended for large directories. Runs in background and returns task ID'),
    skip_same: z.boolean().optional().default(false).describe('MD5 dedup: skip unchanged files (same MD5), only upload modified/new files'),
  },
  async ({ server_id, local_path, remote_path, async_transfer, skip_same }) => {
    const r = await getConnection(server_id);
    if ('error' in r) return text(r.error);
    const { ssh, label } = r;
    if (!fs.existsSync(local_path)) return text(`Local directory not found: ${local_path}`);

    if (async_transfer) {
      const id = newTransferId();
      const task: TransferTask = { id, serverId: server_id, type: 'upload_dir', localPath: local_path, remotePath: remote_path, status: 'running', progress: null, result: null, error: null, startTime: Date.now() };
      transfers.set(id, task);
      ssh.uploadDirectory(local_path, remote_path, (p) => { task.progress = p; }, skip_same)
        .then((res) => { task.status = 'done'; task.result = res; })
        .catch((e) => { task.status = 'error'; task.error = String(e); });
      return text(`${label}Background directory upload started: ${id}\n${local_path} → ${remote_path}${skip_same ? ' [MD5 dedup]' : ''}\nUse transfer_status("${id}") to check progress`);
    }

    try {
      const res = await ssh.uploadDirectory(local_path, remote_path, undefined, skip_same);
      const skippedInfo = res.skippedFiles ? `, ${res.skippedFiles} unchanged skipped` : '';
      const remoteOnlyInfo = res.remoteOnly?.length
        ? `\n\n⚠️ ${res.remoteOnly.length} files exist on remote but not locally (possibly stale/outdated):\n${res.remoteOnly.map(f => `  - ${f}`).join('\n')}`
        : '';
      if (res.files === 0 && res.skippedFiles) {
        return text(`${label}All skipped (MD5 identical): ${local_path} → ${remote_path}\n${res.skippedFiles} files unchanged, no update needed${remoteOnlyInfo}`);
      }
      return text(`${label}Directory uploaded: ${local_path} → ${remote_path}\n${formatTransferResult(res, `${res.files} files${skippedInfo}`)}${remoteOnlyInfo}`);
    } catch (e) {
      return text(`${label}Directory upload failed: ${e}`);
    }
  },
);

server.tool(
  'download_file',
  'Download file from remote server (use async mode for large files)',
  {
    server_id: serverIdParam,
    remote_path: z.string().describe('Remote file path'),
    local_path: z.string().optional().describe('Local save path. Leave empty to save in current directory'),
    async_transfer: z.boolean().optional().default(false).describe('Recommended for large files. Runs in background and returns task ID'),
  },
  async ({ server_id, remote_path, local_path, async_transfer }) => {
    const r = await getConnection(server_id);
    if ('error' in r) return text(r.error);
    const { ssh, label } = r;
    const savePath = local_path || path.basename(remote_path);

    if (async_transfer) {
      const id = newTransferId();
      const task: TransferTask = { id, serverId: server_id, type: 'download', localPath: savePath, remotePath: remote_path, status: 'running', progress: null, result: null, error: null, startTime: Date.now() };
      transfers.set(id, task);
      ssh.downloadFile(remote_path, savePath, (p) => { task.progress = p; })
        .then((res) => { task.status = 'done'; task.result = res; })
        .catch((e) => { task.status = 'error'; task.error = String(e); });
      return text(`${label}Background download started: ${id}\n${remote_path} → ${savePath}\nUse transfer_status("${id}") to check progress`);
    }

    try {
      const res = await ssh.downloadFile(remote_path, savePath);
      return text(`${label}Downloaded: ${remote_path} → ${savePath}\n${formatTransferResult(res)}`);
    } catch (e) {
      return text(`${label}Download failed: ${e}`);
    }
  },
);

server.tool(
  'download_directory',
  'Download remote directory (remote compress → download → local extract. Use async for large dirs)',
  {
    server_id: serverIdParam,
    remote_path: z.string().describe('Remote directory path'),
    local_path: z.string().describe('Local save path'),
    async_transfer: z.boolean().optional().default(false).describe('Recommended for large directories. Runs in background and returns task ID'),
  },
  async ({ server_id, remote_path, local_path, async_transfer }) => {
    const r = await getConnection(server_id);
    if ('error' in r) return text(r.error);
    const { ssh, label } = r;

    if (async_transfer) {
      const id = newTransferId();
      const task: TransferTask = { id, serverId: server_id, type: 'download', localPath: local_path, remotePath: remote_path, status: 'running', progress: null, result: null, error: null, startTime: Date.now() };
      transfers.set(id, task);
      ssh.downloadDirectory(remote_path, local_path, (p) => { task.progress = p; })
        .then((res) => { task.status = 'done'; task.result = res; })
        .catch((e) => { task.status = 'error'; task.error = String(e); });
      return text(`${label}Background directory download started: ${id}\n${remote_path} → ${local_path}\nUse transfer_status("${id}") to check progress`);
    }

    try {
      const res = await ssh.downloadDirectory(remote_path, local_path);
      return text(`${label}Directory downloaded: ${remote_path} → ${local_path}\n${formatTransferResult(res, `${res.files} files`)}`);
    } catch (e) {
      return text(`${label}Directory download failed: ${e}`);
    }
  },
);

server.tool(
  'transfer_status',
  'Check background transfer task progress (use with async_transfer=true)',
  {
    task_id: z.string().optional().describe('Task ID, e.g. tf_1. Leave empty to list all tasks'),
  },
  async ({ task_id }) => {
    if (!task_id) {
      if (transfers.size === 0) return text('No transfer tasks');
      const lines = [...transfers.values()].map((t) => {
        const dir = t.type === 'download' ? '↓' : '↑';
        const srv = `[${t.serverId}]`;
        if (t.status === 'done' && t.result)
          return `  ${t.id} ${srv} ${dir} ✅ Done — ${formatTransferResult(t.result)}`;
        if (t.status === 'error')
          return `  ${t.id} ${srv} ${dir} ❌ Failed — ${t.error}`;
        if (t.progress)
          return `  ${t.id} ${srv} ${dir} 🔄 ${formatProgress(t.progress)}`;
        return `  ${t.id} ${srv} ${dir} 🔄 Preparing...`;
      });
      return text('Transfer tasks:\n' + lines.join('\n'));
    }

    const t = transfers.get(task_id);
    if (!t) return text(`Task not found: ${task_id}`);

    const dir = t.type === 'download' ? 'Download' : 'Upload';
    const pathInfo = `${t.localPath} ↔ ${t.remotePath}`;

    if (t.status === 'done' && t.result) {
      return text(`[${t.serverId}] ✅ ${dir} complete: ${pathInfo}\n${formatTransferResult(t.result)}`);
    }
    if (t.status === 'error') {
      return text(`[${t.serverId}] ❌ ${dir} failed: ${pathInfo}\nReason: ${t.error}`);
    }
    if (t.progress) {
      const elapsed = Date.now() - t.startTime;
      const remaining = t.progress.speed > 0
        ? (t.progress.total - t.progress.transferred) / t.progress.speed
        : 0;
      return text(`[${t.serverId}] 🔄 ${dir} in progress: ${pathInfo}\n${formatProgress(t.progress)}\nElapsed ${formatElapsed(elapsed)}, ETA ${formatElapsed(remaining * 1000)}`);
    }
    return text(`[${t.serverId}] 🔄 ${dir} preparing: ${pathInfo}`);
  },
);

// ── Server Config Management ────────────────────────────────────────

server.tool(
  'add_server',
  'Add or update server configuration',
  {
    server_id: z.string().describe('Server ID (unique identifier)'),
    name: z.string().describe('Server name'),
    host: z.string().describe('IP address or hostname'),
    port: z.number().int().default(22).describe('SSH port, default 22'),
    username: z.string().describe('SSH username'),
    password: z.string().optional().describe('SSH password'),
    private_key: z.string().optional().describe('Private key file path (file must exist)'),
    private_key_content: z.string().optional().describe('Private key content string (takes priority over private_key)'),
    passphrase: z.string().optional().describe('Private key passphrase'),
    use_agent: z.boolean().optional().describe('Use system ssh-agent'),
    keyboard_interactive: z.boolean().optional().describe('Enable keyboard-interactive auth (OTP/2FA)'),
    proxy: z.string().optional().describe('SOCKS5/4 proxy preset ID. Leave empty for direct connection'),
    jump_host: z.string().optional().describe('Jump host server ID (ProxyJump)'),
  },
  async ({ server_id, name, host, port, username, password, private_key,
    private_key_content, passphrase, use_agent, keyboard_interactive, proxy, jump_host }) => {

    if (proxy && !config.getProxy(proxy))
      return text(`Proxy not found: ${proxy}. Use add_proxy to add it first.`);
    if (jump_host && !config.getServer(jump_host))
      return text(`Jump host not found: ${jump_host}. Use add_server to add it first.`);
    if (private_key && !fs.existsSync(private_key))
      return text(`Private key file not found: ${private_key}`);

    config.addServer(server_id, {
      name, host, port, username,
      ...(password ? { password } : {}),
      ...(private_key_content ? { privateKeyContent: private_key_content } : {}),
      ...(private_key && !private_key_content ? { privateKey: private_key } : {}),
      ...(passphrase ? { passphrase } : {}),
      ...(use_agent ? { useAgent: true } : {}),
      ...(keyboard_interactive ? { keyboardInteractive: true } : {}),
      ...(proxy ? { proxy } : {}),
      ...(jump_host ? { jumpHost: jump_host } : {}),
    });

    const tags = [
      proxy ? `proxy: ${proxy}` : '',
      jump_host ? `jump: ${jump_host}` : '',
      use_agent ? 'agent' : '',
      keyboard_interactive ? 'kbd-interactive' : '',
    ].filter(Boolean).join(', ');

    return text(`Server saved: ${server_id} (${host}:${port})${tags ? `  [${tags}]` : ''}`);
  },
);

server.tool(
  'update_server',
  'Update server configuration (only pass fields to change, rest unchanged)',
  {
    server_id: z.string().describe('Server ID'),
    name: z.string().optional().describe('Server name'),
    host: z.string().optional().describe('IP address or hostname'),
    port: z.number().int().optional().describe('SSH port'),
    username: z.string().optional().describe('SSH username'),
    password: z.string().optional().describe('SSH password (empty string to clear)'),
    private_key: z.string().optional().describe('Private key file path (empty string to clear)'),
    private_key_content: z.string().optional().describe('Private key content string (empty string to clear)'),
    passphrase: z.string().optional().describe('Private key passphrase (empty string to clear)'),
    use_agent: z.boolean().optional().describe('Use system ssh-agent'),
    keyboard_interactive: z.boolean().optional().describe('Enable keyboard-interactive auth'),
    proxy: z.string().optional().describe('Proxy preset ID (empty string to clear)'),
    jump_host: z.string().optional().describe('Jump host ID (empty string to clear)'),
  },
  async ({ server_id, name, host, port, username, password, private_key,
    private_key_content, passphrase, use_agent, keyboard_interactive, proxy, jump_host }) => {

    const existing = config.getServer(server_id);
    if (!existing) return text(`Server not found: ${server_id}`);

    if (proxy && proxy !== '' && !config.getProxy(proxy))
      return text(`Proxy not found: ${proxy}. Use add_proxy to add it first.`);
    if (jump_host && jump_host !== '' && !config.getServer(jump_host))
      return text(`Jump host not found: ${jump_host}. Use add_server to add it first.`);
    if (private_key && private_key !== '' && !fs.existsSync(private_key))
      return text(`Private key file not found: ${private_key}`);

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (host !== undefined) updates.host = host;
    if (port !== undefined) updates.port = port;
    if (username !== undefined) updates.username = username;
    if (password !== undefined) updates.password = password || null;
    if (private_key_content !== undefined) updates.privateKeyContent = private_key_content || null;
    if (private_key !== undefined) updates.privateKey = private_key || null;
    if (passphrase !== undefined) updates.passphrase = passphrase || null;
    if (use_agent !== undefined) updates.useAgent = use_agent || null;
    if (keyboard_interactive !== undefined) updates.keyboardInteractive = keyboard_interactive || null;
    if (proxy !== undefined) updates.proxy = proxy || null;
    if (jump_host !== undefined) updates.jumpHost = jump_host || null;

    config.updateServer(server_id, updates);

    // If connection-related config changed, disconnect to auto-reconnect next time
    const connFields = ['host', 'port', 'username', 'password', 'privateKey', 'privateKeyContent', 'passphrase', 'useAgent', 'keyboardInteractive', 'proxy', 'jumpHost'];
    const changedConn = Object.keys(updates).some(k => connFields.includes(k));
    if (changedConn) {
      const ssh = pool.get(server_id);
      if (ssh) { await ssh.disconnect(); pool.delete(server_id); }
    }

    const changed = Object.keys(updates).map(k => {
      const v = updates[k];
      if (k === 'password' || k === 'passphrase' || k === 'privateKeyContent') return v ? `${k}: ***` : `${k}: (cleared)`;
      return v === null ? `${k}: (cleared)` : `${k}: ${v}`;
    });
    return text(`Server updated: ${server_id}\nChanged: ${changed.join(', ')}${changedConn ? '\n(connection config changed, will auto-reconnect on next operation)' : ''}`);
  },
);

server.tool(
  'delete_server',
  'Delete server configuration',
  { server_id: z.string().describe('Server ID') },
  async ({ server_id }) => {
    // Also disconnect
    const ssh = pool.get(server_id);
    if (ssh) { await ssh.disconnect(); pool.delete(server_id); }
    const ok = config.deleteServer(server_id);
    return text(ok ? `Server deleted: ${server_id}` : `Server not found: ${server_id}`);
  },
);

server.tool(
  'rename_server',
  'Rename server ID (alias)',
  {
    old_id: z.string().describe('Current server ID'),
    new_id: z.string().describe('New server ID'),
  },
  async ({ old_id, new_id }) => {
    if (old_id === new_id) return text('Old and new ID are the same, no change needed');
    // Migrate connection pool entry
    const ssh = pool.get(old_id);
    if (ssh) {
      pool.set(new_id, ssh);
      pool.delete(old_id);
    }
    const ok = config.renameServer(old_id, new_id);
    if (!ok) {
      // Rollback connection pool
      if (ssh) { pool.set(old_id, ssh); pool.delete(new_id); }
      return text(config.getServer(new_id) ? `New ID already taken: ${new_id}` : `Server not found: ${old_id}`);
    }
    return text(`Renamed: ${old_id} → ${new_id}`);
  },
);

// ── Proxy Config Management ──────────────────────────────────────────

server.tool('list_proxies', 'List all configured SOCKS proxies', {}, async () => {
  const proxies = config.getProxies();
  if (Object.keys(proxies).length === 0)
    return text('No configured proxies. Use add_proxy to add one.');

  const lines = Object.entries(proxies).map(([id, p]) => {
    const auth = p.username ? `, auth: ${p.username}` : '';
    return `  ${id}: ${p.name} SOCKS${p.type ?? 5} (${p.host}:${p.port}${auth})`;
  });
  return text('Configured proxies:\n' + lines.join('\n'));
});

server.tool(
  'add_proxy',
  'Add or update SOCKS proxy preset',
  {
    proxy_id: z.string().describe('Proxy ID (unique identifier)'),
    name: z.string().describe('Proxy name'),
    host: z.string().describe('Proxy server address'),
    port: z.number().int().describe('Proxy port'),
    type: z.enum(['4', '5']).optional().default('5').describe('SOCKS version, 4 or 5, default 5'),
    username: z.string().optional().describe('Auth username (optional)'),
    password: z.string().optional().describe('Auth password (optional)'),
  },
  async ({ proxy_id, name, host, port, type, username, password }) => {
    config.addProxy(proxy_id, {
      name, host, port,
      type: (parseInt(type ?? '5') as 4 | 5),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    });
    return text(`Proxy saved: ${proxy_id} SOCKS${type ?? 5} (${host}:${port})`);
  },
);

server.tool(
  'delete_proxy',
  'Delete proxy preset',
  { proxy_id: z.string().describe('Proxy ID') },
  async ({ proxy_id }) => {
    const ok = config.deleteProxy(proxy_id);
    return text(ok ? `Proxy deleted: ${proxy_id}` : `Proxy not found: ${proxy_id}`);
  },
);

// ── Start ──────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
