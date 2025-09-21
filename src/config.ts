import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import _ from 'lodash';

export interface OrganizationConfig {
  baseUrl: string;
  apiKey?: string;
  tokens?: {
    access_token: string;
    refresh_token: string;
    expires_at: number; // Unix timestamp
  };
}

export interface McpBossConfig {
  orgs?: Record<string, OrganizationConfig>;
  defaultOrgId?: string;
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
    const config = JSON.parse(configData);

    // Migrate legacy config to new structure if needed
    if (config.orgId && !config.orgs) {
      const baseUrl = config.baseUrl || `https://${config.orgId}.mcp-boss.com`;
      config.orgs = {
        [baseUrl]: {
          apiKey: config.apiKey,
        },
      };
      config.defaultOrgId = baseUrl;
    }

    return config;
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

// Tenant management functions

export function extractTenantFromUrl(baseUrl: string): string {
  return new URL(baseUrl).hostname.split('.').shift() || '';
}

export function setOrganizationConfig(orgId: string, orgConfig: Partial<OrganizationConfig>): void {
  const config = readConfig();

  if (!config.orgs) {
    config.orgs = {};
  }

  _.merge(config.orgs[orgId], orgConfig);

  // Set as default if it's the first organization
  if (!config.defaultOrgId) {
    config.defaultOrgId = orgId;
  }

  writeConfig(config);
}

export function getOrganization(orgId: string): OrganizationConfig | undefined {
  const config = readConfig();
  return config.orgs?.[orgId.toLowerCase()];
}

export function listOrganizations(): string[] {
  const config = readConfig();
  return Object.keys(config.orgs || {});
}

export function setDefaultOrganization(orgId: string): void {
  const config = readConfig();
  if (!config.orgs?.[orgId]) {
    throw new Error(`${orgId} not found in config`);
  }

  config.defaultOrgId = orgId;
  writeConfig(config);
}

export function getDefaultOrganization(): string | undefined {
  const config = readConfig();
  return config.defaultOrgId;
}

export function removeOrganization(orgId: string): void {
  const config = readConfig();

  if (!config.orgs?.[orgId]) {
    throw new Error(`${orgId} not found in config`);
  }

  delete config.orgs[orgId];

  // If we're removing the default org id, pick a new one
  if (config.defaultOrgId === orgId) {
    const remainingOrganizations = Object.keys(config.orgs);
    config.defaultOrgId = remainingOrganizations.length > 0 ? remainingOrganizations[0] : undefined;
  }

  writeConfig(config);
}
