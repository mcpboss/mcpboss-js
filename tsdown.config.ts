import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./lib/index.ts'],
  platform: 'node',
  dts: {},
});
