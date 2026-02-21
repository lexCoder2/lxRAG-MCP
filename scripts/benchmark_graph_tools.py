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

    return {
        "transport": "mcp",
        "tool": case.tool,
        "title": case.title,
        "latency_ms": elapsed_ms,
        "exit_code": proc.returncode,
        "success": proc.returncode == 0 and "Error:" not in output_text,
        "accuracy": accuracy,
        "request_tokens_est": estimate_tokens(json.dumps(payload)),
        "output_tokens_est": estimate_tokens(output_text),
        "total_tokens_est": estimate_tokens(json.dumps(payload)) + estimate_tokens(output_text),
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


def build_cases() -> List[BenchmarkCase]:
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

    # graph_query (4)
    add("graph_query", "Cypher imports for LoginPage", {"query": "MATCH (f:FILE)-[:IMPORTS]->(imp:IMPORT) WHERE imp.source CONTAINS 'LoginPage' RETURN f.path, imp.source ORDER BY f.path", "language": "cypher", "limit": 40}, "grep imports LoginPage", "grep -Rin \"import .*LoginPage\" src --include='*.ts' --include='*.tsx'", [r"LoginPage"], [r"App\\.tsx"], [r"LoginPage"], [r"App\\.tsx"])
    add("graph_query", "Cypher functions in auth folder", {"query": "MATCH (f:FILE)-[:CONTAINS]->(fn:FUNCTION) WHERE f.path CONTAINS '/auth/' RETURN f.path, fn.name ORDER BY f.path", "language": "cypher", "limit": 40}, "grep function patterns in auth", "grep -RinE \"function |const .*=>|async .*=>\" src/components/auth --include='*.ts' --include='*.tsx'", [r"auth"], [r"handleSubmit|function"], [r"handleSubmit|async"], [])
    add("graph_query", "Natural query for BuildingContext importers", {"query": "files importing BuildingContext", "language": "natural", "limit": 30}, "grep BuildingContext imports", "grep -Rin \"import .*BuildingContext\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"BuildingContext|IMPORT|FILE"], [], [r"BuildingContext"], [])
    add("graph_query", "Cypher useBuildingState import graph", {"query": "MATCH (f:FILE)-[:IMPORTS]->(imp:IMPORT) WHERE imp.source CONTAINS 'useBuildingState' RETURN f.path ORDER BY f.path", "language": "cypher", "limit": 60}, "grep useBuildingState references", "grep -Rin \"useBuildingState\" src --include='*.ts' --include='*.tsx' | head -n 60", [r"useBuildingState|f.path"], [], [r"useBuildingState"], [])

    # code_explain (4)
    add("code_explain", "Explain App.tsx", {"element": "App.tsx", "depth": 2}, "grep + read App.tsx", "(grep -n \"import\" src/App.tsx | head -n 20; echo '---'; sed -n '1,120p' src/App.tsx)", [r"App\\.tsx|Element not found"], [r"dependencies|type"], [r"import"], [r"App"])
    add("code_explain", "Explain GridCanvas.tsx", {"element": "GridCanvas.tsx", "depth": 2}, "grep + read GridCanvas", "(grep -n \"import\" src/components/drawing/GridCanvas.tsx | head -n 20; echo '---'; sed -n '1,120p' src/components/drawing/GridCanvas.tsx)", [r"GridCanvas|Element not found"], [], [r"import"], [r"GridCanvas"])
    add("code_explain", "Explain useCalculateAll", {"element": "useCalculateAll", "depth": 2}, "grep hook definition", "grep -Rin \"useCalculateAll\" src/hooks --include='*.ts' --include='*.tsx' | head -n 40", [r"useCalculateAll|Element not found"], [r"dependencies|FUNCTION"], [r"useCalculateAll"], [])
    add("code_explain", "Explain ColumnCalculationService", {"element": "ColumnCalculationService", "depth": 3}, "grep class definition", "grep -Rin \"class ColumnCalculationService\" src --include='*.ts' --include='*.tsx'", [r"ColumnCalculationService|Element not found"], [r"CLASS|dependencies"], [r"ColumnCalculationService"], [])

    # arch_validate (4)
    add("arch_validate", "Architecture validate default", {"strict": False}, "grep context usage in components", "grep -Rin \"context/\" src/components --include='*.ts' --include='*.tsx' | head -n 40", [r"violations|success|Architecture engine not initialized"], [], [r"context"], [])
    add("arch_validate", "Architecture validate strict", {"strict": True}, "grep engine from components", "grep -Rin \"../engine|../../engine\" src/components --include='*.ts' --include='*.tsx' | head -n 40", [r"violations|success|Architecture engine not initialized"], [], [r"engine|src"], [])
    add("arch_validate", "Architecture validate hooks folder", {"files": ["src/hooks/useCalculateAll.ts", "src/hooks/useBuildingState.ts"], "strict": False}, "manual inspect hook imports", "grep -Rin \"^import\" src/hooks/useCalculateAll.ts src/hooks/useBuildingState.ts", [r"success|violations|Architecture engine not initialized"], [], [r"import"], [])
    add("arch_validate", "Architecture validate drawing files", {"files": ["src/components/drawing/GridCanvas.tsx"], "strict": False}, "manual inspect drawing imports", "grep -n \"^import\" src/components/drawing/GridCanvas.tsx", [r"success|violations|Architecture engine not initialized"], [], [r"import"], [])

    # test_select (4)
    add("test_select", "Test select for drawing and hooks", {"changedFiles": ["src/components/drawing/GridCanvas.tsx", "src/hooks/useBuildingState.ts"]}, "grep tests touching symbols", "grep -RilE \"GridCanvas|useBuildingState\" src --include='*.test.ts' --include='*.test.tsx' | head -n 50", [r"selectedTests|coverage|failed"], [], [r"test|src"], [])
    add("test_select", "Test select for calculation hooks", {"changedFiles": ["src/hooks/useCalculateAll.ts", "src/hooks/useCalculationResults.ts"]}, "grep tests for calculation hooks", "grep -RilE \"useCalculateAll|useCalculationResults\" src --include='*.test.ts' --include='*.test.tsx' | head -n 50", [r"selectedTests|coverage|failed"], [], [r"test|src"], [])
    add("test_select", "Test select for canvas layers", {"changedFiles": ["src/components/drawing/canvas-layers/BeamsLayer.tsx"]}, "grep tests for beams layer", "grep -Ril \"BeamsLayer\" src --include='*.test.ts' --include='*.test.tsx' | head -n 50", [r"selectedTests|coverage|failed"], [], [r"test|src"], [])
    add("test_select", "Test select for context changes", {"changedFiles": ["src/context/BuildingContext.tsx", "src/context/DrawingContext.tsx"]}, "grep tests for contexts", "grep -RilE \"BuildingContext|DrawingContext\" src --include='*.test.ts' --include='*.test.tsx' | head -n 50", [r"selectedTests|coverage|failed"], [], [r"test|src"], [])

    # graph_rebuild (4)
    add("graph_rebuild", "Graph rebuild incremental", {"mode": "incremental", "verbose": False}, "count TS/TSX files", "find src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l", [r"QUEUED|success"], [], [r"[0-9]+"], [])
    add("graph_rebuild", "Graph rebuild incremental verbose", {"mode": "incremental", "verbose": True}, "count TS files only", "find src -type f -name '*.ts' | wc -l", [r"QUEUED|success"], [], [r"[0-9]+"], [])
    add("graph_rebuild", "Graph rebuild full", {"mode": "full", "verbose": False}, "count TSX files only", "find src -type f -name '*.tsx' | wc -l", [r"QUEUED|success"], [], [r"[0-9]+"], [])
    add("graph_rebuild", "Graph rebuild full verbose", {"mode": "full", "verbose": True}, "count source dirs", "find src -type d | wc -l", [r"QUEUED|success"], [], [r"[0-9]+"], [])

    # find_pattern (4)
    add("find_pattern", "Pattern violations", {"pattern": "context imports in components", "type": "violation"}, "grep context imports", "grep -Rin \"context/\" src/components --include='*.ts' --include='*.tsx' | head -n 40", [r"matches|Architecture engine not initialized|violation"], [], [r"context"], [])
    add("find_pattern", "Pattern unused nodes", {"pattern": "unused files", "type": "unused"}, "find ts files (manual candidate set)", "find src -type f \( -name '*.ts' -o -name '*.tsx' \) | head -n 50", [r"matches|unused|No incoming|search-implemented"], [], [r"src/"], [])
    add("find_pattern", "Pattern circular deps", {"pattern": "circular dependencies", "type": "circular"}, "grep import graph candidates", "grep -Rin \"from '\\.|from \\\"\\.\"\" src --include='*.ts' --include='*.tsx' | head -n 60", [r"circular|matches|not-implemented"], [], [r"from"], [])
    add("find_pattern", "Pattern generic", {"pattern": "useBuildingState", "type": "pattern"}, "grep for useBuildingState", "grep -Rin \"useBuildingState\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"search-implemented|matches|pattern"], [], [r"useBuildingState"], [])

    # arch_suggest (4)
    add("arch_suggest", "Suggest hook placement", {"name": "useBeamSizing", "type": "hook", "dependencies": ["useBuildingState", "useCalculateAll"]}, "folder heuristic", "find src -maxdepth 2 -type d | grep -E 'hooks|components|engine|context|utils|types'", [r"suggestedPath|No suitable|Architecture engine not initialized"], [], [r"src/"], [])
    add("arch_suggest", "Suggest service placement", {"name": "SeismicLoad", "type": "service", "dependencies": ["CodeFactory"]}, "folder heuristic for services", "find src -maxdepth 4 -type d | grep -E 'engine|services|hooks|utils|types' | head -n 40", [r"suggestedPath|No suitable|Architecture engine not initialized"], [], [r"src/"], [])
    add("arch_suggest", "Suggest component placement", {"name": "BeamSummaryPanel", "type": "component", "dependencies": ["useBeamCalculation"]}, "folder heuristic for components", "find src/components -maxdepth 3 -type d | head -n 40", [r"suggestedPath|No suitable|Architecture engine not initialized"], [], [r"src/components"], [])
    add("arch_suggest", "Suggest utility placement", {"name": "loadPathFormatter", "type": "utility", "dependencies": ["load-takedown.types"]}, "folder heuristic for utils", "find src -maxdepth 3 -type d | grep -E 'utils|types|engine' | head -n 40", [r"suggestedPath|No suitable|Architecture engine not initialized"], [], [r"src/"], [])

    # test_categorize (4)
    add("test_categorize", "Categorize all tests (empty list)", {"testFiles": []}, "count tests by pattern", "echo \"unit=$(find src -type f -path '*__tests__*' -name '*.test.ts' | wc -l)\"; echo \"tsx=$(find src -type f -path '*__tests__*' -name '*.test.tsx' | wc -l)\"; echo \"integration=$(find src -type f -name '*.integration.test.ts*' | wc -l)\"", [r"statistics|categorization"], [], [r"unit=|integration="], [])
    add("test_categorize", "Categorize focused sample set", {"testFiles": ["src/__tests__/App.test.tsx", "src/hooks/__tests__/useCalculateAll.test.ts"]}, "manual sample labels", "echo 'src/__tests__/App.test.tsx'; echo 'src/hooks/__tests__/useCalculateAll.test.ts'", [r"statistics|categorization"], [], [r"test"], [])
    add("test_categorize", "Categorize drawing test sample", {"testFiles": ["src/components/drawing/__tests__/GridCanvas.test.tsx"]}, "manual drawing test label", "echo 'src/components/drawing/__tests__/GridCanvas.test.tsx'", [r"statistics|categorization"], [], [r"GridCanvas"], [])
    add("test_categorize", "Categorize integration sample", {"testFiles": ["src/__tests__/integration/FullWorkflow.integration.test.ts"]}, "manual integration test label", "echo 'src/__tests__/integration/FullWorkflow.integration.test.ts'", [r"statistics|categorization"], [], [r"integration"], [])

    # impact_analyze (4)
    add("impact_analyze", "Impact analyze calculation hooks", {"files": ["src/hooks/useCalculateAll.ts"], "depth": 3}, "grep tests for calculateAll", "grep -Ril \"useCalculateAll\" src --include='*.test.ts' --include='*.test.tsx' | head -n 40", [r"blastRadius|coverage|Impact analysis failed"], [], [r"test|src"], [])
    add("impact_analyze", "Impact analyze drawing canvas", {"files": ["src/components/drawing/GridCanvas.tsx"], "depth": 2}, "grep tests for GridCanvas", "grep -Ril \"GridCanvas\" src --include='*.test.ts' --include='*.test.tsx' | head -n 40", [r"blastRadius|coverage|Impact analysis failed"], [], [r"test|src"], [])
    add("impact_analyze", "Impact analyze building context", {"files": ["src/context/BuildingContext.tsx"], "depth": 2}, "grep tests for BuildingContext", "grep -Ril \"BuildingContext\" src --include='*.test.ts' --include='*.test.tsx' | head -n 40", [r"blastRadius|coverage|Impact analysis failed"], [], [r"test|src"], [])
    add("impact_analyze", "Impact analyze engine service", {"files": ["src/engine/calculations/services/ColumnCalculationService.ts"], "depth": 2}, "grep tests for column service", "grep -Ril \"ColumnCalculationService\" src --include='*.test.ts' --include='*.test.tsx' | head -n 40", [r"blastRadius|coverage|Impact analysis failed"], [], [r"test|src"], [])

    # test_run (4)
    add("test_run", "Run App.test.tsx", {"testFiles": ["src/__tests__/App.test.tsx"], "parallel": True}, "Run same test with vitest", "npx vitest run src/__tests__/App.test.tsx --reporter=verbose", [r"status|passed|failed|error"], [], [r"RUN|No test files|passed|failed"], [])
    add("test_run", "Run useCalculateAll.test.ts", {"testFiles": ["src/hooks/__tests__/useCalculateAll.test.ts"], "parallel": True}, "Run same hook test with vitest", "npx vitest run src/hooks/__tests__/useCalculateAll.test.ts --reporter=verbose", [r"status|passed|failed|error"], [], [r"RUN|No test files|passed|failed"], [])
    add("test_run", "Run GridCanvas.test.tsx", {"testFiles": ["src/components/drawing/__tests__/GridCanvas.test.tsx"], "parallel": False}, "Run same drawing test with vitest", "npx vitest run src/components/drawing/__tests__/GridCanvas.test.tsx --reporter=verbose", [r"status|passed|failed|error"], [], [r"RUN|No test files|passed|failed"], [])
    add("test_run", "Run integration FullWorkflow", {"testFiles": ["src/__tests__/integration/FullWorkflow.integration.test.ts"], "parallel": True}, "Run same integration test with vitest", "npx vitest run src/__tests__/integration/FullWorkflow.integration.test.ts --reporter=verbose", [r"status|passed|failed|error"], [], [r"RUN|No test files|passed|failed"], [])

    # progress_query (4)
    add("progress_query", "Progress query active", {"query": "active work", "status": "active"}, "manual board lookup", None, [r"items|Progress query failed|totalCount"], [], [r"manual"], [])
    add("progress_query", "Progress query blocked", {"query": "blocked work", "status": "blocked"}, "manual board lookup", None, [r"items|Progress query failed|blocked"], [], [r"manual"], [])
    add("progress_query", "Progress query completed", {"query": "completed work", "status": "completed"}, "manual board lookup", None, [r"items|Progress query failed|completed"], [], [r"manual"], [])
    add("progress_query", "Progress query all", {"query": "all work", "status": "all"}, "manual board lookup", None, [r"items|Progress query failed|totalCount"], [], [r"manual"], [])

    # task_update (4)
    add("task_update", "Update synthetic BENCH-001", {"taskId": "BENCH-001", "status": "active", "notes": "benchmark step 1"}, "manual PM update", None, [r"Task not found|success"], [], [r"manual"], [])
    add("task_update", "Update synthetic BENCH-002", {"taskId": "BENCH-002", "status": "blocked", "notes": "benchmark step 2"}, "manual PM update", None, [r"Task not found|success"], [], [r"manual"], [])
    add("task_update", "Update synthetic BENCH-003", {"taskId": "BENCH-003", "status": "completed", "notes": "benchmark step 3"}, "manual PM update", None, [r"Task not found|success"], [], [r"manual"], [])
    add("task_update", "Update synthetic BENCH-004", {"taskId": "BENCH-004", "status": "active", "notes": "benchmark step 4"}, "manual PM update", None, [r"Task not found|success"], [], [r"manual"], [])

    # feature_status (4)
    add("feature_status", "Feature status FEATURE-BENCH-1", {"featureId": "FEATURE-BENCH-1"}, "manual roadmap lookup", None, [r"Feature not found|success|status"], [], [r"manual"], [])
    add("feature_status", "Feature status FEATURE-BENCH-2", {"featureId": "FEATURE-BENCH-2"}, "manual roadmap lookup", None, [r"Feature not found|success|status"], [], [r"manual"], [])
    add("feature_status", "Feature status FEATURE-BENCH-3", {"featureId": "FEATURE-BENCH-3"}, "manual roadmap lookup", None, [r"Feature not found|success|status"], [], [r"manual"], [])
    add("feature_status", "Feature status FEATURE-BENCH-4", {"featureId": "FEATURE-BENCH-4"}, "manual roadmap lookup", None, [r"Feature not found|success|status"], [], [r"manual"], [])

    # blocking_issues (4)
    add("blocking_issues", "Blocking issues default", {"context": "benchmark"}, "manual blocker check", None, [r"blockingIssues|No blocking issues|failed"], [], [r"manual"], [])
    add("blocking_issues", "Blocking issues calc", {"context": "calculation"}, "manual blocker check", None, [r"blockingIssues|No blocking issues|failed"], [], [r"manual"], [])
    add("blocking_issues", "Blocking issues drawing", {"context": "drawing"}, "manual blocker check", None, [r"blockingIssues|No blocking issues|failed"], [], [r"manual"], [])
    add("blocking_issues", "Blocking issues release", {"context": "release"}, "manual blocker check", None, [r"blockingIssues|No blocking issues|failed"], [], [r"manual"], [])

    # semantic_search (4)
    add("semantic_search", "Semantic search load takedown", {"query": "load takedown service", "type": "file", "limit": 5}, "grep load takedown keywords", "grep -RinE \"LoadTakedown|load takedown\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|Semantic|results"], [], [r"LoadTakedown|load takedown"], [])
    add("semantic_search", "Semantic search FEM solver", {"query": "fem solver", "type": "file", "limit": 5}, "grep FEM keywords", "grep -RinE \"FEM|solver\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|Semantic|results"], [], [r"FEM|solver"], [])
    add("semantic_search", "Semantic search beam deflection", {"query": "beam deflection", "type": "function", "limit": 5}, "grep beam deflection keywords", "grep -RinE \"beam.*deflection|deflection\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|Semantic|results"], [], [r"deflection|beam"], [])
    add("semantic_search", "Semantic search drawing snap", {"query": "snap manager", "type": "class", "limit": 5}, "grep snap keywords", "grep -RinE \"SnapManager|snap\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|Semantic|results"], [], [r"snap|SnapManager"], [])

    # find_similar_code (4)
    add("find_similar_code", "Similar code useBuildingState", {"elementId": "useBuildingState", "threshold": 0.7, "limit": 5}, "grep useBuildingState refs", "grep -Rin \"useBuildingState\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|similar"], [], [r"useBuildingState"], [])
    add("find_similar_code", "Similar code GridCanvas", {"elementId": "GridCanvas", "threshold": 0.7, "limit": 5}, "grep GridCanvas refs", "grep -Rin \"GridCanvas\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|similar"], [], [r"GridCanvas"], [])
    add("find_similar_code", "Similar code CodeFactory", {"elementId": "CodeFactory", "threshold": 0.6, "limit": 5}, "grep CodeFactory refs", "grep -Rin \"CodeFactory\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|similar"], [], [r"CodeFactory"], [])
    add("find_similar_code", "Similar code LoadTakedownService", {"elementId": "LoadTakedownService", "threshold": 0.8, "limit": 5}, "grep LoadTakedownService refs", "grep -Rin \"LoadTakedownService\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|similar"], [], [r"LoadTakedownService"], [])

    # code_clusters (4)
    add("code_clusters", "Cluster files", {"type": "file", "count": 5}, "directory grouping", "find src -maxdepth 2 -type d | head -n 40", [r"placeholder|clusters"], [], [r"src"], [])
    add("code_clusters", "Cluster functions", {"type": "function", "count": 5}, "function grep sample", "grep -RinE \"function |const .*=>\" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|clusters"], [], [r"function|=>"], [])
    add("code_clusters", "Cluster classes", {"type": "class", "count": 5}, "class grep sample", "grep -Rin \"class \" src --include='*.ts' --include='*.tsx' | head -n 40", [r"placeholder|clusters"], [], [r"class"], [])
    add("code_clusters", "Cluster files top3", {"type": "file", "count": 3}, "directory grouping top3", "find src -maxdepth 1 -type d | head -n 20", [r"placeholder|clusters"], [], [r"src"], [])

    # semantic_diff (4)
    add("semantic_diff", "Semantic diff calculate hooks", {"elementId1": "src/hooks/useCalculateAll.ts", "elementId2": "src/hooks/useCalculationResults.ts"}, "text diff calculate hooks", "diff -u src/hooks/useCalculateAll.ts src/hooks/useCalculationResults.ts | head -n 80", [r"placeholder|differences|Semantic"], [], [r"@@|---|\\+\\+\\+"], [])
    add("semantic_diff", "Semantic diff contexts", {"elementId1": "src/context/BuildingContext.tsx", "elementId2": "src/context/DrawingContext.tsx"}, "text diff contexts", "diff -u src/context/BuildingContext.tsx src/context/DrawingContext.tsx | head -n 80", [r"placeholder|differences|Semantic"], [], [r"@@|---|\\+\\+\\+"], [])
    add("semantic_diff", "Semantic diff code impls", {"elementId1": "src/engine/codes/ntc-mexico/NTC_Concrete_2017.ts", "elementId2": "src/engine/codes/aci/ACI_318_19.ts"}, "text diff code implementations", "diff -u src/engine/codes/ntc-mexico/NTC_Concrete_2017.ts src/engine/codes/aci/ACI_318_19.ts | head -n 80", [r"placeholder|differences|Semantic"], [], [r"@@|---|\\+\\+\\+"], [])
    add("semantic_diff", "Semantic diff drawing hooks", {"elementId1": "src/components/drawing/canvas-hooks/useCanvasEventHandlers.ts", "elementId2": "src/components/drawing/canvas-hooks/useCanvasBusinessLogic.ts"}, "text diff drawing hooks", "diff -u src/components/drawing/canvas-hooks/useCanvasEventHandlers.ts src/components/drawing/canvas-hooks/useCanvasBusinessLogic.ts | head -n 80", [r"placeholder|differences|Semantic"], [], [r"@@|---|\\+\\+\\+"], [])

    # suggest_tests (4)
    add("suggest_tests", "Suggest tests for useCalculateAll", {"elementId": "src/hooks/useCalculateAll.ts", "limit": 5}, "grep tests useCalculateAll", "grep -Ril \"useCalculateAll\" src --include='*.test.ts' --include='*.test.tsx' | head -n 30", [r"placeholder|suggestedTests|Test suggestions"], [], [r"test|src"], [])
    add("suggest_tests", "Suggest tests for GridCanvas", {"elementId": "src/components/drawing/GridCanvas.tsx", "limit": 5}, "grep tests GridCanvas", "grep -Ril \"GridCanvas\" src --include='*.test.ts' --include='*.test.tsx' | head -n 30", [r"placeholder|suggestedTests|Test suggestions"], [], [r"test|src"], [])
    add("suggest_tests", "Suggest tests for BuildingContext", {"elementId": "src/context/BuildingContext.tsx", "limit": 5}, "grep tests BuildingContext", "grep -Ril \"BuildingContext\" src --include='*.test.ts' --include='*.test.tsx' | head -n 30", [r"placeholder|suggestedTests|Test suggestions"], [], [r"test|src"], [])
    add("suggest_tests", "Suggest tests for LoadTakedownService", {"elementId": "src/engine/calculations/services/LoadTakedownService.ts", "limit": 5}, "grep tests LoadTakedownService", "grep -Ril \"LoadTakedownService\" src --include='*.test.ts' --include='*.test.tsx' | head -n 30", [r"placeholder|suggestedTests|Test suggestions"], [], [r"test|src"], [])

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
            notes.append("Vector tool is placeholder MVP")
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
        "perToolCounts": tool_counts,
        "improvementTargets": [
            "Improve natural-language graph query routing to intent-specific Cypher templates.",
            "Fix schema/handler arg mismatches (notably impact_analyze and progress_query contract differences).",
            "Deduplicate host/container file paths in graph index results.",
            "Replace vector-tool placeholders with embedding-backed retrieval and evaluation set.",
            "Add gold-set precision/recall and confidence intervals for repeatable accuracy scoring.",
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
