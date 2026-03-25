#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { ConfigManager } from './config.js';
import { SshManager } from './ssh-manager.js';

// 配置文件存在用户目录，避免被 build 清掉
const CONFIG_DIR = path.join(os.homedir(), '.ssh-mcp');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

const config = new ConfigManager(CONFIG_PATH);
let ssh = new SshManager();
let currentServerId: string | null = null;

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
  '上传本地文件到远程服务器（路径直传，不占 Token）',
  {
    local_path: z.string().describe('本地文件绝对路径'),
    remote_path: z.string().describe('远程目标路径'),
  },
  async ({ local_path, remote_path }) => {
    const s = requireSsh();
    if (!fs.existsSync(local_path)) return text(`本地文件不存在: ${local_path}`);
    try {
      await s.uploadFile(local_path, remote_path);
      return text(`上传成功: ${local_path} → ${remote_path}`);
    } catch (e) {
      return text(`上传失败: ${e}`);
    }
  },
);

server.tool(
  'upload_directory',
  '递归上传本地目录到远程服务器',
  {
    local_path: z.string().describe('本地目录绝对路径'),
    remote_path: z.string().describe('远程目标路径'),
  },
  async ({ local_path, remote_path }) => {
    const s = requireSsh();
    if (!fs.existsSync(local_path)) return text(`本地目录不存在: ${local_path}`);
    try {
      await s.uploadDirectory(local_path, remote_path);
      return text(`目录上传成功: ${local_path} → ${remote_path}`);
    } catch (e) {
      return text(`目录上传失败: ${e}`);
    }
  },
);

server.tool(
  'download_file',
  '从远程服务器下载文件到本地',
  {
    remote_path: z.string().describe('远程文件路径'),
    local_path: z.string().optional().describe('本地保存路径，留空则保存到当前目录'),
  },
  async ({ remote_path, local_path }) => {
    const s = requireSsh();
    const savePath = local_path || path.basename(remote_path);
    try {
      await s.downloadFile(remote_path, savePath);
      return text(`下载成功: ${remote_path} → ${savePath}`);
    } catch (e) {
      return text(`下载失败: ${e}`);
    }
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
