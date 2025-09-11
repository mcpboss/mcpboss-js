# mcpboss-js

Official JavaScript/TypeScript SDK for MCP Boss - a powerful LLM Agent + Model Context Protocol (MCP) management platform.

[![npm version](https://badge.fury.io/js/mcpboss.svg)](https://badge.fury.io/js/mcpboss)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is MCP Boss?

MCP Boss is a management platform for LLM Agents and an MCP gateway management platform, allowing you to orchestrate AI agents with access to various tools and data sources. This SDK provides a simple interface to interact with your MCP Boss tenant programmatically.

## Pre-requisites

You need an account at https://mcp-boss.com

## Installation

```bash
npm install mcpboss
```

## Agent Quick Start

```typescript
import { McpBoss } from 'mcpboss';

const client = new McpBoss({
  apiKey: 'your_api_key', // or MCPBOSS_API_KEY
  orgId: 'your_org_id', // or MCPBOSS_ORG_ID
});

// Simple query
const response = await client.query('What is the weather today?');
console.log(response.text);
```

## API SDK

This library also exposes an SDK for all publically available API endpoints in `McpBoss.api`

```typescript
import { McpBoss } from 'mcpboss';

const mb = new McpBoss();

const { data: servers } = await mb.api.getMcpServers();
```

This is an auto-generated SDK based on the OpenAPI specification.

## Configuration

### McpBossOptions

| Option    | Type   | Required | Description                                                             |
| --------- | ------ | -------- | ----------------------------------------------------------------------- |
| `apiKey`  | string | No/Env   | Your MCP Boss API key, or set environment variable MCPBOSS_API_KEY.     |
| `orgId`   | string | No/Env   | Your org identifier, or set environment variable MCPBOSS_ORG_ID.        |
| `baseUrl` | string | No       | Custom API base URL (defaults to `https://{orgId}.mcp-boss.com/api/v1`) |

## Usage

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

## Agent Management

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

## Support

- **Documentation**: [API Reference](https://docs.mcp-boss.com)
- **Discord**: [Join our community](https://discord.gg/6TvjvmSP)

## Related Projects

- [MCP Boss](https://mcp-boss.com) - The main platform

## Contributing

We welcome contributions!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request
