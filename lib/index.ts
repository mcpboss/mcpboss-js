import { client } from './api/client.gen.js';
import * as sdk from './api/sdk.gen.js';
import type { Agent } from './api/types.gen.js';
import createDebug from 'debug';
import { getOrganization, getDefaultOrganization, setOrganizationConfig } from '../src/config.js';
import * as openidClient from 'openid-client';
import { Config } from './api/client/types.gen.js';
const debug = createDebug('mcpboss');

export interface McpBossOptions {
  apiKey: string;
  orgId?: string;
  baseUrl?: string;
}

export type McpBossConfig = { baseUrl: string; token: () => Promise<string> };
export class ConfigLoader {
  constructor(private strategies: ConfigStrategy[]) {}

  getConfig(): McpBossConfig {
    for (const strategy of this.strategies) {
      const config = strategy.getConfig();
      if (config) {
        return config;
      }
    }
    throw new Error('No valid configuration found from any strategy');
  }
}

export abstract class ConfigStrategy {
  abstract getConfig(): { baseUrl: string; token: () => Promise<string> } | null;
}

export class OptionsConfigStrategy extends ConfigStrategy {
  constructor(private options?: McpBossOptions) {
    super();
  }

  getConfig() {
    if (!this.options) {
      return null;
    }
    if (this.options.apiKey && (this.options.orgId || this.options.baseUrl)) {
      const key = this.options.apiKey;
      const baseUrl = this.options.baseUrl || `https://${this.options.orgId}.mcp-boss.com`;
      return {
        baseUrl,
        token: async () => key,
      };
    }
    return null;
  }
}

export class EnvConfigStrategy extends ConfigStrategy {
  getConfig() {
    const apiKey = process.env.MCPBOSS_API_KEY;
    const orgId = process.env.MCPBOSS_ORG_ID;
    const overrideBaseUrl = process.env.MCPBOSS_BASE_URL;
    if (apiKey && (orgId || overrideBaseUrl)) {
      return {
        baseUrl: overrideBaseUrl || `https://${orgId}.mcp-boss.com`,
        token: async () => apiKey,
      };
    }
    return null;
  }
}

export class FileConfigStrategy extends ConfigStrategy {
  constructor(private orgId?: string) {
    super();
  }

  getConfig() {
    let orgId = this.orgId || process.env.MCPBOSS_ORG_ID || getDefaultOrganization();
    if (!orgId) {
      return null;
    }
    debug(`FileConfigLoader loading config for orgId=${orgId}`);
    const tenantConfig = getOrganization(orgId);
    if (!tenantConfig) {
      return null;
    }
    return {
      baseUrl: tenantConfig.baseUrl,
      token: async () => {
        if (tenantConfig?.apiKey) {
          return tenantConfig.apiKey;
        } else if (tenantConfig?.tokens?.access_token) {
          return tenantConfig.tokens.access_token;
        } else if (tenantConfig.tokens?.refresh_token) {
          debug('Access token expired or about to expire, attempting to refresh');
          // Try to refresh the token
          const config = await openidClient.discovery(
            new URL(`/.well-known/openid-configuration`, tenantConfig.baseUrl),
            `${orgId}-cli`
          );
          const token = await openidClient.refreshTokenGrant(config, tenantConfig.tokens.refresh_token);
          if (token) {
            setOrganizationConfig(orgId, {
              tokens: {
                access_token: token.access_token,
                refresh_token: token.refresh_token || tenantConfig.tokens.refresh_token,
                expires_at: token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : 0,
              },
            });
            debug('Token refreshed successfully');
            return token.access_token;
          }
        }
        throw new Error('No valid API key, access token or refresh token available.');
      },
    };
  }
}

export class McpBoss {
  public api = sdk;
  public readonly config: McpBossConfig;
  constructor(arg?: { options?: McpBossOptions; configLoader?: ConfigLoader }) {
    // Try to get config from file if not provided via options or env vars
    const configLoader =
      arg?.configLoader ||
      new ConfigLoader([new OptionsConfigStrategy(arg?.options), new EnvConfigStrategy(), new FileConfigStrategy()]);

    this.config = configLoader.getConfig();

    const clientConfig = {
      baseUrl: new URL('/api/v1/', this.config.baseUrl).toString(),
      auth: this.config.token,
    } satisfies Config;
    client.setConfig(clientConfig);
    debug('McpBoss initialized with config', clientConfig);
  }

  async query(
    prompt: string,
    options?: {
      agentId?: string;
      modelId?: string;
      llmApiKeyId?: string;
      limitMcpServers?: string[];
      limitTools?: string[];
      dontAutoCreateAgent?: boolean;
      timeoutInMilliseconds?: number;
    }
  ): Promise<
    | {
        type: 'error';
        text: string;
      }
    | {
        type: 'success';
        text: string;
        fullOutput: Record<string, unknown>;
      }
  > {
    debug('Starting query with options:', options);
    let agent: Agent;
    {
      const { data, error } = await this.api.getAgents();
      if (error) {
        throw error;
      }
      if (!data) {
        throw new Error('No agents available');
      }
      const agents = data.agents;

      debug(`Found ${agents.length} agents`);

      let agentCandidate: Agent | undefined;

      // Priority 1: Find by exact agent ID
      if (options?.agentId) {
        agentCandidate = agents.find(x => x.id === options.agentId);
        if (agentCandidate) {
          debug(`Found agent by ID: ${options.agentId}`);
        }
      }

      // Priority 2: Find by both model ID and API key ID matching
      if (!agentCandidate && options?.modelId && options?.llmApiKeyId) {
        agentCandidate = agents.find(x => x.modelId === options.modelId && x.apiKeyId === options.llmApiKeyId);
        if (agentCandidate) {
          debug(`Found agent by model ID and API key ID: ${options.modelId}, ${options.llmApiKeyId}`);
        }
      }

      // Priority 3: Find by model ID only
      if (!agentCandidate && options?.modelId) {
        agentCandidate = agents.find(x => x.modelId === options.modelId);
        if (agentCandidate) {
          debug(`Found agent by model ID: ${options.modelId}`);
        }
      }

      // Priority 4: Find by API key ID only
      if (!agentCandidate && options?.llmApiKeyId) {
        agentCandidate = agents.find(x => x.apiKeyId === options.llmApiKeyId);
        if (agentCandidate) {
          debug(`Found agent by API key ID: ${options.llmApiKeyId}`);
        }
      }

      // Fallback: Use first available agent
      if (!agentCandidate && !options?.llmApiKeyId && !options?.modelId && !options?.agentId) {
        agentCandidate = agents[0];
        if (agentCandidate) {
          debug(`Using first available agent: ${agentCandidate.id}`);
        }
      } else {
        debug('Did not find existing agent matching the provided criteria');
      }

      if (agentCandidate) {
        agent = agentCandidate;
      } else if (options?.dontAutoCreateAgent) {
        debug('Did not find existing agent, and auto-creation is disabled');
        throw new Error('No matching agent found and auto-creation is disabled');
      } else {
        debug('Did not find existing agent, will attempt to create one. Getting available llm models');
        // Create a new agent if none found
        const { data: dataModels } = await this.api.getAgentsLlmModels({ throwOnError: true });
        debug(`Found ${dataModels.models.length} available models`);
        const model =
          dataModels.models.find(m => m.id === options?.modelId) ||
          dataModels.models.find(x => x.id === 'gpt-5') ||
          dataModels.models[0];
        if (!model) {
          throw new Error('No LLM models available to create an agent');
        }
        debug(
          `Creating agent with model ${model.name} from provider ${model.llmApiId} with key ${options?.llmApiKeyId || 'default key'}`
        );
        const { data: dataAgent } = await this.api.postAgents({
          body: {
            modelId: model.id,
            llmApiId: model.llmApiId,
            apiKeyId: options?.llmApiKeyId ?? null,
            name: `Auto-created agent for model ${model.name}`,
            description: 'An agent created automatically by the mcpboss-js SDK',
            modelConfiguration: {},
            systemMessage:
              'You are an assistant. Please make sure you use any tools available to you to to answer questions. Think step by step. Be consise and accurate.',
            prompt: '',
            isEnabled: true,
            inputSchema: '',
            outputSchema: '',
          },
          throwOnError: true,
        });
        agent = dataAgent.agent;
      }
    }

    let runId: string;
    {
      debug(`Making request...`);
      const { data, error } = await this.api.postAgentsByAgentIdRuns({
        path: {
          agentId: agent.id,
        },
        body: {
          customPrompt: prompt,
          limitMcpServers: options?.limitMcpServers,
          limitTools: options?.limitTools,
        },
      });
      debug(`Request made successfully, got run ID: ${data?.runId} (error=${error})`);

      if (error) {
        throw error;
      } else if (!data) {
        throw new Error('No run data returned');
      }

      runId = data.runId;
    }

    // Poll for the run result
    debug(`Now waiting for result...`);
    const start = Date.now();
    if (options?.timeoutInMilliseconds) {
      debug(`Will timeout after ${options.timeoutInMilliseconds} milliseconds`);
    }
    do {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const { data, error } = await this.api.getAgentsByAgentIdRunsByRunId({
        path: {
          agentId: agent.id,
          runId,
        },
      });

      if (error) {
        throw error;
      } else if (!data) {
        throw new Error('No run data returned');
      }

      if (data.run.outcome !== 'unknown') {
        debug(`Got outcome: ${data.run.outcome}`);
        if (data.run.output.type === 'error') {
          return {
            text: data.run.output.data || '',
            type: 'error',
          };
        } else {
          const textMessage = data.run.output.data?.message?.content
            ?.map(x => x.text)
            .filter(x => !!x)
            .join('\n');
          return {
            text: textMessage || '',
            type: 'success',
            fullOutput: data.run.output.data,
          };
        }
      }
    } while (options?.timeoutInMilliseconds === undefined || Date.now() - start < options.timeoutInMilliseconds);

    throw new Error('Timeout reached while waiting for run to complete');
  }
}
