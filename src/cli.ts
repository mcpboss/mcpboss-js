#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setOutputOptions, OutputFormat } from './output.js';
import { createQueryCommand, createAgentsCommand, createHostedCommand, createConfigCommand } from './commands/index.js';
import { ConfigLoader, EnvConfigStrategy, FileConfigStrategy, McpBoss } from '../lib/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json for version - go up two levels from dist/bin to root
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

const program = new Command();

interface GlobalOptions {
  format?: OutputFormat;
  nonInteractive?: boolean;
}

const configLoader = new ConfigLoader([new EnvConfigStrategy(), new FileConfigStrategy()]);
const mcpBoss = new McpBoss({ configLoader });

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

// Register all commands
program.addCommand(createQueryCommand(mcpBoss));
program.addCommand(createAgentsCommand(mcpBoss));
program.addCommand(createHostedCommand(mcpBoss));
program.addCommand(createConfigCommand(configLoader));

program.parse();
