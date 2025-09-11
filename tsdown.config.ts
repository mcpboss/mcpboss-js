import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./lib/index.ts', './lib/api/index.ts'],
  platform: 'node',
  dts: {},
});
