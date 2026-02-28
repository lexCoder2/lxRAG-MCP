#!/usr/bin/env node
/**
 * lxDIG MCP — Full Integration Test (v2, all parameters corrected)
 * Tests all 39 tools via stdio JSON-RPC against a fresh DB.
 */

import { spawn } from "child_process";

const WORKSPACE = "/home/alex_rod/projects/lexDIG-MCP";
const PROJECT_ID = "lxdig-mcp";
const ELEMENT_FUNC = "lxdig-mcp:build.ts:main:18";
const ELEMENT_FILE = "src/tools/handlers/test-tools.ts";

// ─── RPC plumbing ──────────────────────────────────────────────────────────
let idSeq = 1,
  proc;
const pending = new Map();
let lineBuffer = "";

const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = idSeq++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, 90000);
    pending.set(id, { resolve, reject, timer, method });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const callTool = (name, args) => rpc("tools/call", { name, arguments: args });

function handleMessage(msg) {
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject, timer } = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(timer);
    msg.error
      ? reject(
          Object.assign(new Error(msg.error.message || "RPC error"), {
            rpcError: msg.error,
          }),
        )
      : resolve(msg.result);
  }
}

// ─── Result helpers ────────────────────────────────────────────────────────
function parseResult(result) {
  if (!result?.content) return { ok: !!result, data: result, raw: result };
  const text = result.content.map((c) => c.text || "").join("");
  try {
    const p = JSON.parse(text);
    return {
      ok: p.ok !== false && !p.errorCode,
      data: p.data ?? p,
      raw: p,
      text,
    };
  } catch {
    return { ok: text.length > 0, data: null, text };
  }
}

let passed = 0,
  failed = 0,
  total = 0;
const allResults = [];

function log(name, result, { expectEmpty = false, note = "" } = {}) {
  total++;
  let ok, summary, detail;
  if (result instanceof Error) {
    ok = false;
    summary = result.message.slice(0, 120);
    detail = JSON.stringify(result.rpcError || {}, null, 2)
      .split("\n")
      .slice(0, 6)
      .join("\n");
  } else {
    const p = parseResult(result);
    ok = p.ok;
    summary = p.raw?.summary || "";
    detail = JSON.stringify(p.data || {}, null, 2)
      .split("\n")
      .slice(0, 10)
      .join("\n");
  }
  // Pre-index empty state: errors about "no data" are expected
  if (
    expectEmpty &&
    !ok &&
    /no indexed|no test|no symbols|empty|0 episode|not found/i.test(summary)
  )
    ok = true;
  const icon = ok ? "✅" : "❌";
  const emptyTag = expectEmpty ? " [empty-ok]" : "";
  const noteTag = note ? ` ← ${note}` : "";
  console.log(
    `\n${icon} [${String(total).padStart(2)}] ${name}${emptyTag}${noteTag}`,
  );
  if (summary) console.log(`      ${summary}`);
  if (detail && detail !== "{}")
    detail
      .split("\n")
      .slice(0, 7)
      .forEach((l) => console.log(`      ${l}`));
  allResults.push({ name, ok, summary });
  if (ok) passed++;
  else failed++;
}

async function t(name, args, flags = {}) {
  try {
    const r = await callTool(name, args);
    log(name, r, flags);
    return parseResult(r);
  } catch (e) {
    log(name, e, flags);
    return { ok: false, data: null };
  }
}

// ─── Test runner ───────────────────────────────────────────────────────────
async function run() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("  lxDIG MCP — Full Integration Test (39 tools, stdio)");
  console.log("  Memgraph ✓ empty   Qdrant ✓ empty");
  console.log("════════════════════════════════════════════════════════════\n");

  console.log("── INIT: MCP handshake ──");
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "2" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  console.log("   ✅ Handshake OK\n");

  // ── P1: List & health ──────────────────────────────────────────────────
  console.log("── PHASE 1: List & health ───────────────────");
  await t("tools_list", {});
  await t("graph_health", { profile: "balanced" });

  // ── P2: Set workspace ─────────────────────────────────────────────────
  console.log("\n── PHASE 2: Set workspace ───────────────────");
  await t("graph_set_workspace", {
    projectId: PROJECT_ID,
    workspaceRoot: WORKSPACE,
  });

  // ── P3: Pre-index empty checks ────────────────────────────────────────
  console.log("\n── PHASE 3: Empty-state checks ──────────────");
  await t(
    "search_docs",
    { query: "architecture layers", limit: 3 },
    { expectEmpty: true },
  );
  await t(
    "semantic_search",
    { query: "HandlerBridge", projectId: PROJECT_ID, limit: 3 },
    { expectEmpty: true },
  );
  await t("feature_status", { featureId: "list" }, { expectEmpty: true });
  await t(
    "episode_recall",
    { query: "graph build", limit: 3 },
    { expectEmpty: true },
  );
  await t(
    "decision_query",
    { query: "architecture design decisions", limit: 3 },
    { expectEmpty: true },
  );
  await t("reflect", { limit: 5, profile: "compact" }, { expectEmpty: true });
  await t(
    "coordination_overview",
    { projectId: PROJECT_ID },
    { expectEmpty: true },
  );
  await t("agent_status", { agentId: "test-agent-01" }, { expectEmpty: true });

  // ── P4: Setup helpers ─────────────────────────────────────────────────
  console.log("\n── PHASE 4: Setup helpers ───────────────────");
  await t("setup_copilot_instructions", {
    targetPath: WORKSPACE,
    projectName: "lxDIG-MCP",
    overwrite: true,
  });
  await t("contract_validate", {
    tool: "graph_rebuild",
    arguments: { projectId: PROJECT_ID, mode: "full" },
  });

  // ── P5: Graph rebuild ─────────────────────────────────────────────────
  console.log("\n── PHASE 5: Graph rebuild (full index) ──────");
  const rebuildRes = await t("graph_rebuild", {
    projectId: PROJECT_ID,
    mode: "full",
    workspaceRoot: WORKSPACE,
  });
  const txId = rebuildRes?.raw?.data?.txId || rebuildRes?.data?.txId || null;
  console.log(`      txId: ${txId || "(not captured)"}`);

  await new Promise((r) => setTimeout(r, 4000));
  await t(
    "graph_health",
    { profile: "balanced" },
    { note: "should show nodes > 0" },
  );

  // ── P6: Graph queries ─────────────────────────────────────────────────
  console.log("\n── PHASE 6: Graph queries ───────────────────");
  await t("graph_query", {
    query:
      "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS cnt ORDER BY cnt DESC LIMIT 8",
    projectId: PROJECT_ID,
  });
  await t("graph_query", {
    query:
      "MATCH (f:FILE) RETURN f.relativePath ORDER BY f.relativePath LIMIT 5",
    projectId: PROJECT_ID,
  });
  // diff_since: use txId from rebuild (it shows changes since that tx = the rebuild itself)
  await t(
    "diff_since",
    {
      since: txId || new Date(Date.now() - 120000).toISOString(),
      projectId: PROJECT_ID,
      profile: "compact",
    },
    { note: `since txId or -2m` },
  );

  // ── P7: Semantic & code intelligence ─────────────────────────────────
  console.log("\n── PHASE 7: Semantic & code intelligence ────");
  await t("semantic_search", {
    query: "HandlerBridge formatSuccess errorEnvelope",
    projectId: PROJECT_ID,
    limit: 5,
  });
  await t("find_pattern", {
    pattern: "tool handler impl registry",
    projectId: PROJECT_ID,
    limit: 5,
  });
  await t("find_similar_code", {
    elementId: ELEMENT_FUNC,
    projectId: PROJECT_ID,
    limit: 5,
  });
  await t("code_explain", {
    element: "HandlerBridge",
    depth: 2,
    projectId: PROJECT_ID,
  });
  await t("semantic_diff", {
    elementId1: "lxdig-mcp:build.ts:main:18",
    elementId2: "lxdig-mcp:query.ts:main:14",
    projectId: PROJECT_ID,
  });
  await t("semantic_slice", {
    symbol: "HandlerBridge",
    context: "body",
    projectId: PROJECT_ID,
  });

  // ── P8: Code clustering ───────────────────────────────────────────────
  console.log("\n── PHASE 8: Code clustering ─────────────────");
  await t("code_clusters", { type: "file", count: 5, projectId: PROJECT_ID });

  // ── P9: Architecture ──────────────────────────────────────────────────
  console.log("\n── PHASE 9: Architecture ────────────────────");
  await t("arch_validate", {
    projectId: PROJECT_ID,
    files: ["src/tools/handlers/test-tools.ts", "src/engines/test-engine.ts"],
  });
  await t("arch_suggest", {
    name: "MultiTenantEngine",
    codeType: "engine",
    dependencies: ["types", "utils"],
    projectId: PROJECT_ID,
  });
  await t("blocking_issues", { projectId: PROJECT_ID });

  // ── P10: Docs index & search ──────────────────────────────────────────
  console.log("\n── PHASE 10: Docs index → search ────────────");
  const docsRes = await t("index_docs", {
    projectId: PROJECT_ID,
    paths: [
      `${WORKSPACE}/README.md`,
      `${WORKSPACE}/ARCHITECTURE.md`,
      `${WORKSPACE}/QUICK_START.md`,
      `${WORKSPACE}/docs/TOOL_PATTERNS.md`,
      `${WORKSPACE}/docs/PROJECT_FEATURES_CAPABILITIES.md`,
    ],
  });
  await t(
    "search_docs",
    {
      query: "architecture layers MCP tools graph",
      limit: 5,
      projectId: PROJECT_ID,
    },
    { note: "should return results" },
  );
  await t(
    "search_docs",
    { symbol: "HandlerBridge", limit: 3, projectId: PROJECT_ID },
    { note: "symbol lookup" },
  );

  // ── P11: Ref query ────────────────────────────────────────────────────
  console.log("\n── PHASE 11: Ref query ──────────────────────");
  await t("ref_query", {
    query: "tool handler pattern HandlerBridge",
    repoPath: WORKSPACE,
    limit: 5,
  });

  // ── P12: Impact ───────────────────────────────────────────────────────
  console.log("\n── PHASE 12: Impact analysis ────────────────");
  await t("impact_analyze", {
    changedFiles: ["src/tools/handlers/test-tools.ts", "src/config.ts"],
    projectId: PROJECT_ID,
  });

  // ── P13: Test intelligence ────────────────────────────────────────────
  console.log("\n── PHASE 13: Test intelligence ──────────────");
  await t("test_categorize", { projectId: PROJECT_ID });
  await t("test_select", {
    changedFiles: ["src/engines/test-engine.ts", "src/config.ts"],
    projectId: PROJECT_ID,
  });
  await t("suggest_tests", {
    elementId: ELEMENT_FUNC,
    limit: 5,
    profile: "compact",
  });
  await t(
    "test_run",
    { testFiles: ["src/utils/__tests__/validation.test.ts"], parallel: false },
    { note: "real vitest run" },
  );

  // ── P14: Progress & features ──────────────────────────────────────────
  console.log("\n── PHASE 14: Progress & features ────────────");
  await t("feature_status", { featureId: "list" });
  await t("feature_status", { featureId: "phase-1" });
  await t("progress_query", {
    query: "completed features high priority",
    projectId: PROJECT_ID,
  });
  await t(
    "task_update",
    {
      taskId: "lang-agnostic-fix",
      status: "completed",
      note: "Language-agnostic runner done",
      projectId: PROJECT_ID,
    },
    { note: "task may not exist" },
  );

  // ── P15: Episode memory ───────────────────────────────────────────────
  console.log("\n── PHASE 15: Episode memory ─────────────────");
  await t("episode_add", {
    type: "DECISION",
    content:
      "Adopted language-agnostic test runner: config.testing.testRunner drives pytest/rspec/go-test/vitest dispatch",
    entities: ["ArchitectureEngine", "HandlerBridge", "TestEngine"],
    outcome: "success",
    metadata: {
      rationale:
        "Consistent runner dispatch reduces CI friction across Python/Ruby/Go/TS projects",
      component: "test-engine",
    },
  });
  await t("episode_add", {
    type: "LEARNING",
    content:
      "Test categorization patterns differ by language: .integration.test.* (JS), _integration_test.py (Python), _integration_test.go (Go), _integration_spec.rb (Ruby)",
    entities: ["categorizeTest", "getMirrorTestPath"],
    outcome: "success",
    metadata: { languages: ["TypeScript", "Python", "Ruby", "Go"] },
  });
  await t(
    "episode_recall",
    { query: "language agnostic test runner", limit: 5 },
    { note: "should find 2 episodes" },
  );
  await t("decision_query", {
    query: "language agnostic architecture",
    limit: 5,
  });
  await t(
    "reflect",
    { limit: 10, profile: "balanced" },
    { note: "should surface learnings" },
  );

  // ── P16: Coordination ────────────────────────────────────────────────
  console.log("\n── PHASE 16: Coordination ───────────────────");
  const claimRes = await t("agent_claim", {
    agentId: "test-agent-01",
    targetId: ELEMENT_FILE,
    intent: "Validating full tool coverage for lxDIG integration test",
    taskId: "tool-integration-test",
    sessionId: "test-session-001",
  });
  const claimId =
    claimRes?.data?.claimId || claimRes?.raw?.data?.claimId || null;
  console.log(`      claimId: ${claimId || "(not captured)"}`);

  await t(
    "agent_status",
    { agentId: "test-agent-01" },
    { note: "should show 1 active claim" },
  );
  await t("coordination_overview", { projectId: PROJECT_ID });
  await t("context_pack", {
    task: "Implement multi-tenant support for lxDIG: API key auth + per-user project scoping",
    taskId: "multi-tenant-impl",
    agentId: "test-agent-01",
    includeLearnings: true,
  });
  await t(
    "agent_release",
    {
      claimId: claimId || `test-agent-01:tool-integration-test`,
      outcome: "Integration test completed — all tools exercised",
    },
    { note: claimId ? "using real claimId" : "using guessed claimId" },
  );

  // ── P17: One-shot init ────────────────────────────────────────────────
  console.log("\n── PHASE 17: init_project_setup (one-shot) ──");
  await t("init_project_setup", {
    projectId: PROJECT_ID,
    workspaceRoot: WORKSPACE,
  });

  // ── Summary ───────────────────────────────────────────────────────────
  const pct = ((passed / total) * 100).toFixed(0);
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(
    `  RESULTS: ${passed}/${total} passed (${pct}%),  ${failed} failed`,
  );
  console.log("════════════════════════════════════════════════════════════");
  if (failed > 0) {
    console.log("\nFailed tools:");
    allResults
      .filter((r) => !r.ok)
      .forEach((r) =>
        console.log(`  ❌ ${r.name}: ${r.summary.slice(0, 100)}`),
      );
  } else {
    console.log("\n  🎉 All tools exercised successfully!");
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────
proc = spawn("node", ["dist/server.js"], {
  cwd: WORKSPACE,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MCP_TRANSPORT: "stdio" },
});

proc.stdout.on("data", (chunk) => {
  lineBuffer += chunk.toString();
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop();
  for (const line of lines) {
    const t = line.trim();
    if (t)
      try {
        handleMessage(JSON.parse(t));
      } catch {}
  }
});
proc.stderr.on("data", (d) => {
  if (process.env.DEBUG) process.stderr.write("[server] " + d);
});
proc.on("exit", (code) => {
  if (code && code !== 0) console.error(`\nServer exited: ${code}`);
});

run()
  .catch((e) => {
    console.error("\nFatal:", e.message);
    process.exit(1);
  })
  .finally(() => {
    proc.stdin.end();
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
  });
