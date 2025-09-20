import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: './lib/index.ts',
    'bin/mcpboss': './src/cli.ts',
  },
  platform: 'node',
  dts: {},
  external: ['commander'], // Keep commander as external dependency
});
