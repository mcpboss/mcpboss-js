import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface McpBossConfig {
  apiKey?: string;
  orgId?: string;
  baseUrl?: string;
}

const CONFIG_FILE_PATH = join(homedir(), '.mcpboss.config');

export function getConfigFilePath(): string {
  return CONFIG_FILE_PATH;
}

export function readConfig(): McpBossConfig {
  try {
    if (!existsSync(CONFIG_FILE_PATH)) {
      return {};
    }

    const configData = readFileSync(CONFIG_FILE_PATH, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    // If file doesn't exist or is malformed, return empty config
    return {};
  }
}

export function writeConfig(config: McpBossConfig): void {
  try {
    // Ensure the directory exists (though homedir should always exist)
    const configDir = homedir();
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    throw new Error(`Failed to write config file: ${(error as Error).message}`);
  }
}

export function updateConfig(updates: Partial<McpBossConfig>): void {
  const currentConfig = readConfig();
  const newConfig = { ...currentConfig, ...updates };
  writeConfig(newConfig);
}
