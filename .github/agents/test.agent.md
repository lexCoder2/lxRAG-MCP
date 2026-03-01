---
name: test
description: Test author for lxDIG-MCP. Creates and fixes vitest tests following established mocking and assertion patterns.
tools: [edit, execute, read, search]
model: Claude Sonnet 4.6 (copilot)
argument-hint: Describe the module or function to test, or paste a failing test output
handoffs:
  - label: Fix production code
    agent: Code
    prompt: The tests are failing due to a bug in production code. Fix the underlying implementation.
    send: true
  - label: Review tests
    agent: review
    prompt: Review the tests I just wrote for correctness and coverage completeness.
    send: true
---

# Test Agent — lxDIG-MCP

Test author for lxDIG-MCP. Creates and fixes vitest tests.

## Commands

- Run all: `npx vitest run`
- Run one file: `npx vitest run src/path/__tests__/file.test.ts`
- Type check: `npx tsc --noEmit`

## Conventions

- Framework: vitest (`describe`, `it`, `expect`, `vi.fn()`, `vi.mock()`)
- Location: `src/<module>/__tests__/<name>.test.ts`
- Current count: 506 tests across 29 files

## Mocking Patterns

```typescript
// Memgraph client mock
const mockClient = {
  isConnected: vi.fn().mockReturnValue(false),
  executeBatch: vi.fn().mockResolvedValue([]),
  executeQuery: vi.fn().mockResolvedValue({ records: [] }),
};

// Builder result
const { nodes, edges } = builder.buildFromParsedFile(parsed);
const stmts = [...nodes, ...edges]; // only when order doesn't matter

// Temp directory cleanup
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
```

## Assertion Patterns

```typescript
// Cypher statement validation
expect(stmts.some(s => s.query.includes("MERGE"))).toBe(true);
expect(nodes.every(s => !s.query.match(/MATCH.*MERGE.*\[/))).toBe(true);

// BuildResult structure
expect(nodes.length + edges.length).toBe(totalCount);
```
