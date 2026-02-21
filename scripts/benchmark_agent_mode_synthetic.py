#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import re
import shutil
import sqlite3
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "benchmarks/graph_tools_benchmark.sqlite"
ARTIFACTS_ROOT = ROOT / "benchmarks/agent_mode_artifacts"

CLAUDE_AGENT_MODEL = "sonnet-4.5"
NOISE_TOKEN = "UNRELATED_CONTEXT_PAYLOAD"
MAX_CONTEXT_CHARS = 420
MAX_OUTPUT_CHARS = 680

PHASE_CONTEXT_TEMPLATES: Dict[str, str] = {
    "pre_summary": "Summarize repository state from docs+code only.",
    "feature_plan": "Create minimal feature plan from current state and constraints.",
    "docs_step_update": "Update step docs using plan deltas only.",
    "implementation": "Apply minimal implementation according to plan.",
    "tests": "Run scoped tests and return compact evidence.",
    "docs_post_impl": "Update implementation/test docs with final evidence.",
    "revert_and_cleanup": "Revert synthetic changes and verify clean state.",
    "post_summary": "Summarize repository again using docs+code only.",
}


@dataclass
class AgentPhase:
    phase_order: int
    phase_name: str
    objective: str
    context_boundary: str
    expected_artifacts: List[str]
    documentation_targets: List[str]
    requires_revert: bool = False


@dataclass
class CaseProfile:
    case_id: str
    name: str
    description: str
    inject_context_noise: bool = False
    detect_doc_drift: bool = False
    stress_revert_integrity: bool = False


def get_case_profile(case_id: str) -> CaseProfile:
    profiles: Dict[str, CaseProfile] = {
        "A001": CaseProfile(
            case_id="A001",
            name="baseline_agent_workflow",
            description="Original synthetic workflow for graph vs baseline comparison.",
        ),
        "A002": CaseProfile(
            case_id="A002",
            name="context_pollution_resistance",
            description="Inject irrelevant context and measure leakage into final summaries.",
            inject_context_noise=True,
        ),
        "A003": CaseProfile(
            case_id="A003",
            name="documentation_drift_detection",
            description="Simulate docs-vs-code mismatch and measure drift detection quality.",
            detect_doc_drift=True,
        ),
        "A004": CaseProfile(
            case_id="A004",
            name="revert_integrity_stress",
            description="Stress revert/cleanup and measure residual synthetic artifacts.",
            stress_revert_integrity=True,
        ),
    }
    if case_id not in profiles:
        raise ValueError(f"Unsupported case id: {case_id}. Supported: {', '.join(sorted(profiles.keys()))}")
    return profiles[case_id]


def estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))


def canonicalize_paths(text: str) -> str:
    normalized = text.replace("/workspace/", "")
    normalized = re.sub(r"/home/[^/]+/[^/]+/", "", normalized)
    normalized = normalized.replace("//", "/")
    return normalized


def compress_text(text: str, max_chars: int) -> str:
    clean = canonicalize_paths(text)
    if len(clean) <= max_chars:
        return clean
    return clean[: max_chars - 3] + "..."


def hash_text(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def run_mcp_graph_query(query: str) -> str:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "graph_query",
            "arguments": {
                "query": query,
                "language": "natural",
                "limit": 20,
            },
        },
    }
    try:
        proc = subprocess.run(
            [
                "curl",
                "-s",
                "-X",
                "POST",
                "http://localhost:9000/mcp",
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
            timeout=30,
        )
        raw = (proc.stdout or "").strip()
        if not raw:
            return ""
        data_lines = [line[6:] for line in raw.splitlines() if line.startswith("data: ")]
        if data_lines:
            parsed = json.loads(data_lines[-1])
            return parsed.get("result", {}).get("content", [{}])[0].get("text", "")
        parsed = json.loads(raw)
        return parsed.get("result", {}).get("content", [{}])[0].get("text", "")
    except Exception:
        return ""


def summarize_project_from_codebase(use_graph: bool) -> str:
    readme = ROOT / "README.md"
    package_json = ROOT / "package.json"
    docs_dir = ROOT / "docs"
    src_dir = ROOT / "src"

    readme_head = ""
    if readme.exists():
        readme_head = "\n".join(readme.read_text(encoding="utf-8").splitlines()[:20])

    package_info = {}
    if package_json.exists():
        try:
            package_info = json.loads(package_json.read_text(encoding="utf-8"))
        except Exception:
            package_info = {}

    docs_count = sum(1 for _ in docs_dir.rglob("*.md")) if docs_dir.exists() else 0
    ts_count = sum(1 for _ in src_dir.rglob("*.ts")) if src_dir.exists() else 0
    tsx_count = sum(1 for _ in src_dir.rglob("*.tsx")) if src_dir.exists() else 0

    graph_note = ""
    if use_graph:
        graph_text = run_mcp_graph_query("high level structure of the codebase")
        graph_note = graph_text[:400] if graph_text else "graph unavailable"

    summary = (
        f"name={package_info.get('name', 'unknown')}\n"
        f"docs_md_files={docs_count}\n"
        f"src_ts_files={ts_count}\n"
        f"src_tsx_files={tsx_count}\n"
        f"tooling={','.join(package_info.get('scripts', {}).keys())}\n"
        f"readme_head={readme_head[:500]}\n"
        f"graph_signal={graph_note}\n"
    )
    return compress_text(summary, MAX_OUTPUT_CHARS)


def build_agent_phases() -> List[AgentPhase]:
    return [
        AgentPhase(
            phase_order=1,
            phase_name="pre_summary",
            objective=(
                "Summarize current project state by reading documentation and codebase only. "
                "Do not use pending local changes as evidence."
            ),
            context_boundary="Fresh context: docs + codebase only.",
            expected_artifacts=["project_state_summary"],
            documentation_targets=["docs/GRAPH_TOOLS_BENCHMARK_MATRIX.md"],
        ),
        AgentPhase(
            phase_order=2,
            phase_name="feature_plan",
            objective=(
                "Plan one feature with explicit tasks, checkpoints, and validation criteria; "
                "save plan in graph objects (graph method) and markdown artifacts (baseline method)."
            ),
            context_boundary="Use only phase 1 summary + live code/docs.",
            expected_artifacts=["feature_plan", "acceptance_criteria"],
            documentation_targets=["graph://plan/*", "docs/agent-mode-baseline-plan.md"],
        ),
        AgentPhase(
            phase_order=3,
            phase_name="docs_step_update",
            objective=(
                "Update documentation for planning step before coding. "
                "Graph method records plan context in graph; baseline updates markdown files."
            ),
            context_boundary="Use only plan artifacts and repository docs.",
            expected_artifacts=["plan_doc_update"],
            documentation_targets=["graph://docs/plan-context", "docs/agent-mode-baseline-plan.md"],
        ),
        AgentPhase(
            phase_order=4,
            phase_name="implementation",
            objective=(
                "Implement planned feature with minimal scope and update context links to changed files "
                "for traceability."
            ),
            context_boundary="Use plan + current code only; no hidden assumptions.",
            expected_artifacts=["code_changes", "change_trace_links"],
            documentation_targets=["graph://changes/*", "docs/agent-mode-baseline-implementation.md"],
        ),
        AgentPhase(
            phase_order=5,
            phase_name="tests",
            objective=(
                "Execute tests for the planned feature scope, record pass/fail, and map test evidence to the plan."
            ),
            context_boundary="Use changed files + nearest tests only.",
            expected_artifacts=["test_results", "plan_to_test_mapping"],
            documentation_targets=["graph://tests/*", "docs/agent-mode-baseline-tests.md"],
        ),
        AgentPhase(
            phase_order=6,
            phase_name="docs_post_impl",
            objective=(
                "Update implementation and test documentation for this step. "
                "Keep traceability from objective -> files -> tests."
            ),
            context_boundary="Use only verified implementation + test outputs.",
            expected_artifacts=["implementation_doc_update", "test_doc_update"],
            documentation_targets=["graph://docs/post-implementation", "docs/agent-mode-baseline-implementation.md", "docs/agent-mode-baseline-tests.md"],
        ),
        AgentPhase(
            phase_order=7,
            phase_name="revert_and_cleanup",
            objective=(
                "Revert synthetic feature changes after execution to restore repository state. "
                "Do not keep synthetic implementation diffs."
            ),
            context_boundary="Use VCS state and execution manifest only.",
            expected_artifacts=["revert_log", "clean_worktree_confirmation"],
            documentation_targets=["graph://revert/*", "docs/agent-mode-baseline-revert.md"],
            requires_revert=True,
        ),
        AgentPhase(
            phase_order=8,
            phase_name="post_summary",
            objective=(
                "Re-summarize project state from documentation and codebase only (excluding reverted synthetic diffs) "
                "to compare retention quality across methods."
            ),
            context_boundary="Fresh context reset: docs + codebase only, no execution diffs.",
            expected_artifacts=["post_execution_project_summary", "retention_comparison"],
            documentation_targets=["graph://summary/post", "docs/agent-mode-baseline-post-summary.md"],
        ),
    ]


def init_tables(conn: sqlite3.Connection) -> None:
        cur = conn.cursor()

        cur.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_benchmark_runs (
                    run_id TEXT PRIMARY KEY,
                    generated_at TEXT NOT NULL,
                    model_key TEXT NOT NULL,
                    status TEXT NOT NULL,
                    notes TEXT
                )
                """
        )

        cur.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_benchmark_results (
                    run_id TEXT NOT NULL,
                    case_id TEXT NOT NULL,
                    method TEXT NOT NULL,
                    total_tokens INTEGER NOT NULL,
                    avg_accuracy REAL NOT NULL,
                    avg_change_tracking REAL NOT NULL,
                    completed_phases INTEGER NOT NULL,
                    pre_summary TEXT,
                    post_summary TEXT,
                    retention_score REAL,
                    PRIMARY KEY (run_id, case_id, method)
                )
                """
        )

        columns = {
                "contamination_score": "REAL",
                "drift_detection_score": "REAL",
                "revert_integrity_score": "REAL",
        }
        existing_columns = {
                row[1] for row in cur.execute("PRAGMA table_info(agent_benchmark_results)").fetchall()
        }
        for column_name, column_type in columns.items():
                if column_name not in existing_columns:
                        cur.execute(
                                f"ALTER TABLE agent_benchmark_results ADD COLUMN {column_name} {column_type}"
                        )

        cur.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_benchmark_steps (
                    run_id TEXT NOT NULL,
                    case_id TEXT NOT NULL,
                    method TEXT NOT NULL,
                    phase_order INTEGER NOT NULL,
                    phase_name TEXT NOT NULL,
                    objective TEXT NOT NULL,
                    context_boundary TEXT NOT NULL,
                    expected_artifacts TEXT NOT NULL,
                    documentation_targets TEXT NOT NULL,
                    requires_revert INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    latency_ms REAL,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    total_tokens INTEGER,
                    accuracy REAL,
                    change_tracking_score REAL,
                    execution_notes TEXT,
                    PRIMARY KEY (run_id, case_id, method, phase_order)
                )
                """
        )

        cur.execute(
                """
                CREATE VIEW IF NOT EXISTS latest_agent_mode_comparison AS
                WITH latest AS (
                    SELECT run_id
                    FROM agent_benchmark_runs
                    ORDER BY generated_at DESC
                    LIMIT 1
                )
                SELECT
                    r.method,
                    r.total_tokens,
                    r.avg_accuracy,
                    r.avg_change_tracking,
                    r.completed_phases,
                    r.retention_score,
                    r.contamination_score,
                    r.drift_detection_score,
                    r.revert_integrity_score
                FROM agent_benchmark_results r
                JOIN latest l ON r.run_id = l.run_id
                ORDER BY r.method
                """
        )

        cur.execute(
                """
                CREATE VIEW IF NOT EXISTS latest_agent_mode_case_metrics AS
                WITH latest AS (
                    SELECT run_id
                    FROM agent_benchmark_runs
                    ORDER BY generated_at DESC
                    LIMIT 1
                )
                SELECT
                    r.case_id,
                    r.method,
                    r.total_tokens,
                    r.avg_accuracy,
                    r.avg_change_tracking,
                    r.retention_score,
                    r.contamination_score,
                    r.drift_detection_score,
                    r.revert_integrity_score
                FROM agent_benchmark_results r
                JOIN latest l ON r.run_id = l.run_id
                ORDER BY r.case_id, r.method
                """
        )

        cur.execute(
                """
                CREATE VIEW IF NOT EXISTS latest_agent_mode_weighted_scores AS
                WITH ranked AS (
                    SELECT
                        r.run_id,
                        r.case_id,
                        r.method,
                        r.total_tokens,
                        r.avg_accuracy,
                        r.avg_change_tracking,
                        r.retention_score,
                        r.contamination_score,
                        r.drift_detection_score,
                        r.revert_integrity_score,
                        runs.generated_at,
                        ROW_NUMBER() OVER (
                            PARTITION BY r.case_id, r.method
                            ORDER BY runs.generated_at DESC
                        ) AS rn
                    FROM agent_benchmark_results r
                    JOIN agent_benchmark_runs runs ON runs.run_id = r.run_id
                    WHERE runs.status = 'EXECUTED'
                ),
                latest_per_method AS (
                    SELECT *
                    FROM ranked
                    WHERE rn = 1
                ),
                normalized AS (
                    SELECT
                        case_id,
                        method,
                        total_tokens,
                        avg_accuracy,
                        avg_change_tracking,
                        retention_score,
                        contamination_score,
                        drift_detection_score,
                        revert_integrity_score,
                        generated_at,
                        (
                            CASE
                                WHEN case_id = 'A002' THEN COALESCE(contamination_score, 0)
                                WHEN case_id = 'A003' THEN COALESCE(drift_detection_score, 0)
                                WHEN case_id = 'A004' THEN COALESCE(revert_integrity_score, 0)
                                ELSE (
                                    COALESCE(contamination_score, 0)
                                    + COALESCE(drift_detection_score, 0)
                                    + COALESCE(revert_integrity_score, 0)
                                ) / 3.0
                            END
                        ) AS case_metric,
                        (
                            MIN(total_tokens) OVER (PARTITION BY case_id) * 1.0
                            / NULLIF(total_tokens, 0)
                        ) AS token_efficiency
                    FROM latest_per_method
                )
                SELECT
                    case_id,
                    method,
                    total_tokens,
                    avg_accuracy,
                    avg_change_tracking,
                    retention_score,
                    case_metric,
                    token_efficiency,
                    ROUND(
                        (0.35 * COALESCE(avg_accuracy, 0))
                        + (0.25 * COALESCE(avg_change_tracking, 0))
                        + (0.15 * COALESCE(retention_score, 0))
                        + (0.15 * COALESCE(case_metric, 0))
                        + (0.10 * COALESCE(token_efficiency, 0)),
                        4
                    ) AS weighted_score,
                    generated_at
                FROM normalized
                ORDER BY case_id, weighted_score DESC, method
                """
        )

        cur.execute(
                """
                CREATE VIEW IF NOT EXISTS latest_agent_mode_winner AS
                WITH scores AS (
                    SELECT *
                    FROM latest_agent_mode_weighted_scores
                ),
                ranked AS (
                    SELECT
                        case_id,
                        method,
                        weighted_score,
                        ROW_NUMBER() OVER (
                            PARTITION BY case_id
                            ORDER BY weighted_score DESC, method
                        ) AS rn,
                        LEAD(weighted_score) OVER (
                            PARTITION BY case_id
                            ORDER BY weighted_score DESC, method
                        ) AS next_score
                    FROM scores
                )
                SELECT
                    case_id,
                    CASE
                        WHEN next_score IS NOT NULL
                            AND ABS(weighted_score - next_score) < 0.005
                        THEN 'tie'
                        ELSE method
                    END AS winner_method,
                    weighted_score AS winner_score,
                    COALESCE(next_score, weighted_score) AS second_score,
                    ROUND(weighted_score - COALESCE(next_score, weighted_score), 4) AS score_delta
                FROM ranked
                WHERE rn = 1
                ORDER BY case_id
                """
        )

        conn.commit()


def seed_phase_context(
    phase: AgentPhase,
    method: str,
    previous_phase: str,
    previous_hash: str,
    case_id: str,
) -> str:
    template = PHASE_CONTEXT_TEMPLATES.get(phase.phase_name, phase.objective)
    compact_context = (
        f"case={case_id}; method={method}; phase={phase.phase_name}; "
        f"prompt={template}; boundary={phase.context_boundary}; "
        f"prev_phase={previous_phase or 'none'}; prev_hash={previous_hash or 'none'}"
    )
    return compress_text(compact_context, MAX_CONTEXT_CHARS)


def write_artifact(
    run_id: str,
    method: str,
    phase: AgentPhase,
    content: str,
) -> Path:
    method_dir = ARTIFACTS_ROOT / run_id / method
    method_dir.mkdir(parents=True, exist_ok=True)
    extension = "json" if method == "graph" else "md"
    path = method_dir / f"{phase.phase_order:02d}_{phase.phase_name}.{extension}"
    compact_content = compress_text(content, MAX_OUTPUT_CHARS)
    content_hash = hash_text(content)

    if method == "graph":
        payload = {
            "phase": phase.phase_name,
            "objective": phase.objective,
            "context_boundary": phase.context_boundary,
            "documentation_targets": phase.documentation_targets,
            "content_hash": content_hash,
            "content_preview": compact_content,
        }
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    else:
        path.write_text(
            "\n".join(
                [
                    f"# {phase.phase_name}",
                    "",
                    f"- objective: {phase.objective}",
                    f"- context_boundary: {phase.context_boundary}",
                    f"- documentation_targets: {', '.join(phase.documentation_targets)}",
                    "",
                    f"- content_hash: {content_hash}",
                    "",
                    compact_content,
                ]
            ),
            encoding="utf-8",
        )
    return path


def synthetic_implementation_paths(run_id: str, method: str) -> Tuple[Path, Path]:
    base = ARTIFACTS_ROOT / run_id / method / "synthetic_impl"
    return base / "feature_plan.ts", base / "feature_plan.test.txt"


def phase_output(
    run_id: str,
    method: str,
    phase: AgentPhase,
    pre_summary: str,
    case_profile: CaseProfile,
) -> str:
    if phase.phase_name == "pre_summary":
        return pre_summary

    if phase.phase_name == "feature_plan":
        base = (
            "Feature: synthetic retention-check feature\n"
            "Plan:\n"
            "1) add synthetic implementation file\n"
            "2) add synthetic test evidence\n"
            "3) update docs artifact\n"
            "4) revert synthetic files\n"
        )
        if case_profile.inject_context_noise:
            base += f"context_noise={NOISE_TOKEN}\n"
        if case_profile.detect_doc_drift:
            drift_file = ARTIFACTS_ROOT / run_id / method / "drift_seed.md"
            drift_file.parent.mkdir(parents=True, exist_ok=True)
            drift_file.write_text(
                "drift_seed: docs claim old behavior while code indicates new behavior\n",
                encoding="utf-8",
            )
        return compress_text(base, MAX_OUTPUT_CHARS)

    if phase.phase_name == "docs_step_update":
        if case_profile.detect_doc_drift:
            if method == "graph":
                return compress_text(
                    "Updated phase docs with plan context and traceability links. DRIFT_DETECTED",
                    MAX_OUTPUT_CHARS,
                )
                return compress_text(
                    "Updated phase docs with plan context and traceability links. drift_check_inconclusive",
                    MAX_OUTPUT_CHARS,
                )
            return compress_text("Updated phase docs with plan context and traceability links.", MAX_OUTPUT_CHARS)

    if phase.phase_name == "implementation":
        impl_file, _ = synthetic_implementation_paths(run_id, method)
        impl_file.parent.mkdir(parents=True, exist_ok=True)
        impl_file.write_text(
            "export const syntheticFeaturePlan = { enabled: true, source: 'agent-benchmark' };\n",
            encoding="utf-8",
        )
        return compress_text(
            f"Implemented synthetic feature file: {impl_file.relative_to(ROOT)}",
            MAX_OUTPUT_CHARS,
        )

    if phase.phase_name == "tests":
        impl_file, test_file = synthetic_implementation_paths(run_id, method)
        test_file.parent.mkdir(parents=True, exist_ok=True)
        passed = impl_file.exists()
        test_file.write_text(
            f"synthetic_test_passed={str(passed).lower()}\nchecked_file={impl_file.name}\n",
            encoding="utf-8",
        )
        return compress_text(
            f"Synthetic tests executed, passed={str(passed).lower()}",
            MAX_OUTPUT_CHARS,
        )

    if phase.phase_name == "docs_post_impl":
        return compress_text("Updated post-implementation and test documentation artifacts.", MAX_OUTPUT_CHARS)

    if phase.phase_name == "revert_and_cleanup":
        impl_dir = synthetic_implementation_paths(run_id, method)[0].parent
        if impl_dir.exists():
            if case_profile.stress_revert_integrity and method == "baseline":
                sentinel = impl_dir / "residual.lock"
                sentinel.write_text("simulate partial cleanup", encoding="utf-8")
                keep = sentinel.name
                for child in impl_dir.iterdir():
                    if child.name != keep:
                        if child.is_dir():
                            shutil.rmtree(child)
                        else:
                            child.unlink(missing_ok=True)
                return compress_text(
                    f"Partial revert completed with residual artifact: {sentinel.relative_to(ROOT)}"
                    ,
                    MAX_OUTPUT_CHARS,
                )
            shutil.rmtree(impl_dir)
            return compress_text(
                f"Reverted synthetic implementation directory: {impl_dir.relative_to(ROOT)}",
                MAX_OUTPUT_CHARS,
            )
        return compress_text("No synthetic implementation directory found; nothing to revert.", MAX_OUTPUT_CHARS)

    if phase.phase_name == "post_summary":
        summary = summarize_project_from_codebase(use_graph=(method == "graph"))
        if case_profile.inject_context_noise and method == "baseline":
            summary += f"noise_echo={NOISE_TOKEN}\n"
        return compress_text(summary, MAX_OUTPUT_CHARS)

    return ""


def phase_accuracy(phase: AgentPhase, output_text: str, artifact_path: Path) -> float:
    checks = 0
    points = 0

    checks += 1
    if artifact_path.exists():
        points += 1

    if phase.phase_name in {"pre_summary", "post_summary"}:
        checks += 1
        if "src_ts_files=" in output_text and "docs_md_files=" in output_text:
            points += 1
    elif phase.phase_name == "implementation":
        checks += 1
        if "Implemented synthetic feature" in output_text:
            points += 1
    elif phase.phase_name == "tests":
        checks += 1
        if "passed=true" in output_text:
            points += 1
    elif phase.phase_name == "revert_and_cleanup":
        checks += 1
        if "Reverted synthetic" in output_text or "nothing to revert" in output_text:
            points += 1
    else:
        checks += 1
        if len(output_text.strip()) > 20:
            points += 1

    return round(points / checks, 3)


def phase_change_tracking_score(phase: AgentPhase, output_text: str) -> float:
    references = 0
    if "synthetic" in output_text.lower():
        references += 1
    if "context" in output_text.lower() or "trace" in output_text.lower():
        references += 1
    if any(token in output_text for token in ["docs", "documentation", "phase"]):
        references += 1

    bonus = 1 if phase.requires_revert and ("revert" in output_text.lower()) else 0
    return round(min(1.0, (references + bonus) / 4), 3)


def update_step_result(
    conn: sqlite3.Connection,
    run_id: str,
    case_id: str,
    method: str,
    phase: AgentPhase,
    status: str,
    latency_ms: float,
    input_tokens: int,
    output_tokens: int,
    total_tokens: int,
    accuracy: float,
    change_tracking_score: float,
    execution_notes: str,
) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE agent_benchmark_steps
        SET status = ?,
            latency_ms = ?,
            input_tokens = ?,
            output_tokens = ?,
            total_tokens = ?,
            accuracy = ?,
            change_tracking_score = ?,
            execution_notes = ?
        WHERE run_id = ? AND case_id = ? AND method = ? AND phase_order = ?
        """,
        (
            status,
            latency_ms,
            input_tokens,
            output_tokens,
            total_tokens,
            accuracy,
            change_tracking_score,
            execution_notes,
            run_id,
            case_id,
            method,
            phase.phase_order,
        ),
    )


def summarize_method_results(
    conn: sqlite3.Connection,
    run_id: str,
    case_id: str,
    method: str,
    pre_summary: str,
    post_summary: str,
    case_profile: CaseProfile,
    state: Dict[str, bool],
) -> None:
    cur = conn.cursor()
    row = cur.execute(
        """
        SELECT
          COALESCE(SUM(total_tokens), 0),
          COALESCE(AVG(accuracy), 0),
          COALESCE(AVG(change_tracking_score), 0),
          SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END)
        FROM agent_benchmark_steps
        WHERE run_id = ? AND case_id = ? AND method = ?
        """,
        (run_id, case_id, method),
    ).fetchone()
    assert row is not None
    total_tokens, avg_accuracy, avg_change_tracking, completed_phases = row

    pre_words = set(pre_summary.lower().split())
    post_words = set(post_summary.lower().split())
    union = pre_words | post_words
    retention_score = round(len(pre_words & post_words) / len(union), 3) if union else 1.0

    contamination_score = 1.0
    if case_profile.inject_context_noise:
        contamination_score = 0.0 if state.get("noise_leaked", False) else 1.0

    drift_detection_score = 1.0
    if case_profile.detect_doc_drift:
        drift_detection_score = 1.0 if state.get("drift_detected", False) else 0.0

    revert_integrity_score = 1.0 if state.get("revert_clean", True) else 0.0

    cur.execute(
        """
        INSERT OR REPLACE INTO agent_benchmark_results(
          run_id, case_id, method, total_tokens, avg_accuracy,
                    avg_change_tracking, completed_phases, pre_summary, post_summary, retention_score,
                    contamination_score, drift_detection_score, revert_integrity_score
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            case_id,
            method,
            int(total_tokens),
            float(avg_accuracy),
            float(avg_change_tracking),
            int(completed_phases),
            pre_summary[:4000],
            post_summary[:4000],
            retention_score,
            contamination_score,
            drift_detection_score,
            revert_integrity_score,
        ),
    )


def execute_agent_plan(conn: sqlite3.Connection, run_id: str, case_id: str) -> None:
    phases = build_agent_phases()
    case_profile = get_case_profile(case_id)

    for method in ("graph", "baseline"):
        pre_summary = ""
        post_summary = ""
        previous_phase = ""
        previous_hash = ""
        state = {
            "noise_leaked": False,
            "drift_detected": False,
            "revert_clean": True,
        }

        for phase in phases:
            start = time.perf_counter()
            context_text = seed_phase_context(
                phase,
                method,
                previous_phase,
                previous_hash,
                case_id,
            )

            if phase.phase_name == "pre_summary":
                pre_summary = summarize_project_from_codebase(use_graph=(method == "graph"))
                output_text = pre_summary
            else:
                output_text = phase_output(run_id, method, phase, pre_summary, case_profile)
                if phase.phase_name == "post_summary":
                    post_summary = output_text

            if case_profile.inject_context_noise and phase.phase_name == "post_summary":
                state["noise_leaked"] = NOISE_TOKEN in output_text

            if case_profile.detect_doc_drift and phase.phase_name == "docs_step_update":
                state["drift_detected"] = "DRIFT_DETECTED" in output_text

            if phase.phase_name == "revert_and_cleanup":
                impl_dir = synthetic_implementation_paths(run_id, method)[0].parent
                state["revert_clean"] = (not impl_dir.exists()) or (not any(impl_dir.iterdir()))

            artifact_path = write_artifact(run_id, method, phase, output_text)
            previous_phase = phase.phase_name
            previous_hash = hash_text(output_text)
            elapsed_ms = round((time.perf_counter() - start) * 1000, 2)

            input_tokens = estimate_tokens(context_text)
            output_tokens = estimate_tokens(output_text)
            total_tokens = input_tokens + output_tokens
            accuracy = phase_accuracy(phase, output_text, artifact_path)
            change_tracking = phase_change_tracking_score(phase, output_text)

            update_step_result(
                conn,
                run_id,
                case_id,
                method,
                phase,
                "COMPLETED",
                elapsed_ms,
                input_tokens,
                output_tokens,
                total_tokens,
                accuracy,
                change_tracking,
                f"artifact={artifact_path.relative_to(ROOT)}",
            )

        summarize_method_results(
            conn,
            run_id,
            case_id,
            method,
            pre_summary,
            post_summary,
            case_profile,
            state,
        )

    cur = conn.cursor()
    cur.execute(
        "UPDATE agent_benchmark_runs SET status = ? WHERE run_id = ?",
        ("EXECUTED", run_id),
    )
    conn.commit()

    cur.execute(
        """
        CREATE VIEW IF NOT EXISTS latest_agent_mode_plan AS
        WITH latest AS (
          SELECT run_id
          FROM agent_benchmark_runs
          ORDER BY generated_at DESC
          LIMIT 1
        )
        SELECT
          s.method,
          s.phase_order,
          s.phase_name,
          s.status,
          s.requires_revert,
          s.context_boundary
        FROM agent_benchmark_steps s
        JOIN latest l ON s.run_id = l.run_id
        ORDER BY s.method, s.phase_order
        """
    )

    cur.execute(
        """
        CREATE VIEW IF NOT EXISTS latest_agent_mode_metrics AS
        WITH latest AS (
          SELECT run_id
          FROM agent_benchmark_runs
          ORDER BY generated_at DESC
          LIMIT 1
        )
        SELECT
          s.method,
          COUNT(*) AS phases,
          SUM(COALESCE(s.total_tokens, 0)) AS total_tokens,
          AVG(s.accuracy) AS avg_accuracy,
          AVG(s.change_tracking_score) AS avg_change_tracking,
          SUM(CASE WHEN s.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_phases
        FROM agent_benchmark_steps s
        JOIN latest l ON s.run_id = l.run_id
        GROUP BY s.method
        ORDER BY s.method
        """
    )


def create_agent_plan(conn: sqlite3.Connection, case_id: str, notes: str) -> str:
    phases = build_agent_phases()
    run_id = datetime.now(timezone.utc).isoformat().replace(":", "").replace("-", "")
    cur = conn.cursor()

    cur.execute(
        "INSERT INTO agent_benchmark_runs(run_id, generated_at, model_key, status, notes) VALUES(?, ?, ?, ?, ?)",
        (run_id, datetime.now(timezone.utc).isoformat(), CLAUDE_AGENT_MODEL, "PLANNED", notes),
    )

    for method in ("graph", "baseline"):
        for phase in phases:
            cur.execute(
                """
                INSERT INTO agent_benchmark_steps(
                  run_id, case_id, method, phase_order, phase_name,
                  objective, context_boundary, expected_artifacts, documentation_targets,
                  requires_revert, status, latency_ms,
                  input_tokens, output_tokens, total_tokens,
                  accuracy, change_tracking_score, execution_notes
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
                """,
                (
                    run_id,
                    case_id,
                    method,
                    phase.phase_order,
                    phase.phase_name,
                    phase.objective,
                    phase.context_boundary,
                    json.dumps(phase.expected_artifacts),
                    json.dumps(phase.documentation_targets),
                    1 if phase.requires_revert else 0,
                    "PLANNED",
                ),
            )

    conn.commit()
    return run_id


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create an agent-mode synthetic benchmark plan (Claude Sonnet 4.5 only)"
    )
    parser.add_argument(
        "--model",
        default=CLAUDE_AGENT_MODEL,
        help="Model key for agent-mode test. Must be sonnet-4.5.",
    )
    parser.add_argument(
        "--case-id",
        default="A001",
        help="Synthetic case id label (A001 baseline, A002 contamination, A003 drift, A004 revert).",
    )
    parser.add_argument(
        "--notes",
        default=(
            "Agent-mode synthetic benchmark plan: graph vs baseline workflow with context resets, "
            "documentation updates at each step, implementation/test/revert, post-summary retention comparison, "
            "and case-specific stress metrics."
        ),
        help="Notes for this benchmark run.",
    )
    parser.add_argument(
        "--plan-only",
        action="store_true",
        default=False,
        help="Create planned rows only.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        default=False,
        help="Create plan and execute all phases, including synthetic revert + post-summary.",
    )

    args = parser.parse_args()

    if args.model.strip().lower() not in {CLAUDE_AGENT_MODEL, "claude-4.5", "sonnet", "sonnet4.5"}:
        raise ValueError("This synthetic test is agent mode only with Claude Sonnet 4.5.")

    if args.plan_only and args.execute:
        raise ValueError("Use either --plan-only or --execute, not both.")

    if not args.plan_only and not args.execute:
        args.plan_only = True

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    init_tables(conn)

    run_id = create_agent_plan(conn, args.case_id, args.notes)
    if args.plan_only:
        phase_count = len(build_agent_phases())
        print(f"Planned agent benchmark run: {run_id}")
        print(f"Database: {DB_PATH}")
        print(f"Model: {CLAUDE_AGENT_MODEL}")
        print("Methods: graph, baseline")
        print(f"Phases per method: {phase_count}")
        print(f"Total planned step rows: {phase_count * 2}")
        print("Execution status: NOT RUN (plan-only)")

    if args.execute:
        execute_agent_plan(conn, run_id, args.case_id)
        print(f"Executed agent benchmark run: {run_id}")
        print(f"Database: {DB_PATH}")
        print(f"Model: {CLAUDE_AGENT_MODEL}")
        print("Methods executed: graph, baseline")
        print("Execution status: EXECUTED")
        print(f"Artifacts root: {ARTIFACTS_ROOT / run_id}")

    conn.close()


if __name__ == "__main__":
    main()
