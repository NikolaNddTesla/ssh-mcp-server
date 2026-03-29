import fs from 'fs';
import path from 'path';
import { AppConfig, ProxyConfig, ServerConfig } from './types.js';

const DEFAULT_CONFIG: AppConfig = {
  servers: {},
  proxies: {},
};

export class ConfigManager {
  private configPath: string;
  private config: AppConfig;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.config = this.load();
  }

  private load(): AppConfig {
    if (!fs.existsSync(this.configPath)) {
      this.save(DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG };
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return {
        servers: parsed.servers ?? {},
        proxies: parsed.proxies ?? {},
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  reload() {
    this.config = this.load();
  }

  private save(cfg: AppConfig = this.config) {
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf-8');
  }

  // ── Servers ────────────────────────────────────────────

  getServers(): Record<string, Omit<ServerConfig, 'id'>> {
    this.reload();
    return this.config.servers;
  }

  getServer(id: string): (Omit<ServerConfig, 'id'> & { id: string }) | null {
    this.reload();
    const s = this.config.servers[id];
    return s ? { id, ...s } : null;
  }

  addServer(id: string, cfg: Omit<ServerConfig, 'id'>) {
    this.reload();
    this.config.servers[id] = cfg;
    this.save();
  }

  updateServer(id: string, partial: Partial<Omit<ServerConfig, 'id'>>): boolean {
    this.reload();
    if (!this.config.servers[id]) return false;
    this.config.servers[id] = { ...this.config.servers[id], ...partial };
    // Delete null-valued fields (for clearing optional config)
    for (const [k, v] of Object.entries(this.config.servers[id])) {
      if (v === null || v === undefined) delete (this.config.servers[id] as any)[k];
    }
    this.save();
    return true;
  }

  renameServer(oldId: string, newId: string): boolean {
    this.reload();
    if (!this.config.servers[oldId]) return false;
    if (this.config.servers[newId]) return false; // new ID already exists
    this.config.servers[newId] = this.config.servers[oldId];
    delete this.config.servers[oldId];
    // Update servers referencing old ID as jump host
    for (const s of Object.values(this.config.servers)) {
      if ((s as any).jumpHost === oldId) (s as any).jumpHost = newId;
    }
    this.save();
    return true;
  }

  deleteServer(id: string): boolean {
    this.reload();
    if (!this.config.servers[id]) return false;
    delete this.config.servers[id];
    this.save();
    return true;
  }

  // ── Proxies ──────────────────────────────────────────────

  getProxies(): Record<string, Omit<ProxyConfig, 'id'>> {
    this.reload();
    return this.config.proxies;
  }

  getProxy(id: string): (Omit<ProxyConfig, 'id'> & { id: string }) | null {
    this.reload();
    const p = this.config.proxies[id];
    return p ? { id, ...p } : null;
  }

  addProxy(id: string, cfg: Omit<ProxyConfig, 'id'>) {
    this.reload();
    this.config.proxies[id] = cfg;
    this.save();
  }

  deleteProxy(id: string): boolean {
    this.reload();
    if (!this.config.proxies[id]) return false;
    delete this.config.proxies[id];
    this.save();
    return true;
  }
}
