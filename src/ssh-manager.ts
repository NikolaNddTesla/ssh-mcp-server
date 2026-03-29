import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import { SocksClient } from 'socks';
import { ServerConfig, ProxyConfig } from './types.js';

export interface TransferResult {
  bytes: number;
  files: number;
  elapsed: number;  // ms
  speed: number;    // bytes/s
  skipped?: boolean;       // single file: skipped (same MD5)
  skippedFiles?: number;   // directory: number of skipped files
  remoteOnly?: string[];   // directory: files existing on remote but not locally (possibly stale/outdated)
}

export interface TransferProgress {
  transferred: number;
  total: number;
  speed: number;      // bytes/s
  startTime: number;
}

export type OnProgress = (progress: TransferProgress) => void;


export class SshManager {
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  public lastError = '';

  // ── Connection ──────────────────────────────────────────────

  async connect(server: ServerConfig, proxy?: ProxyConfig, jumpServer?: ServerConfig): Promise<boolean> {
    await this.disconnect();
    try {
      let sock: net.Socket | undefined;

      if (jumpServer) {
        // Jump host mode: SSH to jump host first, then TCP forward to target
        sock = await this.createJumpSocket(server.host, server.port, jumpServer);
      } else if (proxy) {
        // SOCKS proxy mode
        sock = await this.createProxySocket(server.host, server.port, proxy);
      }

      const connectCfg = await this.buildConnectConfig(server, sock);

      await new Promise<void>((resolve, reject) => {
        const c = new Client();

        if (server.keyboardInteractive) {
          c.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
            // Auto-respond to all prompts with password (for simple OTP scenarios)
            const responses = prompts.map(() => server.password ?? '');
            finish(responses);
          });
        }

        c.on('ready', () => { this.client = c; resolve(); });
        c.on('error', reject);
        c.connect(connectCfg);
      });

      // Listen for disconnect, auto-cleanup state
      this.client!.on('close', () => {
        this.sftp = null;
        this.client = null;
      });
      this.client!.on('error', () => {
        this.sftp = null;
        this.client = null;
      });

      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** Test connectivity only, does not retain connection */
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
      // Use system ssh-agent
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
        // Close jump connection when target stream closes
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

  // ── Command Execution ──────────────────────────────────────────

  async execute(command: string, timeoutMs = 30000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    if (!this.client) throw new Error('Not connected to server');

    return new Promise((resolve) => {
      let resolved = false;
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, stdout, stderr: `[Timeout] Command exceeded ${timeoutMs / 1000}s` });
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

  // ── SFTP Tools ─────────────────────────────────────────

  private getSftp(): Promise<SFTPWrapper> {
    if (this.sftp) return Promise.resolve(this.sftp);
    if (!this.client) return Promise.reject(new Error('Not connected to server'));
    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) return reject(err);
        this.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  async uploadFile(localPath: string, remotePath: string, onProgress?: OnProgress, skipSame?: boolean): Promise<TransferResult> {
    const stat = fs.statSync(localPath);

    // MD5 dedup: skip if local and remote are identical
    if (skipSame) {
      const localMd5 = this.computeLocalMd5(localPath);
      const remoteMd5 = await this.computeRemoteMd5(remotePath);
      if (localMd5 && remoteMd5 && localMd5 === remoteMd5) {
        return { bytes: 0, files: 1, elapsed: 0, speed: 0, skipped: true };
      }
    }

    const sftp = await this.getSftp();
    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, {
        step: onProgress ? (transferred: number, _chunk: number, total: number) => {
          const elapsed = (Date.now() - start) / 1000;
          onProgress({ transferred, total, speed: elapsed > 0 ? transferred / elapsed : 0, startTime: start });
        } : undefined,
      } as any, (err) => (err ? reject(err) : resolve()));
    });
    const elapsed = Date.now() - start;
    return { bytes: stat.size, files: 1, elapsed, speed: elapsed > 0 ? stat.size / (elapsed / 1000) : 0 };
  }

  async downloadFile(remotePath: string, localPath: string, onProgress?: OnProgress): Promise<TransferResult> {
    const sftp = await this.getSftp();
    // Auto-create local parent directory
    const dir = path.dirname(localPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Get remote file size first
    const remoteStat = await new Promise<{ size: number }>((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => (err ? reject(err) : resolve(stats)));
    });

    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, {
        step: onProgress ? (transferred: number, _chunk: number, total: number) => {
          const elapsed = (Date.now() - start) / 1000;
          onProgress({ transferred, total, speed: elapsed > 0 ? transferred / elapsed : 0, startTime: start });
        } : undefined,
      } as any, (err) => (err ? reject(err) : resolve()));
    });
    const elapsed = Date.now() - start;
    return { bytes: remoteStat.size, files: 1, elapsed, speed: elapsed > 0 ? remoteStat.size / (elapsed / 1000) : 0 };
  }

  /**
   * Upload directory: local tar.gz → SFTP upload → remote extract → cleanup.
   * Much faster than per-file upload, especially for many small files.
   */
  async uploadDirectory(localDir: string, remoteDir: string, onProgress?: OnProgress, skipSame?: boolean): Promise<TransferResult> {
    const allFiles = this.listFiles(localDir);
    const start = Date.now();

    let filesToUpload = allFiles;
    let skippedCount = 0;
    let remoteOnly: string[] = [];
    const localFileSet = new Set(allFiles);

    // MD5 dedup: only upload changed files, also find remote-only files
    if (skipSame && allFiles.length > 0) {
      const remoteMd5Map = await this.getRemoteMd5Map(remoteDir);
      if (remoteMd5Map) {
        filesToUpload = [];
        for (const relPath of allFiles) {
          const localMd5 = this.computeLocalMd5(path.join(localDir, relPath));
          const remoteMd5 = remoteMd5Map.get(relPath);
          if (localMd5 && remoteMd5 && localMd5 === remoteMd5) {
            skippedCount++;
          } else {
            filesToUpload.push(relPath);
          }
        }
        // Collect files existing on remote but not locally
        for (const remotePath of remoteMd5Map.keys()) {
          if (!localFileSet.has(remotePath)) {
            remoteOnly.push(remotePath);
          }
        }
        // All identical, nothing to upload
        if (filesToUpload.length === 0) {
          return {
            bytes: 0, files: 0, elapsed: Date.now() - start, speed: 0,
            skippedFiles: skippedCount,
            ...(remoteOnly.length > 0 ? { remoteOnly } : {}),
          };
        }
      }
    }

    // Compress to tar.gz (only changed files when skipSame)
    const tmpName = `sshmcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tar.gz`;
    const tmpLocal = path.join(os.tmpdir(), tmpName);
    const remoteTar = `/tmp/${tmpName}`;

    try {
      if (skipSame && filesToUpload.length < allFiles.length) {
        // Write file list, only pack changed files
        const listFile = path.join(os.tmpdir(), `sshmcp_filelist_${Date.now()}.txt`);
        fs.writeFileSync(listFile, filesToUpload.join('\n'), 'utf-8');
        try {
          execSync(`tar -czf "${tmpLocal}" -C "${localDir}" -T "${listFile}"`, {
            stdio: 'pipe', timeout: 300000,
          });
        } finally {
          try { fs.unlinkSync(listFile); } catch { /* ignore */ }
        }
      } else {
        this.createTarGz(localDir, tmpLocal);
      }
      const tarSize = fs.statSync(tmpLocal).size;

      // SFTP upload archive (with progress callback)
      const sftp = await this.getSftp();
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(tmpLocal, remoteTar, {
          step: onProgress ? (transferred: number, _chunk: number, total: number) => {
            const elapsed = (Date.now() - start) / 1000;
            onProgress({ transferred, total, speed: elapsed > 0 ? transferred / elapsed : 0, startTime: start });
          } : undefined,
        } as any, (err) => (err ? reject(err) : resolve()));
      });

      // Remote extraction
      const { ok, stderr } = await this.execute(
        `mkdir -p ${remoteDir} && tar -xzf ${remoteTar} -C ${remoteDir} && rm -f ${remoteTar}`,
        120000,
      );
      if (!ok) {
        await this.execute(`rm -f ${remoteTar}`, 5000).catch(() => {});
        throw new Error(`Remote extraction failed: ${stderr}`);
      }

      const elapsed = Date.now() - start;
      return {
        bytes: tarSize, files: filesToUpload.length, elapsed,
        speed: elapsed > 0 ? tarSize / (elapsed / 1000) : 0,
        ...(skippedCount > 0 ? { skippedFiles: skippedCount } : {}),
        ...(remoteOnly.length > 0 ? { remoteOnly } : {}),
      };
    } finally {
      try { fs.unlinkSync(tmpLocal); } catch { /* ignore */ }
    }
  }

  /** Recursively count files in directory */
  private countFiles(dir: string): number {
    let count = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) count += this.countFiles(path.join(dir, e.name));
      else count++;
    }
    return count;
  }

  /** Recursively list all file relative paths in directory */
  private listFiles(dir: string, base = ''): string[] {
    const result: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) result.push(...this.listFiles(path.join(dir, e.name), rel));
      else result.push(rel);
    }
    return result;
  }

  /** Compute local file MD5 */
  private computeLocalMd5(filePath: string): string {
    const hash = crypto.createHash('md5');
    const data = fs.readFileSync(filePath);
    return hash.update(data).digest('hex');
  }

  /** Compute remote file MD5 (returns null if file doesn't exist) */
  private async computeRemoteMd5(remotePath: string): Promise<string | null> {
    const { ok, stdout } = await this.execute(`md5sum "${remotePath}" 2>/dev/null | awk '{print $1}'`, 10000);
    if (!ok || !stdout.trim()) return null;
    return stdout.trim();
  }

  /** Get MD5 map of all files in remote directory (relative path → md5) */
  private async getRemoteMd5Map(remoteDir: string): Promise<Map<string, string> | null> {
    const { ok, stdout } = await this.execute(
      `find "${remoteDir}" -type f -exec md5sum {} + 2>/dev/null`,
      60000,
    );
    if (!ok || !stdout.trim()) return null;
    const map = new Map<string, string>();
    const prefix = remoteDir.endsWith('/') ? remoteDir : remoteDir + '/';
    for (const line of stdout.trim().split('\n')) {
      const match = line.match(/^([a-f0-9]{32})\s+(.+)$/);
      if (match) {
        const relPath = match[2].startsWith(prefix) ? match[2].slice(prefix.length) : match[2];
        map.set(relPath, match[1]);
      }
    }
    return map;
  }

  /** Create tar.gz using system tar command (cross-platform) */
  private createTarGz(sourceDir: string, outputPath: string): void {
    // Use -C to switch into source dir, pack '.' so contents extract directly into target
    execSync(`tar -czf "${outputPath}" -C "${sourceDir}" .`, {
      stdio: 'pipe',
      timeout: 300000,  // 5 min timeout
    });
  }

  async readFile(remotePath: string, offset = 0, limit?: number): Promise<{ content: string; totalLines: number; readLines: number }> {
    const sftp = await this.getSftp();
    const data = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(remotePath, { encoding: 'utf-8' });
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
    const allLines = data.split('\n');
    const totalLines = allLines.length;
    const sliced = limit ? allLines.slice(offset, offset + limit) : allLines.slice(offset);
    return { content: sliced.join('\n'), totalLines, readLines: sliced.length };
  }

  async downloadDirectory(remotePath: string, localPath: string, onProgress?: OnProgress): Promise<TransferResult> {
    const start = Date.now();
    const tmpName = `sshmcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tar.gz`;
    const remoteTar = `/tmp/${tmpName}`;
    const tmpLocal = path.join(os.tmpdir(), tmpName);

    try {
      // 1. Remote compression
      const { ok, stderr } = await this.execute(
        `tar -czf ${remoteTar} -C "${remotePath}" .`,
        300000,
      );
      if (!ok) throw new Error(`Remote compression failed: ${stderr}`);

      // 2. SFTP download archive
      const sftp = await this.getSftp();
      const remoteStat = await new Promise<{ size: number }>((resolve, reject) => {
        sftp.stat(remoteTar, (err, stats) => (err ? reject(err) : resolve(stats)));
      });
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(remoteTar, tmpLocal, {
          step: onProgress ? (transferred: number, _chunk: number, total: number) => {
            const elapsed = (Date.now() - start) / 1000;
            onProgress({ transferred, total, speed: elapsed > 0 ? transferred / elapsed : 0, startTime: start });
          } : undefined,
        } as any, (err) => (err ? reject(err) : resolve()));
      });

      // 3. Cleanup remote temp file
      await this.execute(`rm -f ${remoteTar}`, 5000).catch(() => {});

      // 4. Local extraction
      if (!fs.existsSync(localPath)) fs.mkdirSync(localPath, { recursive: true });
      execSync(`tar -xzf "${tmpLocal}" -C "${localPath}"`, {
        stdio: 'pipe',
        timeout: 300000,
      });

      // Count files
      const fileCount = this.countFiles(localPath);
      const elapsed = Date.now() - start;
      return { bytes: remoteStat.size, files: fileCount, elapsed, speed: elapsed > 0 ? remoteStat.size / (elapsed / 1000) : 0 };
    } finally {
      try { fs.unlinkSync(tmpLocal); } catch { /* ignore */ }
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
