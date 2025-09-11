import { describe, it } from 'node:test';
import * as SDK from '../lib/index.js';
describe('sample test', () => {
  it('should pass a', async () => {
    const sdk = new SDK.McpBoss({
      tenantId: 'org3',
      baseUrl: 'https://org3.mcp-boss.test/api/v1',
      apiKey: process.env.MCPBOSS_API_KEY || '',
    });
    const res = await sdk.query('Hello how are you?', {
      modelId: 'gemini-2.5-pro',
      limitTools: ['brave_news_search'],
    });
    console.log(res.text);
  });
});
