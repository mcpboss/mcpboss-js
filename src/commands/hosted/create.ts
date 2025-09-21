import { Command } from 'commander';
import { McpBoss } from '../../../lib/index.js';
import { createHostedFunction } from '../../hosted.js';
import { outputError, outputSuccess } from '../../output.js';

export function createCreateCommand(mcpBoss: McpBoss): Command {
  return new Command('create')
    .description('Create a new hosted tool (without deploying)')
    .option('-n, --name <name>', 'Function name')
    .option('-d, --description <description>', 'Function description')
    .action(async (options: { name?: string; description?: string }) => {
      try {
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
    });
}
