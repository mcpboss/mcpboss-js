import { describe, it } from 'node:test';
import * as SDK from '../lib/index.js';
describe('sample test', () => {
  it('should pass a', async () => {
    const sdk = new SDK.McpBoss();
    const res = await sdk.query('Hello how are you?', {
      modelId: 'gemini-2.5-pro',
      limitTools: ['brave_news_search'],
    });
    console.log(res.text);
  });
});
