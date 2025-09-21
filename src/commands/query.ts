import { Command } from 'commander';
import { McpBoss } from '../../lib/index.js';
import { output, outputError, outputProgress } from '../output.js';

interface QueryOptions {
  agentId?: string;
  modelId?: string;
  apiKeyId?: string;
  servers?: string;
  full?: boolean;
  tools?: string;
  noAutoCreate?: boolean;
  timeout?: number;
}

export function createQueryCommand(mcpBoss: McpBoss): Command {
  return new Command('query')
    .description('Send a query to an MCP Boss agent')
    .argument('<prompt>', 'The prompt to send to the agent')
    .option('-a, --agent-id <id>', 'Specific agent ID to use')
    .option('-m, --model-id <id>', 'Model ID to use')
    .option('-k, --api-key-id <id>', 'LLM API key ID to use')
    .option('-s, --servers <servers>', 'Comma-separated list of MCP servers to limit to')
    .option('-t, --tools <tools>', 'Comma-separated list of tools to limit to')
    .option(
      '-f, --full',
      'Set full output mode (include full response data) default: false, will output the text response only'
    )
    .option('--no-auto-create', 'Disable automatic agent creation')
    .option('--timeout <ms>', 'Timeout in milliseconds', parseInt)
    .action(async (prompt: string, options: QueryOptions) => {
      try {
        const queryOptions: Parameters<typeof mcpBoss.query>[1] = {};
        if (options.agentId) queryOptions.agentId = options.agentId;
        if (options.modelId) queryOptions.modelId = options.modelId;
        if (options.apiKeyId) queryOptions.llmApiKeyId = options.apiKeyId;
        if (options.servers) queryOptions.limitMcpServers = options.servers.split(',');
        if (options.tools) queryOptions.limitTools = options.tools.split(',');
        if (options.noAutoCreate) queryOptions.dontAutoCreateAgent = true;
        if (options.timeout) queryOptions.timeoutInMilliseconds = options.timeout;

        outputProgress('Sending query to MCP Boss...');
        const result = await mcpBoss.query(prompt, queryOptions);

        if (result.type === 'error') {
          outputError(result.text);
        } else {
          output(options.full ? result.fullOutput : result.text);
        }
      } catch (error) {
        outputError(error);
      }
    });
}
