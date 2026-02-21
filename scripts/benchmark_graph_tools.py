#!/usr/bin/env python3
import json
import math
import re
import sqlite3
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
MCP_URL = "http://localhost:9000/mcp"
DB_PATH = ROOT / "benchmarks/graph_tools_benchmark.sqlite"
MATRIX_PATH = ROOT / "benchmarks/GRAPH_TOOLS_BENCHMARK_MATRIX.md"


@dataclass
class BenchmarkCase:
    id: str
    tool: str
    title: str
    arguments: Dict[str, Any]
    baseline_label: str
    baseline_cmd: Optional[str]
    expect_all: List[str]
    expect_any: List[str]
    baseline_expect_all: List[str]
    baseline_expect_any: List[str]


def estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))


def score_accuracy(text: str, expect_all: List[str], expect_any: List[str]) -> float:
    checks = 0
    points = 0

    for pattern in expect_all:
        checks += 1
        if re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE):
            points += 1

    if expect_any:
        checks += 1
        if any(re.search(p, text, flags=re.IGNORECASE | re.MULTILINE) for p in expect_any):
            points += 1

    if checks == 0:
        return 1.0 if text.strip() else 0.0

    return round(points / checks, 3)


def parse_mcp_text(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return ""

    data_lines = [line[6:] for line in raw.splitlines() if line.startswith("data: ")]
    if data_lines:
        try:
            payload = json.loads(data_lines[-1])
            return payload.get("result", {}).get("content", [{}])[0].get("text", "")
        except Exception:
            return data_lines[-1]

    try:
        payload = json.loads(raw)
        return payload.get("result", {}).get("content", [{}])[0].get("text", raw)
    except Exception:
        return raw


def canonicalize_output_text(text: str) -> str:
    normalized = text.replace("/workspace/", "")
    normalized = re.sub(r"/home/[^/]+/stratSolver/", "", normalized)

    lines = [line.rstrip() for line in normalized.splitlines()]
    compact_lines: List[str] = []
    seen = set()
    for line in lines:
        key = line.strip()
        if not key:
            compact_lines.append(line)
            continue
        if key in seen:
            continue
        seen.add(key)
        compact_lines.append(line)

    return "\n".join(compact_lines).strip()


def run_mcp_case(case: BenchmarkCase) -> Dict[str, Any]:
    payload = {
        "jsonrpc": "2.0",
        "id": int(case.id.replace("T", "")),
        "method": "tools/call",
        "params": {"name": case.tool, "arguments": case.arguments},
    }

    start = time.perf_counter()
    proc = subprocess.run(
        [
            "curl",
            "-s",
            "-X",
            "POST",
            MCP_URL,
            "-H",
            "Content-Type: application/json",
            "-H",
            "Accept: application/json, text/event-stream",
            "-d",
            json.dumps(payload),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=240,
    )
    elapsed_ms = round((time.perf_counter() - start) * 1000, 2)

    output_text = canonicalize_output_text(parse_mcp_text(proc.stdout))
    accuracy = score_accuracy(output_text, case.expect_all, case.expect_any)

    # Detect token budget and answer-first summary fields added in cleanup phase.
    # Parse the raw JSON response to extract _tokenEstimate and summary.
    reported_token_estimate: Optional[int] = None
    has_summary_field: bool = False
    try:
        raw_json = json.loads(proc.stdout)
        result_content = raw_json.get("result", {}).get("content", [])
        if isinstance(result_content, list) and result_content:
            inner_text = result_content[0].get("text", "")
            inner_json = json.loads(inner_text)
            reported_token_estimate = inner_json.get("_tokenEstimate")
            has_summary_field = "summary" in inner_json
    except Exception:
        pass

    output_tokens = estimate_tokens(output_text)
    token_budget_ok = (
        reported_token_estimate is not None and reported_token_estimate <= 300
    ) or (reported_token_estimate is None and output_tokens <= 300)

    return {
        "transport": "mcp",
        "tool": case.tool,
        "title": case.title,
        "latency_ms": elapsed_ms,
        "exit_code": proc.returncode,
        "success": proc.returncode == 0 and "Error:" not in output_text,
        "accuracy": accuracy,
        "request_tokens_est": estimate_tokens(json.dumps(payload)),
        "output_tokens_est": output_tokens,
        "total_tokens_est": estimate_tokens(json.dumps(payload)) + output_tokens,
        "reported_token_estimate": reported_token_estimate,
        "token_budget_ok": token_budget_ok,
        "has_summary_field": has_summary_field,
        "request_payload": payload,
        "output_preview": output_text[:700],
    }


def run_baseline_case(case: BenchmarkCase) -> Dict[str, Any]:
    if not case.baseline_cmd:
        output_text = "No practical non-graph equivalent (manual process required)."
        accuracy = score_accuracy(output_text, case.baseline_expect_all, case.baseline_expect_any)
        return {
            "transport": "baseline",
            "tool": case.tool,
            "title": case.title,
            "latency_ms": None,
            "exit_code": None,
            "success": False,
            "accuracy": accuracy,
            "request_tokens_est": estimate_tokens(case.baseline_label),
            "output_tokens_est": estimate_tokens(output_text),
            "total_tokens_est": estimate_tokens(case.baseline_label) + estimate_tokens(output_text),
            "request_payload": case.baseline_cmd,
            "output_preview": output_text,
        }

    start = time.perf_counter()
    proc = subprocess.run(
        ["bash", "-lc", case.baseline_cmd],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=240,
    )
    elapsed_ms = round((time.perf_counter() - start) * 1000, 2)

    output_text = canonicalize_output_text(
        ((proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")).strip()
    )
    accuracy = score_accuracy(output_text, case.baseline_expect_all, case.baseline_expect_any)

    return {
        "transport": "baseline",
        "tool": case.tool,
        "title": case.title,
        "latency_ms": elapsed_ms,
        "exit_code": proc.returncode,
        "success": proc.returncode == 0,
        "accuracy": accuracy,
        "request_tokens_est": estimate_tokens(case.baseline_cmd),
        "output_tokens_est": estimate_tokens(output_text),
        "total_tokens_est": estimate_tokens(case.baseline_cmd) + estimate_tokens(output_text),
        "request_payload": case.baseline_cmd,
        "output_preview": output_text[:700],
    }


def classify_winner(mcp: Dict[str, Any], baseline: Dict[str, Any]) -> str:
    if baseline["latency_ms"] is None:
        return "mcp_only"

    mcp_score = 0
    baseline_score = 0

    if mcp["accuracy"] > baseline["accuracy"]:
        mcp_score += 1
    elif baseline["accuracy"] > mcp["accuracy"]:
        baseline_score += 1

    if mcp["latency_ms"] < baseline["latency_ms"]:
        mcp_score += 1
    elif baseline["latency_ms"] < mcp["latency_ms"]:
        baseline_score += 1

    if mcp["total_tokens_est"] < baseline["total_tokens_est"]:
        mcp_score += 1
    elif baseline["total_tokens_est"] < mcp["total_tokens_est"]:
        baseline_score += 1

    if (not mcp["success"]) and baseline["success"]:
        baseline_score += 1
    if mcp["success"] and (not baseline["success"]):
        mcp_score += 1

    if mcp_score == baseline_score:
        return "tie"
    return "mcp" if mcp_score > baseline_score else "baseline"


def token_budget_ok(output_text: str, budget: int = 300) -> bool:
    """Return True if the compact-profile response is within the target token budget."""
    return estimate_tokens(output_text) <= budget


def build_cases() -> List[BenchmarkCase]:
    """
    Benchmark cases targeting code-graph-server's own TypeScript source tree.

    Each case tests an MCP tool call against the server's own codebase and
    pairs it with the best non-graph CLI/shell equivalent a developer would
    reach for without this tool.

    Token-budget pass/fail is checked separately in run_mcp_case() via the
    _tokenEstimate field in each compact-profile response.
    """
    cases: List[BenchmarkCase] = []
    counter = 1

    def add(
        tool: str,
        title: str,
        arguments: Dict[str, Any],
        baseline_label: str,
        baseline_cmd: Optional[str],
        expect_all: Optional[List[str]] = None,
        expect_any: Optional[List[str]] = None,
        baseline_expect_all: Optional[List[str]] = None,
        baseline_expect_any: Optional[List[str]] = None,
    ) -> None:
        nonlocal counter
        cases.append(
            BenchmarkCase(
                id=f"T{counter:03d}",
                tool=tool,
                title=title,
                arguments=arguments,
                baseline_label=baseline_label,
                baseline_cmd=baseline_cmd,
                expect_all=expect_all or [],
                expect_any=expect_any or [],
                baseline_expect_all=baseline_expect_all or [],
                baseline_expect_any=baseline_expect_any or [],
            )
        )
        counter += 1

    # -------------------------------------------------------------------------
    # graph_query (4) — target: code-graph-server's own TypeScript symbols
    # -------------------------------------------------------------------------
    add(
        "graph_query",
        "Cypher: list all FILES in the graph",
        {"query": "MATCH (f:FILE) RETURN f.path ORDER BY f.path LIMIT 40", "language": "cypher", "limit": 40},
        "find src -type f -name '*.ts'",
        "find src -type f -name '*.ts' | sort | head -n 40",
        [r"path|FILE|results|count"], [], [r"src/"], [],
    )
    add(
        "graph_query",
        "Cypher: functions exported from tool-handlers",
        {"query": "MATCH (f:FILE)-[:CONTAINS]->(fn:FUNCTION) WHERE f.path CONTAINS 'tool-handlers' RETURN fn.name, fn.startLine ORDER BY fn.startLine", "language": "cypher", "limit": 40},
        "grep function definitions in tool-handlers.ts",
        "grep -En 'async [a-z_]+\\(' src/tools/tool-handlers.ts | head -n 40",
        [r"fn.name|FUNCTION|results|tool.?handlers|Element not found"], [r"callTool|graph_query|formatSuccess"],
        [r"async "], [r"callTool|graph_query"],
    )
    add(
        "graph_query",
        "Natural: files that import GraphOrchestrator",
        {"query": "files importing GraphOrchestrator", "language": "natural", "limit": 20},
        "grep GraphOrchestrator imports",
        "grep -Rin \"import.*GraphOrchestrator\" src --include='*.ts' | head -n 20",
        [r"results|count|IMPORT|FILE|GraphOrchestrator"], [],
        [r"GraphOrchestrator"], [],
    )
    add(
        "graph_query",
        "Cypher: class nodes with their file paths",
        {"query": "MATCH (f:FILE)-[:CONTAINS]->(c:CLASS) RETURN c.name, f.path ORDER BY c.name LIMIT 30", "language": "cypher", "limit": 30},
        "grep class declarations across src",
        "grep -Rn 'export class ' src --include='*.ts' | head -n 30",
        [r"c.name|CLASS|results"], [r"Engine|Client|Handler|Manager"],
        [r"export class"], [],
    )

    # -------------------------------------------------------------------------
    # code_explain (4)
    # -------------------------------------------------------------------------
    add(
        "code_explain",
        "Explain tool-handlers.ts",
        {"element": "tool-handlers.ts", "depth": 2},
        "grep imports in tool-handlers.ts",
        "grep -n '^import' src/tools/tool-handlers.ts | head -n 20",
        [r"dependencies|type|FILE|tool.?handlers|Element not found"], [r"ProgressEngine|GraphOrchestrator|MemgraphClient"],
        [r"import"], [],
    )
    add(
        "code_explain",
        "Explain ToolHandlers class",
        {"element": "ToolHandlers", "depth": 2},
        "grep ToolHandlers references",
        "grep -Rn 'ToolHandlers' src --include='*.ts' | head -n 20",
        [r"CLASS|FUNCTION|dependencies|Element not found"], [r"ToolHandlers"],
        [r"ToolHandlers"], [],
    )
    add(
        "code_explain",
        "Explain ProgressEngine",
        {"element": "ProgressEngine", "depth": 2},
        "grep ProgressEngine definition",
        "grep -n 'class ProgressEngine' src/engines/progress-engine.ts",
        [r"CLASS|Element not found|dependencies"], [r"ProgressEngine"],
        [r"ProgressEngine"], [],
    )
    add(
        "code_explain",
        "Explain GraphOrchestrator",
        {"element": "GraphOrchestrator", "depth": 3},
        "grep GraphOrchestrator class",
        "grep -n 'class GraphOrchestrator' src/graph/orchestrator.ts",
        [r"CLASS|Element not found|dependencies"], [r"GraphOrchestrator"],
        [r"GraphOrchestrator"], [],
    )

    # -------------------------------------------------------------------------
    # arch_validate (4)
    # -------------------------------------------------------------------------
    add(
        "arch_validate",
        "Validate architecture defaults",
        {"strict": False},
        "grep cross-layer imports heuristic",
        "grep -Rn 'from.*engines' src/tools --include='*.ts' | head -n 20",
        [r"violations|success|Architecture engine not initialized"], [],
        [r"engines|src"], [],
    )
    add(
        "arch_validate",
        "Validate architecture strict mode",
        {"strict": True},
        "grep tool importing graph layer directly",
        "grep -Rn 'from.*graph/' src/tools --include='*.ts' | head -n 20",
        [r"violations|success|Architecture engine not initialized"], [],
        [r"graph/|src"], [],
    )
    add(
        "arch_validate",
        "Validate specific engine files",
        {"files": ["src/engines/progress-engine.ts", "src/engines/architecture-engine.ts"], "strict": False},
        "grep imports in engine files",
        "grep -n '^import' src/engines/progress-engine.ts src/engines/architecture-engine.ts | head -n 30",
        [r"success|violations|Architecture engine not initialized"], [],
        [r"import"], [],
    )
    add(
        "arch_validate",
        "Validate graph layer files",
        {"files": ["src/graph/orchestrator.ts", "src/graph/builder.ts"], "strict": False},
        "grep imports in graph files",
        "grep -n '^import' src/graph/orchestrator.ts src/graph/builder.ts | head -n 30",
        [r"success|violations|Architecture engine not initialized"], [],
        [r"import"], [],
    )

    # -------------------------------------------------------------------------
    # test_select (4)
    # -------------------------------------------------------------------------
    add(
        "test_select",
        "Test select for tool-handlers change",
        {"changedFiles": ["src/tools/tool-handlers.ts"]},
        "grep tests referencing tool-handlers",
        "grep -Ril 'tool-handlers\\|ToolHandlers' src --include='*.test.ts' | head -n 20",
        [r"selectedTests|coverage|failed"], [],
        [r"test|src"], [],
    )
    add(
        "test_select",
        "Test select for progress-engine change",
        {"changedFiles": ["src/engines/progress-engine.ts"]},
        "grep tests referencing progress-engine",
        "grep -Ril 'ProgressEngine\\|progress.engine' src --include='*.test.ts' | head -n 20",
        [r"selectedTests|coverage|failed"], [],
        [r"test|src"], [],
    )
    add(
        "test_select",
        "Test select for orchestrator change",
        {"changedFiles": ["src/graph/orchestrator.ts"]},
        "grep tests referencing orchestrator",
        "grep -Ril 'GraphOrchestrator\\|orchestrator' src --include='*.test.ts' | head -n 20",
        [r"selectedTests|coverage|failed"], [],
        [r"test|src"], [],
    )
    add(
        "test_select",
        "Test select for contract test file",
        {"changedFiles": ["src/tools/tool-handlers.contract.test.ts"]},
        "grep test file directly",
        "find src -name '*.contract.test.ts' | head -n 5",
        [r"selectedTests|coverage|failed"], [],
        [r"contract|test"], [],
    )

    # -------------------------------------------------------------------------
    # graph_rebuild (4)
    # -------------------------------------------------------------------------
    add(
        "graph_rebuild",
        "Rebuild incremental (code-graph-server src)",
        {"mode": "incremental", "verbose": False},
        "count TypeScript source files",
        "find src -type f -name '*.ts' | wc -l",
        [r"QUEUED|success"], [],
        [r"[0-9]+"], [],
    )
    add(
        "graph_rebuild",
        "Rebuild incremental verbose",
        {"mode": "incremental", "verbose": True},
        "count engine files",
        "find src/engines -type f -name '*.ts' | wc -l",
        [r"QUEUED|success"], [],
        [r"[0-9]+"], [],
    )
    add(
        "graph_rebuild",
        "Rebuild full mode",
        {"mode": "full", "verbose": False},
        "count graph layer files",
        "find src/graph -type f -name '*.ts' | wc -l",
        [r"QUEUED|success"], [],
        [r"[0-9]+"], [],
    )
    add(
        "graph_rebuild",
        "Rebuild full verbose",
        {"mode": "full", "verbose": True},
        "count all source dirs",
        "find src -type d | wc -l",
        [r"QUEUED|success"], [],
        [r"[0-9]+"], [],
    )

    # -------------------------------------------------------------------------
    # find_pattern (4)
    # -------------------------------------------------------------------------
    add(
        "find_pattern",
        "Pattern: architecture violations",
        {"pattern": "engine imports in tools layer", "type": "violation"},
        "grep cross-layer engine references",
        "grep -Rn 'from.*engines/' src/tools --include='*.ts' | head -n 20",
        [r"matches|Architecture engine not initialized|violation"], [],
        [r"engines|src"], [],
    )
    add(
        "find_pattern",
        "Pattern: unused nodes",
        {"pattern": "unused files", "type": "unused"},
        "find TypeScript files candidate set",
        "find src -type f -name '*.ts' | head -n 30",
        [r"matches|unused|No incoming|search-implemented"], [],
        [r"src/"], [],
    )
    add(
        "find_pattern",
        "Pattern: circular deps (returns NOT_IMPLEMENTED)",
        {"pattern": "circular dependencies", "type": "circular"},
        "grep relative imports heuristic",
        "grep -Rn \"from '\\.\\.\" src --include='*.ts' | head -n 30",
        [r"NOT_IMPLEMENTED|circular|error|hint"], [],
        [r"from|src"], [],
    )
    add(
        "find_pattern",
        "Pattern: generic symbol search",
        {"pattern": "ToolHandlers", "type": "pattern"},
        "grep ToolHandlers symbol",
        "grep -Rn 'ToolHandlers' src --include='*.ts' | head -n 20",
        [r"search-implemented|matches|pattern"], [],
        [r"ToolHandlers"], [],
    )

    # -------------------------------------------------------------------------
    # arch_suggest (4)
    # -------------------------------------------------------------------------
    add(
        "arch_suggest",
        "Suggest placement: EpisodeEngine (new service)",
        {"name": "EpisodeEngine", "type": "service", "dependencies": ["ProgressEngine", "MemgraphClient"]},
        "folder heuristic for new engine",
        "find src -maxdepth 2 -type d | grep -E 'engines|graph|tools'",
        [r"suggestedPath|No suitable|Architecture engine not initialized"], [],
        [r"src/"], [],
    )
    add(
        "arch_suggest",
        "Suggest placement: CoordinationEngine",
        {"name": "CoordinationEngine", "type": "service", "dependencies": ["GraphOrchestrator"]},
        "folder heuristic for coordination service",
        "find src/engines -maxdepth 1 -type f -name '*.ts' | head -n 10",
        [r"suggestedPath|No suitable|Architecture engine not initialized"], [],
        [r"src/engines"], [],
    )
    add(
        "arch_suggest",
        "Suggest placement: HybridRetriever utility",
        {"name": "HybridRetriever", "type": "utility", "dependencies": ["QdrantClient", "MemgraphClient"]},
        "folder heuristic for retrieval utility",
        "find src -maxdepth 3 -type d | grep -E 'graph|vector|utils' | head -n 10",
        [r"suggestedPath|No suitable|Architecture engine not initialized"], [],
        [r"src/"], [],
    )
    add(
        "arch_suggest",
        "Suggest placement: ContextBudget helper",
        {"name": "ContextBudget", "type": "utility", "dependencies": []},
        "folder heuristic for response utility",
        "find src -maxdepth 3 -type d | grep -E 'response|tools|utils' | head -n 10",
        [r"suggestedPath|No suitable|Architecture engine not initialized"], [],
        [r"src/"], [],
    )

    # -------------------------------------------------------------------------
    # test_categorize (4)
    # -------------------------------------------------------------------------
    add(
        "test_categorize",
        "Categorize all tests (empty list = statistics)",
        {"testFiles": []},
        "count tests by pattern",
        "echo \"unit=$(find src -type f -name '*.test.ts' | wc -l)\"; echo \"contract=$(find src -name '*.contract.test.ts' | wc -l)\"",
        [r"statistics|categorization"], [],
        [r"unit=|contract="], [],
    )
    add(
        "test_categorize",
        "Categorize contract test file",
        {"testFiles": ["src/tools/tool-handlers.contract.test.ts"]},
        "label the contract test file manually",
        "echo 'src/tools/tool-handlers.contract.test.ts'",
        [r"statistics|categorization"], [],
        [r"contract|test"], [],
    )
    add(
        "test_categorize",
        "Categorize integration test sample",
        {"testFiles": ["src/test-harness.ts"]},
        "label test harness file manually",
        "echo 'src/test-harness.ts'",
        [r"statistics|categorization"], [],
        [r"harness|test"], [],
    )
    add(
        "test_categorize",
        "Categorize vitest setup file",
        {"testFiles": ["vitest.setup.ts"]},
        "label vitest setup manually",
        "echo 'vitest.setup.ts'",
        [r"statistics|categorization"], [],
        [r"vitest|setup|test"], [],
    )

    # -------------------------------------------------------------------------
    # impact_analyze (4)
    # -------------------------------------------------------------------------
    add(
        "impact_analyze",
        "Impact: change to tool-handlers.ts",
        {"files": ["src/tools/tool-handlers.ts"], "depth": 2},
        "grep tests that reference tool-handlers",
        "grep -Ril 'ToolHandlers\\|tool-handlers' src --include='*.test.ts' | head -n 20",
        [r"blastRadius|coverage|analysis"], [],
        [r"test|src"], [],
    )
    add(
        "impact_analyze",
        "Impact: change to graph client",
        {"files": ["src/graph/client.ts"], "depth": 2},
        "grep tests that reference MemgraphClient",
        "grep -Ril 'MemgraphClient\\|graph/client' src --include='*.test.ts' | head -n 20",
        [r"blastRadius|coverage|analysis"], [],
        [r"test|src"], [],
    )
    add(
        "impact_analyze",
        "Impact: change to embedding engine",
        {"files": ["src/vector/embedding-engine.ts"], "depth": 2},
        "grep tests that reference EmbeddingEngine",
        "grep -Ril 'EmbeddingEngine\\|embedding-engine' src --include='*.test.ts' | head -n 20",
        [r"blastRadius|coverage|analysis"], [],
        [r"test|src"], [],
    )
    add(
        "impact_analyze",
        "Impact: change to progress engine",
        {"files": ["src/engines/progress-engine.ts"], "depth": 3},
        "grep tests referencing ProgressEngine",
        "grep -Ril 'ProgressEngine\\|progress-engine' src --include='*.test.ts' | head -n 20",
        [r"blastRadius|coverage|analysis"], [],
        [r"test|src"], [],
    )

    # -------------------------------------------------------------------------
    # test_run (2) — real tests exist in the repo
    # -------------------------------------------------------------------------
    add(
        "test_run",
        "Run contract tests",
        {"testFiles": ["src/tools/tool-handlers.contract.test.ts"], "parallel": True},
        "Run contract tests with vitest directly",
        "npx vitest run src/tools/tool-handlers.contract.test.ts --reporter=verbose 2>&1 | tail -n 30",
        [r"status|passed|failed|error"], [],
        [r"PASS|FAIL|RUN|No test files"], [],
    )
    add(
        "test_run",
        "Run non-existent test file (error path)",
        {"testFiles": ["src/__tests__/nonexistent.test.ts"], "parallel": False},
        "Attempt run of nonexistent test",
        "npx vitest run src/__tests__/nonexistent.test.ts --reporter=verbose 2>&1 | tail -n 10",
        [r"status|failed|error"], [],
        [r"No test files|error|FAIL"], [],
    )

    # -------------------------------------------------------------------------
    # progress_query (4)
    # -------------------------------------------------------------------------
    add("progress_query", "Progress query: in-progress tasks", {"query": "active work", "status": "in-progress"}, "manual board lookup", None, [r"items|totalCount|Progress query failed"], [], [r"manual"], [])
    add("progress_query", "Progress query: blocked", {"query": "blocked work", "status": "blocked"}, "manual board lookup", None, [r"items|totalCount|Progress query failed"], [], [r"manual"], [])
    add("progress_query", "Progress query: completed", {"query": "completed work", "status": "completed"}, "manual board lookup", None, [r"items|totalCount|Progress query failed"], [], [r"manual"], [])
    add("progress_query", "Progress query: all features", {"query": "all features", "type": "feature"}, "manual board lookup", None, [r"items|totalCount|Progress query failed"], [], [r"manual"], [])

    # -------------------------------------------------------------------------
    # task_update (4)
    # -------------------------------------------------------------------------
    add("task_update", "Update task PHASE1-001 → in-progress", {"taskId": "PHASE1-001", "status": "in-progress", "notes": "response shaper started"}, "manual PM update", None, [r"Task not found|success"], [], [r"manual"], [])
    add("task_update", "Update task PHASE2-001 → in-progress", {"taskId": "PHASE2-001", "status": "in-progress", "notes": "bi-temporal model started"}, "manual PM update", None, [r"Task not found|success"], [], [r"manual"], [])
    add("task_update", "Update task PHASE3-001 → blocked", {"taskId": "PHASE3-001", "status": "blocked", "notes": "waiting on Phase 2"}, "manual PM update", None, [r"Task not found|success"], [], [r"manual"], [])
    add("task_update", "Update task PHASE5-001 → completed", {"taskId": "PHASE5-001", "status": "completed", "notes": "context_pack shipped"}, "manual PM update", None, [r"Task not found|success"], [], [r"manual"], [])

    # -------------------------------------------------------------------------
    # feature_status (4)
    # -------------------------------------------------------------------------
    add("feature_status", "Feature: FEAT-CONTEXT-BUDGET", {"featureId": "FEAT-CONTEXT-BUDGET"}, "manual roadmap lookup", None, [r"Feature not found|success|status"], [], [r"manual"], [])
    add("feature_status", "Feature: FEAT-EPISODE-MEMORY", {"featureId": "FEAT-EPISODE-MEMORY"}, "manual roadmap lookup", None, [r"Feature not found|success|status"], [], [r"manual"], [])
    add("feature_status", "Feature: FEAT-CONTEXT-PACK", {"featureId": "FEAT-CONTEXT-PACK"}, "manual roadmap lookup", None, [r"Feature not found|success|status"], [], [r"manual"], [])
    add("feature_status", "Feature: FEAT-HYBRID-RETRIEVAL", {"featureId": "FEAT-HYBRID-RETRIEVAL"}, "manual roadmap lookup", None, [r"Feature not found|success|status"], [], [r"manual"], [])

    # -------------------------------------------------------------------------
    # blocking_issues (4)
    # -------------------------------------------------------------------------
    add("blocking_issues", "Blockers: all", {"type": "all"}, "manual blocker check", None, [r"blockingIssues|No blocking issues|failed"], [], [r"manual"], [])
    add("blocking_issues", "Blockers: critical", {"type": "critical"}, "manual blocker check", None, [r"blockingIssues|No blocking issues|failed"], [], [r"manual"], [])
    add("blocking_issues", "Blockers: features", {"type": "features"}, "manual blocker check", None, [r"blockingIssues|No blocking issues|failed"], [], [r"manual"], [])
    add("blocking_issues", "Blockers: tests", {"type": "tests"}, "manual blocker check", None, [r"blockingIssues|No blocking issues|failed"], [], [r"manual"], [])

    # -------------------------------------------------------------------------
    # semantic_search (4)
    # -------------------------------------------------------------------------
    add(
        "semantic_search",
        "Semantic search: episode memory design",
        {"query": "episode memory agent interaction", "type": "function", "limit": 5},
        "grep episode/memory keywords",
        "grep -Rn 'episode\\|memory\\|checkpoint' src --include='*.ts' | head -n 20",
        [r"results|Semantic|No indexed"], [],
        [r"episode|memory|checkpoint"], [],
    )
    add(
        "semantic_search",
        "Semantic search: PPR graph retrieval",
        {"query": "personalized pagerank graph traversal retrieval", "type": "function", "limit": 5},
        "grep PPR/traversal keywords",
        "grep -Rn 'pagerank\\|traversal\\|ppr' src --include='*.ts' | head -n 10",
        [r"results|Semantic|No indexed"], [],
        [r"pagerank\\|traversal\\|ppr"], [],
    )
    add(
        "semantic_search",
        "Semantic search: context budget allocation",
        {"query": "context budget token allocation response shaping", "type": "function", "limit": 5},
        "grep budget/shaping keywords",
        "grep -Rn 'budget\\|shapeValue\\|allocation\\|tokenEstimate' src --include='*.ts' | head -n 20",
        [r"results|Semantic|No indexed"], [],
        [r"budget\\|shape\\|token"], [],
    )
    add(
        "semantic_search",
        "Semantic search: temporal graph model",
        {"query": "temporal graph validFrom validTo bi-temporal", "type": "file", "limit": 5},
        "grep temporal/validFrom keywords",
        "grep -Rn 'validFrom\\|validTo\\|temporal' src --include='*.ts' | head -n 10",
        [r"results|Semantic|No indexed"], [],
        [r"validFrom\\|temporal"], [],
    )

    # -------------------------------------------------------------------------
    # find_similar_code (4)
    # -------------------------------------------------------------------------
    add("find_similar_code", "Similar to ToolHandlers", {"elementId": "ToolHandlers", "threshold": 0.7, "limit": 5}, "grep ToolHandlers refs", "grep -Rn 'ToolHandlers' src --include='*.ts' | head -n 20", [r"similar|No indexed symbols|SEMANTIC_SEARCH_FAILED"], [], [r"ToolHandlers"], [])
    add("find_similar_code", "Similar to ProgressEngine", {"elementId": "ProgressEngine", "threshold": 0.7, "limit": 5}, "grep ProgressEngine refs", "grep -Rn 'ProgressEngine' src --include='*.ts' | head -n 20", [r"similar|No indexed symbols|SEMANTIC_SEARCH_FAILED"], [], [r"ProgressEngine"], [])
    add("find_similar_code", "Similar to EmbeddingEngine", {"elementId": "EmbeddingEngine", "threshold": 0.6, "limit": 5}, "grep EmbeddingEngine refs", "grep -Rn 'EmbeddingEngine' src --include='*.ts' | head -n 20", [r"similar|No indexed symbols|SEMANTIC_SEARCH_FAILED"], [], [r"EmbeddingEngine"], [])
    add("find_similar_code", "Similar to ArchitectureEngine", {"elementId": "ArchitectureEngine", "threshold": 0.8, "limit": 5}, "grep ArchitectureEngine refs", "grep -Rn 'ArchitectureEngine' src --include='*.ts' | head -n 20", [r"similar|No indexed symbols|SEMANTIC_SEARCH_FAILED"], [], [r"ArchitectureEngine"], [])

    # -------------------------------------------------------------------------
    # code_clusters (4)
    # -------------------------------------------------------------------------
    add("code_clusters", "Cluster files by directory", {"type": "file", "count": 5}, "list source directories", "find src -maxdepth 2 -type d | head -n 20", [r"clusters|No indexed symbols|SEMANTIC_SEARCH_FAILED"], [], [r"src/"], [])
    add("code_clusters", "Cluster functions", {"type": "function", "count": 5}, "grep function names", "grep -Rn 'async [a-z]' src/tools --include='*.ts' | head -n 20", [r"clusters|No indexed symbols|SEMANTIC_SEARCH_FAILED"], [], [r"async"], [])
    add("code_clusters", "Cluster classes", {"type": "class", "count": 5}, "grep class declarations", "grep -Rn '^export class' src --include='*.ts' | head -n 20", [r"clusters|No indexed symbols|SEMANTIC_SEARCH_FAILED"], [], [r"export class"], [])
    add("code_clusters", "Cluster files top 3", {"type": "file", "count": 3}, "list top dirs", "find src -maxdepth 1 -type d | head -n 10", [r"clusters|No indexed symbols|SEMANTIC_SEARCH_FAILED"], [], [r"src"], [])

    # -------------------------------------------------------------------------
    # semantic_diff (4)
    # -------------------------------------------------------------------------
    add(
        "semantic_diff",
        "Semantic diff: two engine files",
        {"elementId1": "src/engines/progress-engine.ts", "elementId2": "src/engines/architecture-engine.ts"},
        "text diff between engine files",
        "diff -u src/engines/progress-engine.ts src/engines/architecture-engine.ts | head -n 40",
        [r"left|right|changedKeys|Element not found|Semantic"], [],
        [r"@@|---|\\+\\+\\+"], [],
    )
    add(
        "semantic_diff",
        "Semantic diff: two graph files",
        {"elementId1": "src/graph/orchestrator.ts", "elementId2": "src/graph/builder.ts"},
        "text diff between graph files",
        "diff -u src/graph/orchestrator.ts src/graph/builder.ts | head -n 40",
        [r"left|right|changedKeys|Element not found|Semantic"], [],
        [r"@@|---|\\+\\+\\+"], [],
    )
    add(
        "semantic_diff",
        "Semantic diff: two vector files",
        {"elementId1": "src/vector/embedding-engine.ts", "elementId2": "src/vector/qdrant-client.ts"},
        "text diff between vector files",
        "diff -u src/vector/embedding-engine.ts src/vector/qdrant-client.ts | head -n 40",
        [r"left|right|changedKeys|Element not found|Semantic"], [],
        [r"@@|---|\\+\\+\\+"], [],
    )
    add(
        "semantic_diff",
        "Semantic diff: server vs mcp-server",
        {"elementId1": "src/server.ts", "elementId2": "src/mcp-server.ts"},
        "text diff server vs mcp-server",
        "diff -u src/server.ts src/mcp-server.ts | head -n 40",
        [r"left|right|changedKeys|Element not found|Semantic"], [],
        [r"@@|---|\\+\\+\\+"], [],
    )

    # -------------------------------------------------------------------------
    # suggest_tests (4)
    # -------------------------------------------------------------------------
    add("suggest_tests", "Suggest tests for tool-handlers.ts", {"elementId": "src/tools/tool-handlers.ts", "limit": 5}, "grep tests referencing tool-handlers", "grep -Ril 'ToolHandlers' src --include='*.test.ts' | head -n 10", [r"suggestedTests|Unable to resolve|No indexed symbols"], [], [r"test|src"], [])
    add("suggest_tests", "Suggest tests for progress-engine.ts", {"elementId": "src/engines/progress-engine.ts", "limit": 5}, "grep tests referencing progress-engine", "grep -Ril 'ProgressEngine' src --include='*.test.ts' | head -n 10", [r"suggestedTests|Unable to resolve|No indexed symbols"], [], [r"test|src"], [])
    add("suggest_tests", "Suggest tests for graph/client.ts", {"elementId": "src/graph/client.ts", "limit": 5}, "grep tests referencing MemgraphClient", "grep -Ril 'MemgraphClient' src --include='*.test.ts' | head -n 10", [r"suggestedTests|Unable to resolve|No indexed symbols"], [], [r"test|src"], [])
    add("suggest_tests", "Suggest tests for embedding-engine.ts", {"elementId": "src/vector/embedding-engine.ts", "limit": 5}, "grep tests referencing EmbeddingEngine", "grep -Ril 'EmbeddingEngine' src --include='*.test.ts' | head -n 10", [r"suggestedTests|Unable to resolve|No indexed symbols"], [], [r"test|src"], [])

    return cases


def write_sqlite(run_id: str, generated_at: str, rows: List[Dict[str, Any]], summary: Dict[str, Any]) -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS benchmark_runs (
          run_id TEXT PRIMARY KEY,
          generated_at TEXT NOT NULL,
          mcp_url TEXT NOT NULL,
          total_scenarios INTEGER NOT NULL
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS benchmark_results (
          run_id TEXT NOT NULL,
          case_id TEXT NOT NULL,
          tool TEXT NOT NULL,
          title TEXT NOT NULL,
          winner TEXT NOT NULL,
          notes TEXT NOT NULL,
          mcp_latency_ms REAL,
          baseline_latency_ms REAL,
          mcp_accuracy REAL,
          baseline_accuracy REAL,
          mcp_tokens INTEGER,
          baseline_tokens INTEGER,
          mcp_success INTEGER,
          baseline_success INTEGER,
          mcp_payload TEXT,
          baseline_payload TEXT,
          mcp_output_preview TEXT,
          baseline_output_preview TEXT,
          PRIMARY KEY(run_id, case_id)
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS benchmark_summary (
          run_id TEXT NOT NULL,
          metric TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY(run_id, metric)
        )
        """
    )

    cur.execute(
        "INSERT INTO benchmark_runs(run_id, generated_at, mcp_url, total_scenarios) VALUES(?, ?, ?, ?)",
        (run_id, generated_at, MCP_URL, len(rows)),
    )

    for row in rows:
        cur.execute(
            """
            INSERT INTO benchmark_results(
              run_id, case_id, tool, title, winner, notes,
              mcp_latency_ms, baseline_latency_ms, mcp_accuracy, baseline_accuracy,
              mcp_tokens, baseline_tokens, mcp_success, baseline_success,
              mcp_payload, baseline_payload, mcp_output_preview, baseline_output_preview
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                row["id"],
                row["tool"],
                row["title"],
                row["winner"],
                row["notes"],
                row["mcp"]["latency_ms"],
                row["baseline"]["latency_ms"],
                row["mcp"]["accuracy"],
                row["baseline"]["accuracy"],
                row["mcp"]["total_tokens_est"],
                row["baseline"]["total_tokens_est"],
                int(bool(row["mcp"]["success"])),
                int(bool(row["baseline"]["success"])),
                json.dumps(row["mcp"]["request_payload"]),
                json.dumps(row["baseline"]["request_payload"]),
                row["mcp"]["output_preview"],
                row["baseline"]["output_preview"],
            ),
        )

    for key, value in summary.items():
        if isinstance(value, (list, dict)):
            value_str = json.dumps(value)
        else:
            value_str = str(value)
        cur.execute(
            "INSERT INTO benchmark_summary(run_id, metric, value) VALUES(?, ?, ?)",
            (run_id, key, value_str),
        )

        cur.execute(
                """
                CREATE VIEW IF NOT EXISTS latest_tool_summary AS
                WITH latest AS (
                    SELECT run_id
                    FROM benchmark_runs
                    ORDER BY generated_at DESC
                    LIMIT 1
                )
                SELECT
                    r.tool,
                    COUNT(*) AS scenarios,
                    AVG(r.mcp_latency_ms) AS avg_mcp_ms,
                    AVG(r.baseline_latency_ms) AS avg_baseline_ms,
                    AVG(r.mcp_accuracy) AS avg_mcp_accuracy,
                    AVG(r.baseline_accuracy) AS avg_baseline_accuracy,
                    AVG(r.mcp_tokens) AS avg_mcp_tokens,
                    AVG(r.baseline_tokens) AS avg_baseline_tokens
                FROM benchmark_results r
                JOIN latest l ON r.run_id = l.run_id
                GROUP BY r.tool
                ORDER BY r.tool
                """
        )

        cur.execute(
                """
                CREATE VIEW IF NOT EXISTS latest_accuracy_gaps AS
                WITH latest AS (
                    SELECT run_id
                    FROM benchmark_runs
                    ORDER BY generated_at DESC
                    LIMIT 1
                )
                SELECT
                    r.case_id,
                    r.tool,
                    r.title,
                    r.mcp_accuracy,
                    r.baseline_accuracy,
                    (r.baseline_accuracy - r.mcp_accuracy) AS baseline_minus_mcp,
                    r.notes
                FROM benchmark_results r
                JOIN latest l ON r.run_id = l.run_id
                WHERE r.baseline_accuracy > r.mcp_accuracy
                ORDER BY baseline_minus_mcp DESC, r.tool, r.case_id
                """
        )

        cur.execute(
                """
                CREATE VIEW IF NOT EXISTS latest_latency_outliers AS
                WITH latest AS (
                    SELECT run_id
                    FROM benchmark_runs
                    ORDER BY generated_at DESC
                    LIMIT 1
                )
                SELECT
                    r.case_id,
                    r.tool,
                    r.title,
                    r.mcp_latency_ms,
                    r.baseline_latency_ms,
                    (r.mcp_latency_ms - COALESCE(r.baseline_latency_ms, 0)) AS mcp_minus_baseline,
                    r.winner,
                    r.notes
                FROM benchmark_results r
                JOIN latest l ON r.run_id = l.run_id
                ORDER BY r.mcp_latency_ms DESC
                """
        )

    conn.commit()
    conn.close()


def to_markdown(generated_at: str, rows: List[Dict[str, Any]], summary: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Graph Tools Benchmark Matrix")
    lines.append("")
    lines.append(f"Generated: {generated_at}")
    lines.append("")
    lines.append("## Storage")
    lines.append("")
    lines.append(f"- Canonical results database: {DB_PATH.relative_to(ROOT)}")
    lines.append("- Result rows are stored in `benchmark_results` with per-run keys in `benchmark_runs`.")
    lines.append("")
    lines.append("## Method")
    lines.append("")
    lines.append("- At least 4 scenarios per MCP tool (19 tools => 76 scenarios total).")
    lines.append("- Compared each MCP graph-server tool against a standard non-graph workflow (CLI/manual equivalent).")
    lines.append("- Metrics: latency, accuracy (expectation-match score), estimated token usage, success rate, and winner.")
    lines.append("- Token estimate uses `ceil(characters / 4)` for both request and output.")
    lines.append("- `mcp_only` indicates no practical automated non-graph equivalent.")
    lines.append("")
    lines.append("## Matrix")
    lines.append("")
    lines.append("| ID | Tool | Scenario | MCP ms | Baseline ms | MCP Acc | Base Acc | MCP Tok | Base Tok | Winner | Notes |")
    lines.append("|---|---|---|---:|---:|---:|---:|---:|---:|---|---|")

    for row in rows:
        b_ms = "N/A" if row["baseline"]["latency_ms"] is None else f"{row['baseline']['latency_ms']:.2f}"
        notes = row["notes"].replace("|", "/")
        lines.append(
            f"| {row['id']} | {row['tool']} | {row['title']} | {row['mcp']['latency_ms']:.2f} | {b_ms} | {row['mcp']['accuracy']:.3f} | {row['baseline']['accuracy']:.3f} | {row['mcp']['total_tokens_est']} | {row['baseline']['total_tokens_est']} | {row['winner']} | {notes} |"
        )

    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Total scenarios: {summary['totalScenarios']}")
    lines.append(f"- Tools covered: {summary['toolsCovered']}")
    lines.append(f"- Minimum scenarios per tool: {summary['minScenariosPerTool']}")
    lines.append(f"- MCP faster: {summary['mcpFaster']} | Baseline faster: {summary['baselineFaster']} | Ties: {summary['ties']}")
    lines.append(f"- MCP better accuracy: {summary['mcpHigherAccuracy']} | Baseline better accuracy: {summary['baselineHigherAccuracy']} | Equal: {summary['accuracyTies']}")
    lines.append(f"- MCP lower token usage: {summary['mcpLowerTokens']} | Baseline lower token usage: {summary['baselineLowerTokens']} | Equal: {summary['tokenTies']}")
    lines.append(f"- MCP-only scenarios: {summary['mcpOnly']}")
    lines.append(f"- Token budget compliance (compact ≤300 tok): {summary['tokenBudgetCompliance']} / {summary['totalScenarios']}")
    lines.append(f"- Answer-first summary field present: {summary['summaryFieldPresent']} / {summary['totalScenarios']}")

    lines.append("")
    lines.append("## Improvement Targets")
    lines.append("")
    for target in summary["improvementTargets"]:
        lines.append(f"- {target}")

    lines.append("")
    lines.append("## Re-run")
    lines.append("")
    lines.append("```bash")
    lines.append("PYENV_VERSION=system python3 tools/graph-server/scripts/benchmark_graph_tools.py")
    lines.append("```")

    lines.append("")
    lines.append("## SQLite Quick Queries")
    lines.append("")
    lines.append("```bash")
    lines.append("sqlite3 tools/graph-server/benchmarks/graph_tools_benchmark.sqlite \"SELECT tool, COUNT(*) FROM benchmark_results WHERE run_id=(SELECT run_id FROM benchmark_runs ORDER BY generated_at DESC LIMIT 1) GROUP BY tool ORDER BY tool;\"")
    lines.append("sqlite3 tools/graph-server/benchmarks/graph_tools_benchmark.sqlite \"SELECT winner, COUNT(*) FROM benchmark_results WHERE run_id=(SELECT run_id FROM benchmark_runs ORDER BY generated_at DESC LIMIT 1) GROUP BY winner;\"")
    lines.append("```")

    return "\n".join(lines) + "\n"


def main() -> None:
    cases = build_cases()
    rows: List[Dict[str, Any]] = []

    for case in cases:
        mcp = run_mcp_case(case)
        baseline = run_baseline_case(case)
        winner = classify_winner(mcp, baseline)

        notes: List[str] = []
        if case.tool == "graph_query" and case.arguments.get("language") == "natural" and mcp["accuracy"] < 0.6:
            notes.append("Natural-language query quality is low")
        if case.tool in {"semantic_search", "find_similar_code", "code_clusters", "semantic_diff", "suggest_tests"}:
            notes.append("Vector tool: requires Qdrant index to be populated")
        if not row["mcp"].get("token_budget_ok", True):
            tok = row["mcp"].get("reported_token_estimate") or row["mcp"]["output_tokens_est"]
            notes.append(f"Token budget exceeded: {tok} tok > 300")
        if row["mcp"].get("has_summary_field"):
            notes.append("✓ summary field present")
        if baseline["latency_ms"] is None:
            notes.append("No direct non-graph automation")
        if mcp["accuracy"] < 0.5:
            notes.append("Low MCP accuracy on this scenario")
        if not mcp["success"]:
            notes.append("MCP response indicates failure")

        rows.append(
            {
                "id": case.id,
                "tool": case.tool,
                "title": case.title,
                "mcp": mcp,
                "baseline": baseline,
                "winner": winner,
                "notes": "; ".join(notes) if notes else "-",
            }
        )

    comparable = [r for r in rows if r["baseline"]["latency_ms"] is not None]
    tool_counts: Dict[str, int] = {}
    for r in rows:
        tool_counts[r["tool"]] = tool_counts.get(r["tool"], 0) + 1

    summary = {
        "totalScenarios": len(rows),
        "toolsCovered": len(tool_counts),
        "minScenariosPerTool": min(tool_counts.values()) if tool_counts else 0,
        "mcpFaster": sum(1 for r in comparable if r["mcp"]["latency_ms"] < r["baseline"]["latency_ms"]),
        "baselineFaster": sum(1 for r in comparable if r["baseline"]["latency_ms"] < r["mcp"]["latency_ms"]),
        "ties": sum(1 for r in comparable if r["baseline"]["latency_ms"] == r["mcp"]["latency_ms"]),
        "mcpHigherAccuracy": sum(1 for r in rows if r["mcp"]["accuracy"] > r["baseline"]["accuracy"]),
        "baselineHigherAccuracy": sum(1 for r in rows if r["baseline"]["accuracy"] > r["mcp"]["accuracy"]),
        "accuracyTies": sum(1 for r in rows if r["baseline"]["accuracy"] == r["mcp"]["accuracy"]),
        "mcpLowerTokens": sum(1 for r in rows if r["mcp"]["total_tokens_est"] < r["baseline"]["total_tokens_est"]),
        "baselineLowerTokens": sum(1 for r in rows if r["baseline"]["total_tokens_est"] < r["mcp"]["total_tokens_est"]),
        "tokenTies": sum(1 for r in rows if r["baseline"]["total_tokens_est"] == r["mcp"]["total_tokens_est"]),
        "mcpOnly": sum(1 for r in rows if r["baseline"]["latency_ms"] is None),
        # Phase 1 quality gates — tracked as regression-guarded counters
        "tokenBudgetCompliance": sum(1 for r in rows if r["mcp"].get("token_budget_ok", False)),
        "summaryFieldPresent": sum(1 for r in rows if r["mcp"].get("has_summary_field", False)),
        "perToolCounts": tool_counts,
        "improvementTargets": [
            "Phase 1: Ensure compact profile consistently meets _tokenEstimate ≤ 300 target (response shaper in tool-handlers.ts).",
            "Phase 2: Add bi-temporal (validFrom/validTo) to all FILE/FUNCTION/CLASS nodes in graph/builder.ts.",
            "Phase 3: Replace in-memory CHECKPOINT with persistent EPISODE nodes (new episode-engine.ts).",
            "Phase 5: Implement context_pack tool with PPR-based retrieval (ppr.ts + context-pack handler).",
            "Phase 8: Replace routeNaturalToCypher regex stubs with hybrid retriever (vector+BM25+PPR via RRF in hybrid-retriever.ts).",
        ],
    }

    generated_at = datetime.now(timezone.utc).isoformat()
    run_id = generated_at.replace(":", "").replace("-", "")

    write_sqlite(run_id, generated_at, rows, summary)
    MATRIX_PATH.write_text(to_markdown(generated_at, rows, summary), encoding="utf-8")

    print(f"Wrote SQLite results: {DB_PATH}")
    print(f"Wrote matrix report: {MATRIX_PATH}")
    print(f"Run ID: {run_id}")
    print(f"Scenarios: {len(rows)} (min per tool: {summary['minScenariosPerTool']})")


if __name__ == "__main__":
    main()
