#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, McpBoss } from '../lib/index.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readConfig, updateConfig, getConfigFilePath, McpBossConfig } from './config.js';
import {
  promptForNewFunction,
  checkIndexJsExists,
  createZipFromDirectory,
  createHostedFunction,
  uploadZipToFunction,
  startHostedFunction,
  showDeploymentProgress,
  cleanupZipFile,
  listHostedFunctions,
  getHostedFunction,
  fetchCrashLogs,
  getErrorMessage,
} from './hosted.js';
import {
  output,
  outputSuccess,
  outputError,
  outputInfo,
  outputProgress,
  setOutputOptions,
  OutputFormat,
  TableColumn,
} from './output.js';
import { getDeploymentsStatus } from '../lib/api/sdk.gen.js';
import { UpdateHostedToolFunctionRequest } from '../lib/api/types.gen.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json for version - go up two levels from dist/bin to root
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

const program = new Command();

interface GlobalOptions {
  format?: OutputFormat;
  nonInteractive?: boolean;
}

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

program
  .name('mcpboss')
  .description('CLI tool for MCP Boss - AI agent management and querying')
  .version(packageJson.version)
  .option('-f, --format <format>', 'Output format (json, yaml, table)', 'table')
  .option('--non-interactive', 'Non-interactive mode (errors to stderr, no prompts)')

  .hook('preAction', thisCommand => {
    // Set output options based on global flags
    const opts = thisCommand.opts<GlobalOptions>();

    // Auto-detect interactive mode if not explicitly set
    let interactive = true;
    if (opts.nonInteractive !== undefined) {
      // Explicitly set via --non-interactive flag
      interactive = !opts.nonInteractive;
    } else {
      // Auto-detect: interactive if we have a TTY and stdout is not being piped
      interactive = process.stdout.isTTY && process.stdin.isTTY && !process.env.CI;
    }

    setOutputOptions({
      format: (opts.format as OutputFormat) || 'table',
      interactive,
    });
  });

program
  .command('query')
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
      const mcpBoss = new McpBoss();

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

program
  .command('agents')
  .description('List available agents')
  .action(async () => {
    try {
      const mcpBoss = new McpBoss();
      const { data, error } = await mcpBoss.api.getAgents();

      if (error) {
        outputError(error);
        return;
      }

      if (!data || !data.agents.length) {
        output({ agents: [] });
        return;
      }

      // Define table columns for agents
      const agentsTableColumns: TableColumn[] = [
        { name: 'id', title: 'ID', alignment: 'left' },
        { name: 'name', title: 'Name', alignment: 'left' },
        { name: 'modelId', title: 'Model', alignment: 'left' },
        { name: 'isEnabled', title: 'Enabled', alignment: 'center' },
        { name: 'description', title: 'Description', alignment: 'left' },
      ];

      // Transform data for table display
      const agentsForTable = data.agents.map((agent: any) => ({
        id: agent.id,
        name: agent.name,
        modelId: agent.modelId,
        isEnabled: agent.isEnabled ? 'Yes' : 'No',
        description: agent.description || '',
      }));

      output({ agents: agentsForTable }, { tableColumns: agentsTableColumns });
    } catch (error) {
      outputError(error);
    }
  });

program
  .command('hosted')
  .description('Manage hosted tools')
  .addCommand(
    new Command('deploy')
      .description('Deploy hosted tool (new or existing)')
      .argument('[path]', 'Root directory path for deployment (default: current directory)', process.cwd())
      .option('-i, --id <id>', 'Hosted function ID (if not provided, will create new)')
      .option('--no-progress', 'Skip deployment progress monitoring')
      .option('--no-logs', 'Skip fetching crash logs on deployment failure')
      .action(async (path: string, options: { id?: string; progress: boolean; logs: boolean }) => {
        let zipPath = '';
        try {
          const mcpBoss = new McpBoss();
          let functionId = options.id;

          // Use the positional argument for deployment path
          const deploymentPath = path;

          // Step 1: Handle function ID (create new if not provided)
          if (!functionId) {
            const { create, name } = await promptForNewFunction();
            if (!create) {
              outputInfo('Deployment cancelled.');
              process.exit(0);
            }

            outputInfo(`Creating new hosted tool: ${name}`);
            const functionInfo = await createHostedFunction(mcpBoss, name!);
            functionId = functionInfo.id;
            outputInfo(`Created hosted tool with ID: ${functionId}`);
          }

          const indexCheck = checkIndexJsExists(deploymentPath);
          if (!indexCheck.exists) {
            outputError(
              `index.js file not found in directory: ${deploymentPath}. Make sure the directory contains an index.js file.`
            );
            return;
          }

          if (!indexCheck.hasSchema) {
            outputInfo(
              `Warning: index.js does not contain a schema export.` +
                `Make sure your file exports a schema: ` +
                `• ES modules: export const schema = { ... }` +
                `• CommonJS: module.exports.schema = { ... }` +
                `Proceeding anyway...`
            );
          }

          // Step 3: Create ZIP package
          outputInfo('Creating deployment package...');
          zipPath = await createZipFromDirectory(deploymentPath);

          // Step 4: Upload ZIP
          outputInfo('Deploying...');
          await uploadZipToFunction(mcpBoss, functionId, zipPath);
          await startHostedFunction(mcpBoss, functionId);

          // Step 5: Show deployment progress (if not disabled)
          if (options.progress) {
            const result = await showDeploymentProgress(mcpBoss, functionId, false);
            output({
              deployed: result.deployed,
              stabilized: result.stabilized,
            });

            // Print logs unless --no-logs and if deployment failed
            if (options.logs && !result.stabilized) {
              try {
                let podName = result.podName;
                if (!podName) {
                  // Fallback: get podName from deployment status
                  const state = await getDeploymentsStatus({ query: { hostedFunctionId: functionId } });
                  const deployments = state.data?.deployments || [];
                  podName = deployments.length > 0 ? deployments[0].name : undefined;
                }

                if (podName) {
                  const crashLogs = await fetchCrashLogs(mcpBoss, podName);
                  if (crashLogs) {
                    output(crashLogs.stdout);
                  }
                }
              } catch (logError) {
                outputError(`Failed to fetch crash logs: ${logError}`);
              }
            }

            // Exit with error code if deployment failed
            if (!result.stabilized) {
              process.exit(1);
            }

            // If stabilized, call endpoint to get tools for final validation
            const tools = await mcpBoss.api.getHostedFunctionsByFunctionIdTools({ path: { functionId } });
            if (tools.error) {
              outputError(`Failed to validate deployed function tools: ${getErrorMessage(tools.error)}`);
              process.exit(1);
            }

            output(tools.data);
          } else {
            output({
              deployed: true,
              stabilized: 'unknown',
            });
          }
          process.exit(0);
        } catch (error) {
          outputError(error);
        } finally {
          if (zipPath) {
            // Step 6: Cleanup even on failure
            cleanupZipFile(zipPath).catch(err => outputError(`Error cleaning up temp file: ${err}`));
          }
        }
      })
  )
  .addCommand(
    new Command('update')
      .description('Update hosted tool metadata (name, description, environment variables)')
      .argument('<functionId>', 'Hosted function ID to update')
      .option('-n, --name <name>', 'Update function name')
      .option('-d, --description <description>', 'Update function description')
      .option('-E, --is-enabled <isEnabled>', 'Update function enabled status (true or false)')
      .option(
        '-e, --env <key=value>',
        'Set environment variable (can be used multiple times)',
        (value, previous: Array<{ key: string; value: string }> = []) => {
          const [key, val] = value.split('=');
          if (!key || val === undefined) {
            throw new Error('Environment variables must be in format KEY=VALUE');
          }
          return [...previous, { key, value: val }];
        }
      )
      .addHelpText(
        'after',
        `
Examples:
  $ mcpboss hosted update func123 --name "My Updated Function"
  $ mcpboss hosted update func123 --description "A better description"
  $ mcpboss hosted update func123 --env API_KEY=secret123
  $ mcpboss hosted update func123 --env DB_URL=postgres://localhost --env DEBUG=true
  $ mcpboss hosted update func123 --name "New Name" --description "New desc" --env PORT=3000`
      )
      .action(
        async (
          functionId: string,
          options: {
            name?: string;
            description?: string;
            env?: Array<{ key: string; value: string }>;
            enabled?: string;
          }
        ) => {
          try {
            const mcpBoss = new McpBoss();

            // Verify the function exists and get current details
            let currentFunction;
            try {
              currentFunction = await getHostedFunction(mcpBoss, functionId);
            } catch (error) {
              outputError(`Hosted function with ID ${functionId} not found`);
              process.exit(1);
            }

            // Check if any updates were provided
            if (!options.name && !options.description && !options.env) {
              outputError('No updates provided. Use --name, --description, or --env options.');
              process.exit(1);
            }

            // Prepare update payload
            const updateData: UpdateHostedToolFunctionRequest = {};

            if (options.name) {
              updateData.name = options.name;
            }

            if (options.description) {
              updateData.description = options.description;
            }

            if (options.enabled !== undefined) {
              updateData.isEnabled = options.enabled.toLowerCase() === 'true';
            }

            // Handle environment variables
            if (options.env) {
              // Start with existing env vars if not clearing
              const existingEnv = currentFunction.env || [];
              const envMap = new Map(existingEnv);

              // Add/update new env vars
              options.env.forEach(({ key, value }) => {
                envMap.set(key, value);
              });

              updateData.env = Array.from(envMap.entries());
            }

            const { error } = await mcpBoss.api.putHostedFunctionsByFunctionId({
              path: { functionId },
              body: updateData,
            });

            if (error) {
              outputError(`Failed to update hosted tool: ${getErrorMessage(error)}`);
              process.exit(1);
            }

            // Get updated function details
            const updatedFunction = await getHostedFunction(mcpBoss, functionId);

            output(updatedFunction);
          } catch (error) {
            outputError(error);
            process.exit(1);
          }
        }
      )
  )
  .addCommand(
    new Command('ls').description('List hosted tools').action(async () => {
      try {
        const mcpBoss = new McpBoss();

        const functions = await listHostedFunctions(mcpBoss);

        // Define table columns for hosted tools
        const functionsTableColumns: TableColumn[] = [
          { name: 'id', title: 'ID', alignment: 'left' },
          { name: 'name', title: 'Name', alignment: 'left' },
          { name: 'createdAt', title: 'Created', alignment: 'left' },
          { name: 'updatedAt', title: 'Updated', alignment: 'left' },
          { name: 'isEnabled', title: 'Enabled', alignment: 'center' },
        ];

        output({ functions }, { tableColumns: functionsTableColumns });
      } catch (error) {
        outputError(error);
      }
    })
  )
  .addCommand(
    new Command('create')
      .description('Create a new hosted tool (without deploying)')
      .option('-n, --name <name>', 'Function name')
      .option('-d, --description <description>', 'Function description')
      .action(async (options: { name?: string; description?: string }) => {
        try {
          const mcpBoss = new McpBoss();

          let functionName = options.name;
          if (!functionName) {
            const { input } = await import('@inquirer/prompts');
            functionName = await input({
              message: 'Enter the name for the new hosted tool:',
              validate: input => {
                if (!input.trim()) {
                  return 'Function name is required';
                }
                if (input.length < 3) {
                  return 'Function name must be at least 3 characters long';
                }
                return true;
              },
            });
          }

          const functionInfo = await createHostedFunction(mcpBoss, functionName, options.description);

          outputSuccess('Hosted function created successfully!', {
            functionId: functionInfo.id,
            functionName: functionInfo.name,
            nextSteps: [
              'Prepare your function code with an index.js file',
              'Make sure your index.js exports a schema (export const schema or module.exports.schema)',
              `Deploy your function: mcpboss hosted deploy --id ${functionInfo.id} [path]`,
              'Or list all functions: mcpboss hosted ls',
            ],
          });
        } catch (error) {
          outputError(error);
        }
      })
  )
  .addCommand(
    new Command('get')
      .description('Get hosted tool details and show deployment logs')
      .argument('<functionId>', 'Hosted function ID to retrieve')
      .action(async (functionId: string) => {
        const mcpBoss = new McpBoss();

        // Get the hosted tool details
        const hostedFunction = await getHostedFunction(mcpBoss, functionId);
        const state = await getDeploymentsStatus({ query: { hostedFunctionId: functionId } });

        output({ ...hostedFunction, ...state.data });
      })
  )
  .addCommand(
    new Command('show')
      .description('Show hosted tool deployment')
      .argument('<functionId>', 'Hosted function ID to retrieve')
      .action(async (functionId: string) => {
        const mcpBoss = new McpBoss();
        const result = await showDeploymentProgress(mcpBoss, functionId, false);
        if (result.stabilized && result.podName) {
          const tools = await mcpBoss.api.getHostedFunctionsByFunctionIdTools({ path: { functionId } });
          if (tools.error) {
            outputError(`Failed to validate deployed function tools: ${getErrorMessage(tools.error)}`);
            process.exit(1);
          }

          output(tools.data);
        } else if (!result.stabilized && result.podName) {
          // get logs
          if (result.podName) {
            const logs = await fetchCrashLogs(mcpBoss, result.podName);
            if (logs) {
              output(logs.stdout);
              output(logs.stderr);
            }
          }
        }
        process.exit(0);
      })
  );

program
  .command('config')
  .description('Show configuration requirements and current status')
  .addCommand(
    new Command('set-auth')
      .description('Set API key and organization ID')
      .option('-t, --key <key>', 'MCP Boss API key')
      .option('-o, --org-id <org-id>', 'Organization ID')
      .option('-b, --base-url <base-url>', 'Base URL (default: none) - experimental - hardcodes the base URL')
      .action(async (options: { key?: string; orgId?: string; baseUrl?: string }) => {
        try {
          // Validate that at least one option is provided
          if (!options.key && !options.orgId && !options.baseUrl) {
            console.error('At least one option must be provided.');
            console.error('Usage: mcpboss config set-auth [options]');
            console.error('Options:');
            console.error('  -t, --key <key>              MCP Boss API key');
            console.error('  -o, --org-id <org-id>        Organization ID');
            console.error('  -b, --base-url <base-url>    Base URL (experimental)');
            process.exit(1);
          }

          let config: McpBossConfig = {};
          if (options.key) config.apiKey = options.key;
          if (options.baseUrl) config.baseUrl = options.baseUrl;
          if (options.orgId) config.orgId = options.orgId;

          updateConfig(config);
          config = readConfig(); // re-read to show effective config
          console.log('✅ Authentication credentials saved successfully!');
          console.log(`Config file: ${getConfigFilePath()}`);
          console.log(`Organization ID: ${config.orgId}`);
          console.log('API Key: [SAVED]');
          console.log(`Base URL: ${config.baseUrl || '[NOT SET]'}`);
          console.log('');
          console.log('You can now use MCP Boss commands without setting environment variables.');
          if (!config.apiKey) {
            console.log('⚠️  Warning: API key is not set, you will need to provide it via environment variable.');
          }
          if (!config.orgId) {
            console.log('⚠️  Warning: orgId is not set, you will need to provide it via environment variable.');
          }
        } catch (error) {
          console.error('❌ Error saving credentials:', (error as Error).message);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('ls').action(() => {
      const storedConfig = readConfig();
      const effectiveConfig = loadConfig();
      output({ storedConfig, effectiveConfig });
    })
  );

program.parse();
