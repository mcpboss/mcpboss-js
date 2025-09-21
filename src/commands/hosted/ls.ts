import { Command } from 'commander';
import { McpBoss } from '../../../lib/index.js';
import { listHostedFunctions } from '../../hosted.js';
import { output, outputError, TableColumn } from '../../output.js';

export function createLsCommand(mcpBoss: McpBoss): Command {
  return new Command('ls').description('List hosted tools').action(async () => {
    try {
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
  });
}
