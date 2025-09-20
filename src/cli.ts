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
  .description('Manage hosted tool functions')
  .addCommand(
    new Command('deploy')
      .description('Deploy hosted tool function (new or existing)')
      .argument('[path]', 'Root directory path for deployment (default: current directory)', process.cwd())
      .option('-i, --id <id>', 'Hosted function ID (if not provided, will create new)')
      .action(async (path: string, options: { id?: string }) => {
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

            outputProgress(`Creating new hosted function: ${name}`);
            const functionInfo = await createHostedFunction(mcpBoss, name!);
            functionId = functionInfo.id;
            outputProgress(`Created hosted function with ID: ${functionId}`);
          }

          // Step 2: Check for index.js file
          outputProgress('🔍 Checking for index.js file...');
          const indexCheck = checkIndexJsExists(deploymentPath);
          if (!indexCheck.exists) {
            outputError(
              `index.js file not found in directory: ${deploymentPath}. Make sure the directory contains an index.js file.`
            );
            return;
          }

          if (!indexCheck.hasSchema) {
            outputProgress('⚠️  Warning: index.js does not contain a schema export.');
            outputProgress('   Make sure your file exports a schema:');
            outputProgress('   • ES modules: export const schema = { ... }');
            outputProgress('   • CommonJS: module.exports.schema = { ... }');
            outputProgress('   Proceeding anyway...');
          }

          // Step 3: Create ZIP package
          outputProgress('Creating deployment package...');
          const zipPath = await createZipFromDirectory(deploymentPath);

          // Step 4: Upload ZIP
          outputProgress('Deploying...');
          await uploadZipToFunction(mcpBoss, functionId, zipPath);
          await startHostedFunction(mcpBoss, functionId);

          // Step 5: Show deployment progress
          try {
            await showDeploymentProgress(mcpBoss, functionId);

            // Step 6: Cleanup
            await cleanupZipFile(zipPath);

            outputSuccess('Successfully deployed and started hosted function!', {
              functionId,
              nextSteps: [
                'Your function is now running and available to agents',
                'You can view logs and manage the function through the MCP Boss dashboard',
                `Use "mcpboss hosted deploy --id ${functionId} [path]" to update this function`,
              ],
            });
          } catch (error) {
            // Step 6: Cleanup even on failure
            await cleanupZipFile(zipPath);

            outputError(`Deployment failed: ${error}`);
            outputInfo('You can check the deployment status and logs in the MCP Boss dashboard');
            return;
          }
        } catch (error) {
          outputError(error);
        }
      })
  )
  .addCommand(
    new Command('ls').description('List hosted tool functions').action(async () => {
      try {
        const mcpBoss = new McpBoss();

        const functions = await listHostedFunctions(mcpBoss);

        // Define table columns for hosted functions
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
      .description('Create a new hosted tool function (without deploying)')
      .option('-n, --name <name>', 'Function name')
      .option('-d, --description <description>', 'Function description')
      .action(async (options: { name?: string; description?: string }) => {
        try {
          const mcpBoss = new McpBoss();

          let functionName = options.name;
          if (!functionName) {
            const { input } = await import('@inquirer/prompts');
            functionName = await input({
              message: 'Enter the name for the new hosted function:',
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

          outputProgress(`📝 Creating hosted function: ${functionName}`);

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
