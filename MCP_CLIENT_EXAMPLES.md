# MCP Client Implementation Examples

Copy-paste ready code for integrating lexRAG MCP into your projects.

## TypeScript/Node.js Client (Recommended)

```typescript
import axios from 'axios';

export class MCPClient {
  private http = axios.create({ baseURL: 'http://localhost:9000' });
  private sessionId: string | null = null;

  async initialize(projectId: string, workspaceRoot: string) {
    const res = await this.http.post('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    this.sessionId = res.headers['mcp-session-id'];

    await this.call('graph_set_workspace', {
      workspaceRoot,
      projectId,
      sourceDir: 'src',
    });
  }

  async call(tool: string, args: any) {
    if (!this.sessionId) throw new Error('Not initialized');
    const res = await this.http.post(
      '/mcp',
      {
        jsonrpc: '2.0',
        id: Date.now(),
        method: tool,
        params: args,
      },
      { headers: { 'mcp-session-id': this.sessionId } }
    );
    return res.data.result;
  }

  async query(q: string) {
    return this.call('graph_query', {
      query: q,
      language: 'natural',
      limit: 20,
    });
  }

  async explain(symbol: string) {
    return this.call('code_explain', { symbol });
  }

  async impact(files: string[]) {
    return this.call('impact_analyze', { changedFiles: files });
  }
}
```

## Usage

```typescript
const mcp = new MCPClient();
await mcp.initialize('my-project', '/workspace');

// Find code
const results = await mcp.query('find all HTTP handlers');

// Understand symbol
const auth = await mcp.explain('AuthService');

// Analyze impact
const impact = await mcp.impact(['src/auth/service.ts']);
```

See [CLAUDE_COPILOT_INTEGRATION.md](CLAUDE_COPILOT_INTEGRATION.md) for chat integration patterns.
