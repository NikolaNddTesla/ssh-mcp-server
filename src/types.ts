/** Proxy configuration */
export interface ProxyConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  type: 4 | 5; // SOCKS4 or SOCKS5
  username?: string;
  password?: string;
}

/** Server configuration */
export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;        // Private key file path
  privateKeyContent?: string; // Private key content (string)
  passphrase?: string;
  useAgent?: boolean;         // Use system ssh-agent
  keyboardInteractive?: boolean; // Keyboard-interactive auth (OTP/2FA)
  proxy?: string;             // Proxy preset ID
  jumpHost?: string;          // Jump host server ID
}

/** Persistent config file structure */
export interface AppConfig {
  servers: Record<string, Omit<ServerConfig, 'id'>>;
  proxies: Record<string, Omit<ProxyConfig, 'id'>>;
}
