import fs from 'fs';
import path from 'path';
import net from 'net';
import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import { SocksClient } from 'socks';
import { ServerConfig, ProxyConfig } from './types.js';


export class SshManager {
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  public lastError = '';

  // ── 连接 ──────────────────────────────────────────────

  async connect(server: ServerConfig, proxy?: ProxyConfig, jumpServer?: ServerConfig): Promise<boolean> {
    await this.disconnect();
    try {
      let sock: net.Socket | undefined;

      if (jumpServer) {
        // 跳板机模式：先 SSH 到跳板机，再从跳板机 TCP 转发到目标
        sock = await this.createJumpSocket(server.host, server.port, jumpServer);
      } else if (proxy) {
        // SOCKS 代理模式
        sock = await this.createProxySocket(server.host, server.port, proxy);
      }

      const connectCfg = await this.buildConnectConfig(server, sock);

      await new Promise<void>((resolve, reject) => {
        const c = new Client();

        if (server.keyboardInteractive) {
          c.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
            // 用密码自动响应所有提示（适用于简单 OTP 场景）
            const responses = prompts.map(() => server.password ?? '');
            finish(responses);
          });
        }

        c.on('ready', () => { this.client = c; resolve(); });
        c.on('error', reject);
        c.connect(connectCfg);
      });

      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** 仅测试连通性，不保留连接 */
  async testConnection(server: ServerConfig, proxy?: ProxyConfig, jumpServer?: ServerConfig): Promise<boolean> {
    const tmp = new SshManager();
    const ok = await tmp.connect(server, proxy, jumpServer);
    await tmp.disconnect();
    if (!ok) this.lastError = tmp.lastError;
    return ok;
  }

  private async buildConnectConfig(server: ServerConfig, sock?: net.Socket): Promise<ConnectConfig> {
    const cfg: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: 15000,
      ...(sock ? { sock } : {}),
    };

    if (server.useAgent) {
      // 使用系统 ssh-agent
      const agentSocket = process.env.SSH_AUTH_SOCK;
      if (agentSocket) cfg.agent = agentSocket;
    }

    if (server.privateKeyContent) {
      cfg.privateKey = server.privateKeyContent;
      if (server.passphrase) cfg.passphrase = server.passphrase;
    } else if (server.privateKey) {
      cfg.privateKey = fs.readFileSync(server.privateKey);
      if (server.passphrase) cfg.passphrase = server.passphrase;
    }

    if (server.password) cfg.password = server.password;

    if (server.keyboardInteractive) cfg.tryKeyboard = true;

    return cfg;
  }

  private async createProxySocket(host: string, port: number, proxy: ProxyConfig): Promise<net.Socket> {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: proxy.type ?? 5,
        ...(proxy.username ? { userId: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {}),
      },
      command: 'connect',
      destination: { host, port },
    });
    return socket;
  }

  private async createJumpSocket(host: string, port: number, jump: ServerConfig): Promise<net.Socket> {
    const jumpClient = new Client();
    const jumpCfg = await this.buildConnectConfig(jump);

    await new Promise<void>((resolve, reject) => {
      jumpClient.on('ready', resolve);
      jumpClient.on('error', reject);
      jumpClient.connect(jumpCfg);
    });

    return new Promise((resolve, reject) => {
      jumpClient.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err) { jumpClient.end(); return reject(err); }
        // 当目标流关闭时，一并关闭跳板连接
        stream.on('close', () => jumpClient.end());
        resolve(stream as unknown as net.Socket);
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.sftp) { this.sftp.end(); this.sftp = null; }
    if (this.client) { this.client.end(); this.client = null; }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  // ── 命令执行 ──────────────────────────────────────────

  async execute(command: string, timeoutMs = 30000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    if (!this.client) throw new Error('未连接服务器');

    return new Promise((resolve) => {
      let resolved = false;
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, stdout, stderr: `[超时] 命令执行超过 ${timeoutMs / 1000}s` });
        }
      }, timeoutMs);

      this.client!.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return resolve({ ok: false, stdout: '', stderr: err.message });
        }

        stream.on('data', (d: Buffer) => (stdout += d.toString()));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        stream.on('close', (code: number) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve({ ok: code === 0, stdout, stderr });
          }
        });
      });
    });
  }

  // ── SFTP 工具 ─────────────────────────────────────────

  private getSftp(): Promise<SFTPWrapper> {
    if (this.sftp) return Promise.resolve(this.sftp);
    if (!this.client) return Promise.reject(new Error('未连接服务器'));
    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) return reject(err);
        this.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.getSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.getSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async uploadDirectory(localDir: string, remoteDir: string): Promise<void> {
    const sftp = await this.getSftp();

    await new Promise<void>((resolve) => {
      sftp.mkdir(remoteDir, () => resolve());
    });

    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const lp = path.join(localDir, entry.name);
      const rp = `${remoteDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.uploadDirectory(lp, rp);
      } else {
        await this.uploadFile(lp, rp);
      }
    }
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.open(remotePath, 'w', (err, handle) => {
        if (err) return reject(err);
        const buf = Buffer.from(content, 'utf-8');
        sftp.write(handle, buf, 0, buf.length, 0, (err2) => {
          sftp.close(handle, () => {});
          err2 ? reject(err2) : resolve();
        });
      });
    });
  }

}
