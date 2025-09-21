import { Command } from 'commander';
import { ConfigLoader, McpBoss } from '../../lib/index.js';
import { output, outputError, TableColumn } from '../output.js';

export function createAgentsCommand(mcpBoss: McpBoss): Command {
  return new Command('agents').addCommand(
    new Command('ls').description('List available agents').action(async () => {
      try {
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
    })
  );
}
