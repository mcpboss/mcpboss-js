import { Command } from 'commander';
import { McpBoss } from '../../../lib/index.js';
import { getHostedFunction, getErrorMessage } from '../../hosted.js';
import { output, outputError, outputProgress } from '../../output.js';
import { UpdateHostedToolFunctionRequest } from '../../../lib/api/types.gen.js';

export function createUpdateCommand(mcpBoss: McpBoss): Command {
  return new Command('update')
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
    );
}
