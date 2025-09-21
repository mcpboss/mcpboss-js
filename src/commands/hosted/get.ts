import { Command } from 'commander';
import { McpBoss } from '../../../lib/index.js';
import { getHostedFunction } from '../../hosted.js';
import { output, outputProgress } from '../../output.js';
import { getDeploymentsStatus } from '../../../lib/api/sdk.gen.js';

export function createGetCommand(mcpBoss: McpBoss): Command {
  return new Command('get')
    .description('Get hosted tool details and show deployment logs')
    .argument('<functionId>', 'Hosted function ID to retrieve')
    .action(async (functionId: string) => {
      // Get the hosted tool details
      const hostedFunction = await getHostedFunction(mcpBoss, functionId);
      const state = await getDeploymentsStatus({ query: { hostedFunctionId: functionId } });

      output({ ...hostedFunction, ...state.data });
    });
}
