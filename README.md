<div align="center">
  <img alt="Two people looking at the blueprint" height="86" src="https://mcpboss.mcp-boss.com/favicon-prod.png" width="86">
  <h1 align="center"><b>mcpboss-js</b></h1>
  <p align="center">🚀 CLI and JavaScript SDK</p>
</div>
<br/>

<p align="center">
  <a href="https://opensource.org/license/mit" rel="nofollow"><img src="https://img.shields.io/github/license/hey-api/openapi-ts" alt="MIT License"></a>
  <a href="https://badge.fury.io/js/mcpboss" rel="nofollow"><img src="https://badge.fury.io/js/mcpboss.svg" alt="npm package" /></a>
</p>

<p align="center">
  <a href="https://mcp-boss.com">Homepage</a><span>&nbsp;•&nbsp;</span>
  <a href="https://docs.mcp-boss.com/">API Spec</a>
  <span>&nbsp;•&nbsp;</span>
  <a href="https://discord.gg/6TvjvmSP">Discord</a>
</p>

<br/>

## Install

```bash
npm install mcpboss
```

## Quick Start SDK

```typescript
import { McpBoss } from 'mcpboss';
const client = new McpBoss();

// Agents
await client.query('Current weather?');
await client.query('Weather tomorrow?', {
  limitTools: ['getWeather'],
});

// List MCP Servers
await client.api.getMcpServers();
```

## Quick Start CLI

```bash
npm i -g mcpboss
mcpboss config login # login
mcpboss hosted ls # list hosted tools
```

### Package & Upload Hosted Tool

```bash
mkdir pkg
echo 'export const schema = {}' > pkg/index.js
mcpboss hosted deploy pgk
```

## Configuration

This is the default configuration lookup strategy:

1. Passed options (only SDK)
2. Environment variables `MCPBOSS_ORG_ID` and `MCPBOSS_API_KEY`
3. Configurations from `~/.mcpboss.config` in the following order
   1. `MCPBOSS_ORG_ID`
   2. The default organization

## SDK

Authentication can be controlled in the constructor by providing a custom `ConfigLoader`:

```typescript
const client = new McpBoss({ configLoader: ConfigLoader });
```

The configLoader must follow this shape:

```typescript
{
  getConfig(): { baseUrl: string; token: () => Promise<string> } | null;
}
```

## Agent Usage

### Basic Query

```typescript
const response = await client.query('Hello, how are you?');

if (response.type === 'success') {
  console.log(response.text);
  console.log(response.fullOutput); // Complete API response
} else {
  console.error('Error:', response.text);
}
```

### Advanced Query Options

```typescript
const response = await client.query('Search for recent news about AI', {
  agentId: 'specific-agent-id', // Use a specific agent
  modelId: 'gpt-4', // Use a specific model
  llmApiKeyId: 'my-openai-key', // Use a specific API key
  limitMcpServers: ['news-server'], // Limit to specific MCP servers
  limitTools: ['brave_news_search'], // Limit to specific tools
  dontAutoCreateAgent: false, // Prevent auto-creation of agents
  timeoutInMilliseconds: 300e3, // Wait maximum 5 minutes for LLM generation
});
```

### Agent Management

The SDK automatically handles agent selection and creation with intelligent fallback logic:

1. **Exact Match**: If `agentId` is provided, uses that specific agent
2. **Model + API Key**: Finds agent matching both `modelId` and `llmApiKeyId`
3. **Model Only**: Finds agent matching `modelId`
4. **API Key Only**: Finds agent matching `llmApiKeyId`
5. **Auto-Create**: Creates a new agent if none match (unless `dontAutoCreateAgent` is true)
6. **Fallback**: Uses the first available agent if no criteria specified

When auto-creating agents, the SDK will:

- Prefer the specified `modelId` if available
- Fall back to GPT-5 if available
- Use the first available model as a last resort
- Apply the specified `llmApiKeyId` or use the default

## Debugging

The SDK uses the `debug` package for logging. Enable debug output with:

```bash
DEBUG=mcpboss node your-script.js
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

We welcome contributions!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request
