/** 代理配置 */
export interface ProxyConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  type: 4 | 5; // SOCKS4 or SOCKS5
  username?: string;
  password?: string;
}

/** 服务器配置 */
export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;        // 私钥文件路径
  privateKeyContent?: string; // 私钥内容（直接传字符串）
  passphrase?: string;
  useAgent?: boolean;         // 使用系统 ssh-agent
  keyboardInteractive?: boolean; // 键盘交互式认证（OTP/2FA）
  proxy?: string;             // 代理预设 ID
  jumpHost?: string;          // 跳板机服务器 ID
}

/** 持久化配置文件结构 */
export interface AppConfig {
  servers: Record<string, Omit<ServerConfig, 'id'>>;
  proxies: Record<string, Omit<ProxyConfig, 'id'>>;
}
