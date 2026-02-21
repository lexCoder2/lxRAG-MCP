#!/usr/bin/env python3
import argparse
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "benchmarks/graph_tools_benchmark.sqlite"


@dataclass
class ModelSpec:
    key: str
    display_name: str
    provider: str
    tier: str
    execution_hint: str


@dataclass
class ModelScenario:
    scenario_id: str
    title: str
    prompt: str
    expected_keywords: List[str]


MODEL_CATALOG: Dict[str, ModelSpec] = {
    "haiku": ModelSpec(
        key="haiku",
        display_name="Claude Haiku",
        provider="anthropic",
        tier="fast",
        execution_hint="Use your Anthropic runner for Haiku model variant",
    ),
    "sonnet-4.5": ModelSpec(
        key="sonnet-4.5",
        display_name="Claude Sonnet 4.5",
        provider="anthropic",
        tier="balanced",
        execution_hint="Use your Anthropic runner for Sonnet 4.5",
    ),
    "gpt-4.1": ModelSpec(
        key="gpt-4.1",
        display_name="GPT-4.1",
        provider="openai",
        tier="balanced",
        execution_hint="Use your OpenAI runner for gpt-4.1",
    ),
    "opus-4.6": ModelSpec(
        key="opus-4.6",
        display_name="Claude Opus 4.6 (non-fast)",
        provider="anthropic",
        tier="quality",
        execution_hint="Use non-fast Opus 4.6 profile; avoid latency-optimized fast variant",
    ),
    "gemini-3-pro": ModelSpec(
        key="gemini-3-pro",
        display_name="Gemini 3 Pro",
        provider="google",
        tier="quality",
        execution_hint="Use Gemini Pro tier endpoint",
    ),
}


def build_model_scenarios() -> List[ModelScenario]:
    return [
        ModelScenario(
            scenario_id="M001",
            title="Dependency tracing for LoginPage",
            prompt=(
                "Find all files that import LoginPage and return a concise list with reason for each file. "
                "Prefer relation-aware answers over raw grep output."
            ),
            expected_keywords=["LoginPage", "App.tsx", "import"],
        ),
        ModelScenario(
            scenario_id="M002",
            title="Architecture violation triage",
            prompt=(
                "Given a React+TypeScript repo with layer rules, identify top architecture violations and propose fixes. "
                "Output in JSON with severity and file path."
            ),
            expected_keywords=["violations", "severity", "file"],
        ),
        ModelScenario(
            scenario_id="M003",
            title="Impacted tests from hook changes",
            prompt=(
                "Changed files: src/hooks/useCalculateAll.ts and src/hooks/useBuildingState.ts. "
                "Select impacted tests and justify direct vs transitive impact."
            ),
            expected_keywords=["test", "impact", "direct"],
        ),
        ModelScenario(
            scenario_id="M004",
            title="Code placement suggestion",
            prompt=(
                "Suggest where to place a new hook named useBeamSizing with dependencies useBuildingState and useCalculateAll. "
                "Return target layer and path."
            ),
            expected_keywords=["layer", "path", "hook"],
        ),
        ModelScenario(
            scenario_id="M005",
            title="Load takedown semantic retrieval",
            prompt=(
                "Find core files implementing load takedown logic and summarize why each file matters. "
                "Keep response under 10 bullets."
            ),
            expected_keywords=["load", "takedown", "service"],
        ),
        ModelScenario(
            scenario_id="M006",
            title="Blocking issues dashboard",
            prompt=(
                "Produce a blocking-issues summary for current engineering work with risk, owner, and next action fields. "
                "Use compact table-like text."
            ),
            expected_keywords=["blocking", "risk", "next action"],
        ),
    ]


def init_model_tables(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS model_benchmark_runs (
          run_id TEXT PRIMARY KEY,
          generated_at TEXT NOT NULL,
          status TEXT NOT NULL,
          notes TEXT
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS model_catalog (
          model_key TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          provider TEXT NOT NULL,
          tier TEXT NOT NULL,
          execution_hint TEXT NOT NULL
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS model_scenarios (
          scenario_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          expected_keywords TEXT NOT NULL
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS model_benchmark_results (
          run_id TEXT NOT NULL,
          model_key TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          status TEXT NOT NULL,
          latency_ms REAL,
          accuracy REAL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          total_tokens INTEGER,
          response_preview TEXT,
          error_message TEXT,
          PRIMARY KEY (run_id, model_key, scenario_id)
        )
        """
    )

    cur.execute(
        """
        CREATE VIEW IF NOT EXISTS latest_model_plan AS
        WITH latest AS (
          SELECT run_id
          FROM model_benchmark_runs
          ORDER BY generated_at DESC
          LIMIT 1
        )
        SELECT
          r.model_key,
          c.display_name,
          c.provider,
          c.tier,
          r.status,
          COUNT(*) AS scenarios
        FROM model_benchmark_results r
        JOIN latest l ON r.run_id = l.run_id
        JOIN model_catalog c ON c.model_key = r.model_key
        GROUP BY r.model_key, c.display_name, c.provider, c.tier, r.status
        ORDER BY r.model_key
        """
    )


def upsert_catalog(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    for model in MODEL_CATALOG.values():
        cur.execute(
            """
            INSERT INTO model_catalog(model_key, display_name, provider, tier, execution_hint)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(model_key) DO UPDATE SET
              display_name=excluded.display_name,
              provider=excluded.provider,
              tier=excluded.tier,
              execution_hint=excluded.execution_hint
            """,
            (model.key, model.display_name, model.provider, model.tier, model.execution_hint),
        )


def upsert_scenarios(conn: sqlite3.Connection, scenarios: List[ModelScenario]) -> None:
    cur = conn.cursor()
    for scenario in scenarios:
        cur.execute(
            """
            INSERT INTO model_scenarios(scenario_id, title, prompt, expected_keywords)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(scenario_id) DO UPDATE SET
              title=excluded.title,
              prompt=excluded.prompt,
              expected_keywords=excluded.expected_keywords
            """,
            (scenario.scenario_id, scenario.title, scenario.prompt, json.dumps(scenario.expected_keywords)),
        )


def create_plan(conn: sqlite3.Connection, selected_models: List[str], scenarios: List[ModelScenario], notes: str) -> str:
    run_id = datetime.now(timezone.utc).isoformat().replace(":", "").replace("-", "")
    cur = conn.cursor()

    cur.execute(
        "INSERT INTO model_benchmark_runs(run_id, generated_at, status, notes) VALUES(?, ?, ?, ?)",
        (run_id, datetime.now(timezone.utc).isoformat(), "PLANNED", notes),
    )

    for model_key in selected_models:
        for scenario in scenarios:
            cur.execute(
                """
                INSERT INTO model_benchmark_results(
                  run_id, model_key, scenario_id, status,
                  latency_ms, accuracy, input_tokens, output_tokens, total_tokens,
                  response_preview, error_message
                ) VALUES(?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
                """,
                (run_id, model_key, scenario.scenario_id, "PLANNED"),
            )

    conn.commit()
    return run_id


def parse_models(value: str) -> List[str]:
    requested = [token.strip().lower() for token in value.split(",") if token.strip()]
    normalized: List[str] = []
    for token in requested:
        key = "sonnet-4.5" if token in {"sonet-4.5", "sonet", "sonnet"} else token
        key = "opus-4.6" if token in {"opus", "opus-4.6", "opus 4.6"} else key
        key = "gemini-3-pro" if token in {"gemini", "gemini-pro", "gemini 3 pro"} else key
        key = "gpt-4.1" if token in {"gpt", "gpt4.1", "gpt-4.1"} else key
        key = "haiku" if token in {"haiku", "claude-haiku"} else key

        if key not in MODEL_CATALOG:
            raise ValueError(f"Unknown model key: {token}")
        normalized.append(key)
    return normalized


def main() -> None:
    parser = argparse.ArgumentParser(description="Plan or execute multi-model benchmark runs")
    parser.add_argument(
        "--models",
        default="haiku,sonnet-4.5,gpt-4.1,opus-4.6,gemini-3-pro",
        help="Comma-separated model keys",
    )
    parser.add_argument(
        "--plan-only",
        action="store_true",
        default=True,
        help="Create planned benchmark rows only (default true)",
    )
    parser.add_argument(
        "--notes",
        default="Planned model benchmark run (no execution)",
        help="Notes for this run",
    )

    args = parser.parse_args()
    selected_models = parse_models(args.models)

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)

    init_model_tables(conn)
    upsert_catalog(conn)
    scenarios = build_model_scenarios()
    upsert_scenarios(conn, scenarios)

    if args.plan_only:
        run_id = create_plan(conn, selected_models, scenarios, args.notes)
        print(f"Planned model benchmark run: {run_id}")
        print(f"Database: {DB_PATH}")
        print(f"Models: {', '.join(selected_models)}")
        print(f"Scenarios per model: {len(scenarios)}")
        print(f"Total planned rows: {len(selected_models) * len(scenarios)}")
        print("Execution status: NOT RUN (plan-only)")

    conn.close()


if __name__ == "__main__":
    main()
