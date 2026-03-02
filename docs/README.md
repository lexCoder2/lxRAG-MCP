# Documentation

## Where to Start

| Goal                                           | Document                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| Deploy the server                              | [QUICK_START.md](../QUICK_START.md)                  |
| See all 39 tools at a glance                   | [QUICK_REFERENCE.md](../QUICK_REFERENCE.md)          |
| Integrate into a project                       | [MCP_INTEGRATION_GUIDE.md](MCP_INTEGRATION_GUIDE.md) |
| Stop Claude falling back to grep in long chats | [CLAUDE_INTEGRATION.md](CLAUDE_INTEGRATION.md)       |
| Replace grep/file reads with MCP equivalents   | [TOOL_PATTERNS.md](TOOL_PATTERNS.md)                 |
| Understand architecture and internals          | [ARCHITECTURE.md](../ARCHITECTURE.md)                |

---

## Guides

### [MCP_INTEGRATION_GUIDE.md](MCP_INTEGRATION_GUIDE.md)

Complete project integration: server setup, VS Code and Claude Desktop config, per-project
`.github/copilot-instructions.md`, multi-project architecture.

### [CLAUDE_INTEGRATION.md](CLAUDE_INTEGRATION.md)

How to enforce MCP usage at the **system prompt level** so Claude never falls back to
grep or file reads — even in 100+ message conversations. Includes ready-to-paste config.

### [TOOL_PATTERNS.md](TOOL_PATTERNS.md)

Side-by-side before/after patterns: grep → `graph_query`, file reads → `code_explain`,
manual impact tracing → `impact_analyze`, test discovery → `test_select`, and more.

---

## Reference

### [TOOLS_INFORMATION_GUIDE.md](TOOLS_INFORMATION_GUIDE.md)

Full 39-tool inventory by category, tool-selection cheatsheet, runtime notes (session
scoping, rebuild async model, profile-driven output), and output contract reference.

### [PROJECT_FEATURES_CAPABILITIES.md](PROJECT_FEATURES_CAPABILITIES.md)

Feature overview by capability area: graph intelligence, semantic retrieval, testing and
change impact, architecture governance, agent coordination and memory.

---

## Development Standards

### [CODE_COMMENT_STANDARD.md](CODE_COMMENT_STANDARD.md)

TSDoc format for file headers, exported APIs, and internal helpers. Required for all core
modules; includes scope guidance and style rules.

---

## Templates

| File                                                                                     | Usage                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [templates/copilot-instructions-template.md](templates/copilot-instructions-template.md) | Copy to `.github/copilot-instructions.md` in any project |
| [templates/GRAPH_EXPERT_AGENT.md](templates/GRAPH_EXPERT_AGENT.md)                       | System prompt for an AI agent operating this repo        |
| [templates/skill-mcp-template.md](templates/skill-mcp-template.md)                       | Skill prompt template for tool-specific tasks            |
| [templates/toolsets-template.jsonc](templates/toolsets-template.jsonc)                   | VS Code toolset configuration                            |

---

## File Index

```
docs/
  README.md                          — This file (navigation hub)
  CLAUDE_INTEGRATION.md              — Enforce MCP via system prompt (fixes instruction drift)
  CODE_COMMENT_STANDARD.md           — TSDoc comment conventions
  MCP_INTEGRATION_GUIDE.md           — Full project setup and integration guide
  PROJECT_FEATURES_CAPABILITIES.md   — Feature and capability map
  TOOL_PATTERNS.md                   — Grep → MCP replacement patterns
  TOOLS_INFORMATION_GUIDE.md         — 39-tool inventory, cheatsheet, runtime notes
  templates/
    copilot-instructions-template.md — Copy to any project
    GRAPH_EXPERT_AGENT.md            — AI agent system prompt for this repo
    skill-mcp-template.md            — Skill prompt template
    toolsets-template.jsonc          — VS Code toolsets

Root:
  QUICK_START.md      — Server deployment (Docker + npm)
  QUICK_REFERENCE.md  — All 39 tools with params and examples
  ARCHITECTURE.md     — Technical deep dive (graph pipeline, parsers, engines)
  README.md           — Project overview and setup
  .github/copilot-instructions.md — Active Copilot instructions for this repo
```

---

## Performance Reference

| Task                | Manual | MCP    | Improvement   |
| ------------------- | ------ | ------ | ------------- |
| Find symbol         | 450 ms | 50 ms  | 9× faster     |
| Understand function | 5 min  | 200 ms | 1 500× faster |
| Impact analysis     | 10 min | 100 ms | 6 000× faster |
| Search by concept   | 2 min  | 150 ms | 800× faster   |
| False positive rate | High   | < 1%   | —             |

---

## Setup Summary

```bash
# One time
docker-compose up -d memgraph qdrant
npm run build && npm run start:http

# Per project
- Copy templates/copilot-instructions-template.md → .github/copilot-instructions.md
- Add .mcp-config.json
- Update ~/.claude_desktop_config.json
- Restart Claude
- Test
```

---

## Success = Zero Fallback

After implementation:
✅ Claude uses MCP **exclusively**
✅ Long conversations **never** degrade
✅ Zero file reads or grep
✅ Full dependency context always
✅ Heavy MCP dependency, zero fallback
