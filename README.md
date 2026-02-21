# Code Graph MCP Server

A standalone code analysis system powered by Memgraph and MCP that enables intelligent code queries, architecture validation, test selection, and progress tracking for any TypeScript/JavaScript repository.

## What It Does

The Code Graph Tool solves three critical development problems:

1. **Token-Expensive LLM Analysis** → Stores complete codebase structure (696 TypeScript files → 44K+ nodes) in Memgraph for instant, context-aware code queries without re-reading files
2. **Scattered Progress Tracking** → Replaces 73 markdown files with a queryable graph of features, tasks, and their implementing code
3. **Slow Test Execution** → Enables 60%+ test time reduction by selecting only affected tests based on dependency analysis

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 18+
- Claude CLI (`npm install -g @anthropic-ai/claude`)

### 1. Start Infrastructure

```bash
cd tools/graph-server
# Optional: isolate data for this repository in shared Memgraph
export CODE_GRAPH_PROJECT_ID=my-repo
# Optional: point to target codebase root (defaults to current workspace)
export CODE_GRAPH_TARGET_WORKSPACE=/absolute/path/to/your/codebase
docker-compose up -d

# Verify services
docker-compose ps  # Should show "healthy"
```

### 2. Build Graph

```bash
cd tools/graph-server
npm install
npm run build

# Full build (one-time, ~5 minutes)
node dist/index.js graph:build

# Or via CLI
npm run graph:build
```

### 3. Use Claude CLI

```bash
# Ask naturally
claude --message "What architecture violations exist?"
claude --message "Which tests are affected by src/engine/calculations/columns.ts?"

# Or interactive mode
claude --interactive
> What components use BuildingContext?
> Find circular dependencies
> Show test coverage for LoadTakedownService
```

**That's it!** MCP is configured globally at `~/.claude/mcp.json`.

## Core Capabilities

### Expert Agent Profile

For an AI agent that understands this project and uses it efficiently, use:

- [docs/GRAPH_EXPERT_AGENT.md](docs/GRAPH_EXPERT_AGENT.md)

This profile encodes the correct runtime sequence (`graph_set_workspace` → `graph_rebuild` → `graph_health/query`), Docker path-sandbox behavior, and fast query strategies.

### GitHub Copilot Agent Format

Graph Expert Agent is now available in GitHub Copilot extension-friendly files:

- [.github/copilot-instructions.md](.github/copilot-instructions.md)
- [.github/prompts/graph-expert.prompt.md](.github/prompts/graph-expert.prompt.md)
- [.github/agents/graph-expert.agent.md](.github/agents/graph-expert.agent.md)

Use the prompt/custom agent in Copilot Chat to run the session-aware workflow (`initialize` + `mcp-session-id` + `graph_set_workspace` + `graph_rebuild`).

### 21 Tools Available (Use Naturally via Claude)

#### 🔍 GraphRAG (3 tools)

Search and understand your codebase as a connected graph:

- **graph_query**: Execute Cypher queries or ask natural language questions
- **code_explain**: Understand code with full dependency context
- **find_pattern**: Discover architectural patterns, violations, and circular dependencies

#### 🏛️ Architecture (2 tools)

Enforce and validate your project's architecture:

- **arch_validate**: Check all files against layer rules, report violations with severity
- **arch_suggest**: Get recommended location for new code based on dependencies

#### 🧪 Test Intelligence (4 tools)

Run only the tests you need:

- **test_select**: Find affected tests for changed files (transitive dependency analysis)
- **test_categorize**: Stratify tests by type (unit, integration, performance, e2e)
- **impact_analyze**: See full blast radius of your changes (up to depth N)
- **test_run**: Execute selected tests via Vitest (built-in)

#### 📊 Progress Tracking (4 tools)

Track features and tasks in the graph:

- **progress_query**: Query features/tasks by status
- **task_update**: Update task status in Memgraph
- **feature_status**: Show implementing code for a feature
- **blocking_issues**: Find tasks blocking progress

#### 🔄 Vector Search (5 tools)

Find semantically similar code (MVP placeholders):

- **semantic_search**: Search for similar functions/classes
- **find_similar_code**: Find equivalent implementations
- **code_clusters**: Group related code by semantic similarity
- **semantic_diff**: Compare code changes semantically
- **suggest_tests**: Suggest tests for new code

#### 🛠️ Utility (4 tools)

- **graph_set_workspace**: Set active workspace/project context at runtime via MCP (workspaceRoot/sourceDir/projectId)
- **graph_rebuild**: Full or incremental graph rebuild
- **graph_health**: Show graph/index/vector connectivity and freshness
- **contract_validate**: Normalize and validate tool argument contracts

### Dynamic Workspace Selection (Recommended)

Use MCP tools to point the server at whichever repo is currently open:

1. Call `graph_set_workspace` with `workspaceRoot` (or `workspacePath`) and optional `sourceDir`.
2. Call `graph_rebuild` (incremental/full) using the active workspace context.

This avoids hardcoding per-repo paths in MCP config files.

### MCP HTTP Session Flow (Required for Multi-Window Isolation)

When using HTTP transport, workspace context is session-scoped. Clients must keep one MCP session per VS Code window.

1. Send `initialize` to `POST /mcp` (or `POST /`).
2. Read `mcp-session-id` from the response headers.
3. Include `mcp-session-id` on all subsequent MCP requests for that window.
4. In that same session, call `graph_set_workspace` then `graph_rebuild`.

If `mcp-session-id` is missing/invalid, the server returns `400 Bad Request` for non-initialize requests.

Example (curl):

```bash
# 1) Initialize and capture session ID header
curl -i -X POST http://localhost:9000/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"client","version":"1.0.0"}}}'

# 2) Use returned mcp-session-id on follow-up requests
curl -X POST http://localhost:9000/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graph_set_workspace","arguments":{"workspaceRoot":"/workspace","sourceDir":"src","projectId":"my-repo"}}}'
```

## Architecture

### Graph Schema (18 Node Types, 20 Relationships)

**Code Structure (8)**

- FILE, FOLDER, FUNCTION, CLASS, VARIABLE, IMPORT, EXPORT

**Architecture (5)**

- LAYER, COMPONENT, CONTEXT, SERVICE, HOOK

**Testing (3)**

- TEST_SUITE, TEST_CASE, TEST_FIXTURE

**Progress (2)**

- FEATURE, TASK

**Relationships**: CONTAINS, IMPORTS, EXPORTS, CALLS, EXTENDS, IMPLEMENTS, USES, BELONGS_TO_LAYER, VIOLATES_RULE, TESTS, BLOCKS, etc.

### 8 Architectural Layers (Enforced)

| Layer          | Can Import From                        | Purpose                            |
| -------------- | -------------------------------------- | ---------------------------------- |
| **types**      | (none)                                 | Type definitions only              |
| **constants**  | types                                  | Code constants, config values      |
| **utils**      | types, constants                       | Utility functions                  |
| **engine**     | types, constants, utils                | Calculation logic (pure functions) |
| **hooks**      | types, constants, utils, engine        | React hooks                        |
| **context**    | types, constants, utils, engine, hooks | Context providers                  |
| **components** | \*                                     | React UI components                |
| **lib**        | types, constants, utils                | Library re-exports                 |

**Violations automatically detected** via `npm run graph:validate`

### Current State

- **696 TypeScript files** parsed
- **44,140 nodes** created (code structure + architecture + progress)
- **45,308 relationships** mapped
- **350 violations** detected (18 errors, 327 warnings)
- **260 test files** with 7,817 test cases
- **~5 minutes** for full build
- **<1 second** for CLI queries

## Usage Examples

### Architecture Queries

```bash
# What components violate the architecture?
claude --message "Show all architecture violations"

# Where should I add this new feature?
claude --message "Best location for a new column calculation service"

# What tests should I update?
claude --message "Which tests are affected by changes to BuildingContext?"

# Find problematic patterns
claude --message "Find all circular dependencies"
```

### Test Intelligence

```bash
# Quick test selection
npm run test:affected src/engine/calculations/columns.ts

# With options
npm run test:affected src/engine/**/*.ts --run --depth=2

# Via Claude
claude --message "Which tests should I run after modifying LoadTakedownService?"
```

### Progress Tracking

```bash
# Query features in progress
claude --message "Show all in-progress features"

# Update task status
claude --message "Mark task canvas-perf-v2-grid-layer as completed"

# See what's blocking
claude --message "What tasks are blocking the code-graph-mvp feature?"
```

### Code Understanding

```bash
# Understand a service with dependencies
claude --message "Explain LoadTakedownService and what uses it"

# Find implementations
claude --message "Show all components using BuildingContext"

# Impact analysis
claude --message "Show blast radius of changes to DrawingContext"
```

## Configuration

### Architecture Rules

Edit `.code-graph/config.json` to customize:

```json
{
  "architecture": {
    "layers": [
      {
        "id": "engine",
        "paths": ["src/engine/calculations/**"],
        "canImport": ["types", "constants", "utils"],
        "cannotImport": ["components", "context"],
        "description": "Pure calculation logic"
      }
    ],
    "rules": [
      {
        "id": "no-engine-in-ui",
        "severity": "error",
        "check": "engine cannot import from components"
      }
    ]
  },
  "progress": {
    "features": [
      {
        "id": "code-graph-mvp",
        "name": "Code Graph MVP",
        "status": "in-progress",
        "priority": 1
      }
    ]
  }
}
```

### Pre-Commit Hook (Optional)

Automatically validate architecture on commit:

```bash
npm run graph:install-hooks
```

Then commits with violations will be blocked:

```
❌ Commit blocked: Architecture violations detected
Fix the violations above or use 'git commit --no-verify' to bypass
```

## Multi-Project Isolation

When multiple repositories share one Memgraph instance, set `CODE_GRAPH_PROJECT_ID` per repository.

- All graph nodes are written with `projectId`.
- Node IDs are namespaced as `<projectId>:<entity>`.
- Natural-language `graph_query` templates automatically filter by current `projectId`.

Example:

```bash
CODE_GRAPH_PROJECT_ID=repo-a docker-compose up -d
```

## File Structure

```
tools/graph-server/
├── src/
│   ├── index.ts                 # MCP server + 19 tool definitions
│   ├── parsers/
│   │   └── typescript-parser.ts # AST extraction (functions, classes, imports)
│   ├── graph/
│   │   ├── builder.ts           # AST → Cypher graph construction
│   │   ├── client.ts            # Memgraph HTTP client
│   │   ├── orchestrator.ts      # Build orchestration (full + incremental)
│   │   └── index.ts             # In-memory index manager
│   ├── engines/
│   │   ├── architecture-engine.ts # Layer validation + violation detection
│   │   ├── test-engine.ts        # Test dependency analysis + selection
│   │   ├── progress-engine.ts    # Feature/task tracking
│   │   ├── embedding-engine.ts   # Vector search (MVP)
│   │   └── tool-handlers.ts      # Tool implementations
│   ├── cli/
│   │   ├── validate.ts           # Architecture validation CLI
│   │   └── test-affected.ts      # Test selection CLI
│   └── config.ts                # Configuration loading
├── README.md                    # This file
├── QUICK_REFERENCE.md           # Quick lookup guide
├── QUICK_START.md               # Minimal setup steps
├── ARCHITECTURE.md              # Technical deep-dive
└── package.json
```

## Development Workflow

### Interactive Development

```bash
# Terminal 1: Start services
cd tools/docker
docker-compose up -d

# Terminal 2: Build and run MCP server
cd tools/graph-server
npm run build
node dist/index.js

# Terminal 3: Use Claude
claude --interactive
# Now ask questions - they'll use the tools
```

### Add a New MCP Tool

1. **Define in `src/server.ts`**: Add tool with Zod schema
2. **Implement in `src/engines/tool-handlers.ts`**: Add execution logic
3. **Test with Claude**: `claude --message "Your test query"`

### Update Graph Schema

Edit `.code-graph/docker/init/schema.cypher` and rebuild:

```bash
docker-compose down -v
docker-compose up -d
npm run graph:build --force
```

## Performance Targets

| Operation               | Target  | Current |
| ----------------------- | ------- | ------- |
| Full build (696 files)  | <5 min  | ~4 min  |
| Incremental update      | <5 sec  | <1 sec  |
| Architecture validation | <10 sec | ~3 sec  |
| Test selection          | <2 sec  | <500ms  |
| CLI query response      | <3 sec  | <1 sec  |
| Graph node creation     | ~800    | 44,140  |
| Graph relationships     | ~5,000  | 45,308  |

## Troubleshooting

### "Connection refused" Error

```bash
# Ensure Docker is running
docker-compose ps

# Ensure MCP server is running
node dist/index.js
```

### No Results from Claude

```bash
# Verify graph has data
docker-compose exec memgraph memgraph-cli --exec "MATCH (n) RETURN count(n)"

# Rebuild if empty
npm run graph:build --verbose
```

### Architecture Violations Not Detected

```bash
# Run validation directly
npm run graph:validate

# See detailed violations
npm run graph:validate -- --verbose
```

### Test Selection Returns Nothing

```bash
# Ensure test suite is built
npm run graph:build

# Check test detection
docker-compose exec memgraph memgraph-cli --exec "MATCH (ts:TEST_SUITE) RETURN count(ts)"
```

## Next Steps

1. **Explore the Graph**: `claude --interactive` and ask questions
2. **Validate Architecture**: `npm run graph:validate` to see current violations
3. **Try Test Selection**: `npm run test:affected src/engine/calculations/columns.ts`
4. **Set Up Hook**: `npm run graph:install-hooks` for pre-commit checks
5. **Track Progress**: `claude --message "Show all active features"`

## Documentation

| Document                                                     | Purpose                                 |
| ------------------------------------------------------------ | --------------------------------------- |
| [QUICK_REFERENCE.md](QUICK_REFERENCE.md)                     | Quick lookup for all tools and examples |
| [QUICK_START.md](QUICK_START.md)                             | Minimal setup steps                     |
| [ARCHITECTURE.md](ARCHITECTURE.md)                           | Technical architecture deep-dive        |
| [.code-graph/config.json](../../.code-graph/config.json)     | Architecture rules and configuration    |
| [../docker/init/schema.cypher](../docker/init/schema.cypher) | Graph database schema                   |

## References

- **Memgraph**: https://memgraph.com/
- **Model Context Protocol**: https://modelcontextprotocol.io/
- **Claude CLI**: https://github.com/anthropics/claude-code
- **Reference Implementation**: https://github.com/vitali87/code-graph-rag
- **stratSolver**: See [../../CLAUDE.md](../../CLAUDE.md) for project architecture

## Support

For issues or questions:

1. Check [QUICK_REFERENCE.md](QUICK_REFERENCE.md) for common issues
2. Review `.code-graph/build.log.json` for build errors
3. Run `npm run graph:validate` to check architecture consistency
4. Open an issue in the repository

---

**Version**: 1.0.0 (7 Phases Complete)
**Last Updated**: February 18, 2026
**Status**: Production Ready ✅
