import { Command } from 'commander';
import { McpBoss } from '../../../lib/index.js';
import { showDeploymentProgress, fetchCrashLogs, getErrorMessage } from '../../hosted.js';
import { output, outputError } from '../../output.js';

export function createShowCommand(mcpBoss: McpBoss): Command {
  return new Command('show')
    .description('Show hosted tool deployment')
    .argument('<functionId>', 'Hosted function ID to retrieve')
    .action(async (functionId: string) => {
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
    });
}
