import { createClient } from '@hey-api/openapi-ts';

createClient({
  input: process.env.OVERRIDE_OPENAPI_URL || 'https://mcp-boss.com/api/v1/openapi.json',
  output: {
    format: false,
    path: 'lib/api',
  },
  plugins: [
    {
      baseUrl: false,
      throwOnError: false,
      name: '@hey-api/client-fetch',
    },
  ],
});
