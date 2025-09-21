import { Command } from 'commander';
import { ConfigLoader, McpBoss } from '../../../lib/index.js';
import {
  promptForNewFunction,
  checkIndexJsExists,
  createZipFromDirectory,
  createHostedFunction,
  uploadZipToFunction,
  startHostedFunction,
  showDeploymentProgress,
  cleanupZipFile,
  fetchCrashLogs,
  getErrorMessage,
} from '../../hosted.js';
import { output, outputError, outputInfo, outputProgress } from '../../output.js';
import { getDeploymentsStatus } from '../../../lib/api/sdk.gen.js';

export function createDeployCommand(mcpBoss: McpBoss): Command {
  return new Command('deploy')
    .description('Deploy hosted tool (new or existing)')
    .argument('[path]', 'Root directory path for deployment (default: current directory)', process.cwd())
    .option('-i, --id <id>', 'Hosted function ID (if not provided, will create new)')
    .option('--no-progress', 'Skip deployment progress monitoring')
    .option('--no-logs', 'Skip fetching crash logs on deployment failure')
    .action(async (path: string, options: { id?: string; progress: boolean; logs: boolean }) => {
      let zipPath = '';
      try {
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
    });
}
