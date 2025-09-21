import { Command } from 'commander';
import { createDeployCommand } from './deploy.js';
import { createUpdateCommand } from './update.js';
import { createLsCommand } from './ls.js';
import { createCreateCommand } from './create.js';
import { createGetCommand } from './get.js';
import { createShowCommand } from './show.js';
import { ConfigLoader, McpBoss } from '../../../lib/index.js';

export function createHostedCommand(mcpBoss: McpBoss): Command {
  return new Command('hosted')
    .description('Manage hosted tools')
    .addCommand(createDeployCommand(mcpBoss))
    .addCommand(createUpdateCommand(mcpBoss))
    .addCommand(createLsCommand(mcpBoss))
    .addCommand(createCreateCommand(mcpBoss))
    .addCommand(createGetCommand(mcpBoss))
    .addCommand(createShowCommand(mcpBoss));
}
