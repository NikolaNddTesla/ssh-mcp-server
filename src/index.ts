#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { ConfigManager } from './config.js';
import { SshManager, TransferProgress, TransferResult } from './ssh-manager.js';

// 配置文件存在用户目录，避免被 build 清掉
const CONFIG_DIR = path.join(os.homedir(), '.ssh-mcp');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

const config = new ConfigManager(CONFIG_PATH);
let ssh = new SshManager();
let currentServerId: string | null = null;

// ── 传输任务管理 ────────────────────────────────────────
interface TransferTask {
  id: string;
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
  version: '0.1.0',
});

// ── 工具函数 ──────────────────────────────────────────────

function requireSsh(): SshManager {
  if (!ssh.isConnected()) throw new Error('未连接服务器，请先调用 connect(server_id)');
  return ssh;
}

function resolveServerAndProxy(server_id: string) {
  const s = config.getServer(server_id);
  if (!s) return { error: `服务器不存在: ${server_id}` };

  const proxy = s.proxy ? config.getProxy(s.proxy) : undefined;
  if (s.proxy && !proxy) return { error: `代理不存在: ${s.proxy}，请先用 add_proxy 添加。` };

  const jump = s.jumpHost ? config.getServer(s.jumpHost) : undefined;
  if (s.jumpHost && !jump) return { error: `跳板机不存在: ${s.jumpHost}，请先用 add_server 添加。` };

  return { s, proxy: proxy ?? undefined, jump: jump ?? undefined };
}

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
  const parts = [formatSize(r.bytes), `耗时 ${formatElapsed(r.elapsed)}`];
  if (r.speed > 0) parts.push(formatSpeed(r.speed));
  if (extra) parts.unshift(extra);
  return parts.join('，');
}

function formatProgress(p: TransferProgress): string {
  const pct = p.total > 0 ? ((p.transferred / p.total) * 100).toFixed(1) : '?';
  return `${formatSize(p.transferred)} / ${formatSize(p.total)} (${pct}%) — ${formatSpeed(p.speed)}`;
}

// ── 连接管理 ──────────────────────────────────────────────

server.tool('list_servers', '列出所有已配置的服务器', {}, async () => {
  const servers = config.getServers();
  if (Object.keys(servers).length === 0)
    return text('没有已配置的服务器，请使用 add_server 添加。');

  const lines = Object.entries(servers).map(([id, s]) => {
    const tags: string[] = [];
    if (s.proxy) tags.push(`代理: ${s.proxy}`);
    if (s.jumpHost) tags.push(`跳板: ${s.jumpHost}`);
    if (s.useAgent) tags.push('agent');
    if (s.keyboardInteractive) tags.push('kbd-interactive');
    const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
    const active = id === currentServerId ? ' ← 当前连接' : '';
    return `  ${id}: ${s.name} (${s.host}:${s.port})${tagStr}${active}`;
  });
  return text('已配置的服务器:\n' + lines.join('\n'));
});

server.tool(
  'get_server',
  '查看单台服务器的配置详情',
  { server_id: z.string().describe('服务器ID') },
  async ({ server_id }) => {
    const s = config.getServer(server_id);
    if (!s) return text(`服务器不存在: ${server_id}`);
    const info = { ...s } as Record<string, unknown>;
    if (info.password) info.password = '***';
    if (info.passphrase) info.passphrase = '***';
    if (info.privateKeyContent) info.privateKeyContent = '(已设置)';
    return text(JSON.stringify(info, null, 2));
  },
);

server.tool(
  'connect',
  '连接到已配置的服务器',
  { server_id: z.string().describe('服务器ID') },
  async ({ server_id }) => {
    const r = resolveServerAndProxy(server_id);
    if ('error' in r) return text(r.error!);
    const { s, proxy, jump } = r;

    await ssh.disconnect();
    const ok = await ssh.connect(s, proxy, jump);
    if (!ok) return text(`连接失败: ${s.host}\n原因: ${ssh.lastError}`);

    currentServerId = server_id;
    const tags = [
      proxy ? `代理: ${proxy.name}` : '',
      jump ? `跳板: ${s.jumpHost}` : '',
    ].filter(Boolean).join('，');
    return text(`已连接: ${s.name} (${s.host}:${s.port})${tags ? '\n' + tags : ''}`);
  },
);

server.tool(
  'quick_connect',
  '临时连接服务器（不保存配置，用完即走）',
  {
    host: z.string().describe('IP 地址或域名'),
    username: z.string().describe('SSH 用户名'),
    port: z.number().int().default(22).describe('SSH 端口，默认 22'),
    password: z.string().optional().describe('SSH 密码'),
    private_key: z.string().optional().describe('私钥文件路径'),
  },
  async ({ host, username, port, password, private_key }) => {
    const tmpServer = {
      id: '_quick_', name: `${username}@${host}`,
      host, port, username,
      ...(password ? { password } : {}),
      ...(private_key ? { privateKey: private_key } : {}),
    };

    await ssh.disconnect();
    const ok = await ssh.connect(tmpServer);
    if (!ok) return text(`连接失败: ${host}:${port}\n原因: ${ssh.lastError}`);

    currentServerId = '_quick_';
    return text(`已临时连接: ${username}@${host}:${port}（未保存配置）`);
  },
);

server.tool('disconnect', '断开当前连接', {}, async () => {
  if (!ssh.isConnected()) return text('当前没有活跃连接');
  const id = currentServerId;
  await ssh.disconnect();
  currentServerId = null;
  return text(`已断开: ${id}`);
});

server.tool(
  'test_connection',
  '测试服务器连通性（不影响当前连接）',
  { server_id: z.string().describe('服务器ID') },
  async ({ server_id }) => {
    const r = resolveServerAndProxy(server_id);
    if ('error' in r) return text(r.error!);
    const { s, proxy, jump } = r;

    const tmp = new SshManager();
    const ok = await tmp.testConnection(s, proxy, jump);
    return text(ok
      ? `✅ 连接成功: ${s.name} (${s.host}:${s.port})`
      : `❌ 连接失败: ${s.host}\n原因: ${tmp.lastError}`
    );
  },
);

// ── 命令执行 ──────────────────────────────────────────────

server.tool(
  'execute',
  '在远程服务器执行 shell 命令',
  {
    command: z.string().describe('要执行的命令'),
    timeout: z.number().int().optional().default(30).describe('超时秒数，默认 30'),
  },
  async ({ command, timeout }) => {
    const s = requireSsh();
    const { ok, stdout, stderr } = await s.execute(command, (timeout ?? 30) * 1000);
    const status = ok ? 'OK' : 'FAILED';
    let result = stdout || '';
    if (stderr) result += `\n[STDERR] ${stderr}`;
    if (!result.trim()) result = '(无输出)';
    return text(`[${status}] ${command}\n${result}`);
  },
);

// ── 文件操作 ──────────────────────────────────────────────

server.tool(
  'write_file',
  '将内容写入远程文件（覆盖写入）',
  {
    remote_path: z.string().describe('远程文件路径'),
    content: z.string().describe('要写入的文本内容'),
  },
  async ({ remote_path, content }) => {
    const s = requireSsh();
    try {
      await s.writeFile(remote_path, content);
      return text(`写入成功: ${remote_path}`);
    } catch (e) {
      return text(`写入失败: ${e}`);
    }
  },
);

server.tool(
  'upload_file',
  '上传本地文件到远程服务器（路径直传，不占 Token。大文件可用 async 模式后台传输）',
  {
    local_path: z.string().describe('本地文件绝对路径'),
    remote_path: z.string().describe('远程目标路径'),
    async_transfer: z.boolean().optional().default(false).describe('大文件建议开启，后台传输并返回任务ID，用 transfer_status 查进度'),
  },
  async ({ local_path, remote_path, async_transfer }) => {
    const s = requireSsh();
    if (!fs.existsSync(local_path)) return text(`本地文件不存在: ${local_path}`);

    if (async_transfer) {
      const id = newTransferId();
      const task: TransferTask = { id, type: 'upload', localPath: local_path, remotePath: remote_path, status: 'running', progress: null, result: null, error: null, startTime: Date.now() };
      transfers.set(id, task);
      s.uploadFile(local_path, remote_path, (p) => { task.progress = p; })
        .then((r) => { task.status = 'done'; task.result = r; })
        .catch((e) => { task.status = 'error'; task.error = String(e); });
      const size = fs.statSync(local_path).size;
      return text(`后台上传已启动: ${id}\n${local_path} → ${remote_path} (${formatSize(size)})\n用 transfer_status("${id}") 查看进度`);
    }

    try {
      const r = await s.uploadFile(local_path, remote_path);
      return text(`上传成功: ${local_path} → ${remote_path}\n${formatTransferResult(r)}`);
    } catch (e) {
      return text(`上传失败: ${e}`);
    }
  },
);

server.tool(
  'upload_directory',
  '上传本地目录到远程服务器（自动压缩传输再解压。大文件可用 async 模式）',
  {
    local_path: z.string().describe('本地目录绝对路径'),
    remote_path: z.string().describe('远程目标路径'),
    async_transfer: z.boolean().optional().default(false).describe('大目录建议开启，后台传输并返回任务ID'),
  },
  async ({ local_path, remote_path, async_transfer }) => {
    const s = requireSsh();
    if (!fs.existsSync(local_path)) return text(`本地目录不存在: ${local_path}`);

    if (async_transfer) {
      const id = newTransferId();
      const task: TransferTask = { id, type: 'upload_dir', localPath: local_path, remotePath: remote_path, status: 'running', progress: null, result: null, error: null, startTime: Date.now() };
      transfers.set(id, task);
      s.uploadDirectory(local_path, remote_path, (p) => { task.progress = p; })
        .then((r) => { task.status = 'done'; task.result = r; })
        .catch((e) => { task.status = 'error'; task.error = String(e); });
      return text(`后台目录上传已启动: ${id}\n${local_path} → ${remote_path}\n用 transfer_status("${id}") 查看进度`);
    }

    try {
      const r = await s.uploadDirectory(local_path, remote_path);
      return text(`目录上传成功: ${local_path} → ${remote_path}\n${formatTransferResult(r, `${r.files} 个文件`)}`);
    } catch (e) {
      return text(`目录上传失败: ${e}`);
    }
  },
);

server.tool(
  'download_file',
  '从远程服务器下载文件到本地（大文件可用 async 模式后台传输）',
  {
    remote_path: z.string().describe('远程文件路径'),
    local_path: z.string().optional().describe('本地保存路径，留空则保存到当前目录'),
    async_transfer: z.boolean().optional().default(false).describe('大文件建议开启，后台传输并返回任务ID'),
  },
  async ({ remote_path, local_path, async_transfer }) => {
    const s = requireSsh();
    const savePath = local_path || path.basename(remote_path);

    if (async_transfer) {
      const id = newTransferId();
      const task: TransferTask = { id, type: 'download', localPath: savePath, remotePath: remote_path, status: 'running', progress: null, result: null, error: null, startTime: Date.now() };
      transfers.set(id, task);
      s.downloadFile(remote_path, savePath, (p) => { task.progress = p; })
        .then((r) => { task.status = 'done'; task.result = r; })
        .catch((e) => { task.status = 'error'; task.error = String(e); });
      return text(`后台下载已启动: ${id}\n${remote_path} → ${savePath}\n用 transfer_status("${id}") 查看进度`);
    }

    try {
      const r = await s.downloadFile(remote_path, savePath);
      return text(`下载成功: ${remote_path} → ${savePath}\n${formatTransferResult(r)}`);
    } catch (e) {
      return text(`下载失败: ${e}`);
    }
  },
);

server.tool(
  'transfer_status',
  '查看后台传输任务的进度（配合 async_transfer=true 使用）',
  {
    task_id: z.string().optional().describe('任务ID，如 tf_1。留空则列出所有任务'),
  },
  async ({ task_id }) => {
    if (!task_id) {
      // 列出所有任务
      if (transfers.size === 0) return text('没有传输任务');
      const lines = [...transfers.values()].map((t) => {
        const dir = t.type === 'download' ? '↓' : '↑';
        if (t.status === 'done' && t.result)
          return `  ${t.id} ${dir} ✅ 完成 — ${formatTransferResult(t.result)}`;
        if (t.status === 'error')
          return `  ${t.id} ${dir} ❌ 失败 — ${t.error}`;
        if (t.progress)
          return `  ${t.id} ${dir} 🔄 ${formatProgress(t.progress)}`;
        return `  ${t.id} ${dir} 🔄 准备中...`;
      });
      return text('传输任务:\n' + lines.join('\n'));
    }

    const t = transfers.get(task_id);
    if (!t) return text(`任务不存在: ${task_id}`);

    const dir = t.type === 'download' ? '下载' : '上传';
    const pathInfo = `${t.localPath} ↔ ${t.remotePath}`;

    if (t.status === 'done' && t.result) {
      return text(`✅ ${dir}完成: ${pathInfo}\n${formatTransferResult(t.result)}`);
    }
    if (t.status === 'error') {
      return text(`❌ ${dir}失败: ${pathInfo}\n原因: ${t.error}`);
    }
    if (t.progress) {
      const elapsed = Date.now() - t.startTime;
      const remaining = t.progress.speed > 0
        ? (t.progress.total - t.progress.transferred) / t.progress.speed
        : 0;
      return text(`🔄 ${dir}中: ${pathInfo}\n${formatProgress(t.progress)}\n已耗时 ${formatElapsed(elapsed)}，预计剩余 ${formatElapsed(remaining * 1000)}`);
    }
    return text(`🔄 ${dir}准备中: ${pathInfo}`);
  },
);

// ── 服务器配置管理 ────────────────────────────────────────

server.tool(
  'add_server',
  '添加或更新服务器配置',
  {
    server_id: z.string().describe('服务器ID（唯一标识）'),
    name: z.string().describe('服务器名称'),
    host: z.string().describe('IP 地址或域名'),
    port: z.number().int().default(22).describe('SSH 端口，默认 22'),
    username: z.string().describe('SSH 用户名'),
    password: z.string().optional().describe('SSH 密码'),
    private_key: z.string().optional().describe('私钥文件路径（文件必须存在）'),
    private_key_content: z.string().optional().describe('私钥内容字符串（优先于 private_key）'),
    passphrase: z.string().optional().describe('私钥密码短语'),
    use_agent: z.boolean().optional().describe('使用系统 ssh-agent'),
    keyboard_interactive: z.boolean().optional().describe('启用键盘交互式认证（OTP/2FA）'),
    proxy: z.string().optional().describe('SOCKS5/4 代理预设ID，留空直连'),
    jump_host: z.string().optional().describe('跳板机服务器ID（ProxyJump）'),
  },
  async ({ server_id, name, host, port, username, password, private_key,
    private_key_content, passphrase, use_agent, keyboard_interactive, proxy, jump_host }) => {

    if (proxy && !config.getProxy(proxy))
      return text(`代理不存在: ${proxy}，请先用 add_proxy 添加。`);
    if (jump_host && !config.getServer(jump_host))
      return text(`跳板机不存在: ${jump_host}，请先用 add_server 添加。`);
    if (private_key && !fs.existsSync(private_key))
      return text(`私钥文件不存在: ${private_key}`);

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
      proxy ? `代理: ${proxy}` : '',
      jump_host ? `跳板: ${jump_host}` : '',
      use_agent ? 'agent' : '',
      keyboard_interactive ? 'kbd-interactive' : '',
    ].filter(Boolean).join(', ');

    return text(`服务器已保存: ${server_id} (${host}:${port})${tags ? `  [${tags}]` : ''}`);
  },
);

server.tool(
  'delete_server',
  '删除服务器配置',
  { server_id: z.string().describe('服务器ID') },
  async ({ server_id }) => {
    const ok = config.deleteServer(server_id);
    return text(ok ? `服务器已删除: ${server_id}` : `服务器不存在: ${server_id}`);
  },
);

// ── 代理配置管理 ──────────────────────────────────────────

server.tool('list_proxies', '列出所有已配置的 SOCKS 代理', {}, async () => {
  const proxies = config.getProxies();
  if (Object.keys(proxies).length === 0)
    return text('没有已配置的代理，请使用 add_proxy 添加。');

  const lines = Object.entries(proxies).map(([id, p]) => {
    const auth = p.username ? `，认证: ${p.username}` : '';
    return `  ${id}: ${p.name} SOCKS${p.type ?? 5} (${p.host}:${p.port}${auth})`;
  });
  return text('已配置的代理:\n' + lines.join('\n'));
});

server.tool(
  'add_proxy',
  '添加或更新 SOCKS 代理预设',
  {
    proxy_id: z.string().describe('代理ID（唯一标识）'),
    name: z.string().describe('代理名称'),
    host: z.string().describe('代理服务器地址'),
    port: z.number().int().describe('代理端口'),
    type: z.enum(['4', '5']).optional().default('5').describe('SOCKS 版本，4 或 5，默认 5'),
    username: z.string().optional().describe('认证用户名（可选）'),
    password: z.string().optional().describe('认证密码（可选）'),
  },
  async ({ proxy_id, name, host, port, type, username, password }) => {
    config.addProxy(proxy_id, {
      name, host, port,
      type: (parseInt(type ?? '5') as 4 | 5),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    });
    return text(`代理已保存: ${proxy_id} SOCKS${type ?? 5} (${host}:${port})`);
  },
);

server.tool(
  'delete_proxy',
  '删除代理预设',
  { proxy_id: z.string().describe('代理ID') },
  async ({ proxy_id }) => {
    const ok = config.deleteProxy(proxy_id);
    return text(ok ? `代理已删除: ${proxy_id}` : `代理不存在: ${proxy_id}`);
  },
);

// ── 启动 ──────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
