#!/usr/bin/env python3
import argparse
import sqlite3
from pathlib import Path
from typing import Dict, List

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "benchmarks/graph_tools_benchmark.sqlite"


def read_summary(conn: sqlite3.Connection, run_id: str) -> Dict[str, str]:
    rows = conn.execute(
        "SELECT metric, value FROM benchmark_summary WHERE run_id = ?",
        (run_id,),
    ).fetchall()
    return {metric: value for metric, value in rows}


def to_int(summary: Dict[str, str], key: str) -> int:
    return int(float(summary.get(key, "0")))


def main() -> None:
    parser = argparse.ArgumentParser(description="Check benchmark regression against previous run")
    parser.add_argument("--db", default=str(DB_PATH), help="Path to benchmark sqlite db")
    parser.add_argument("--max-token-regression", type=int, default=5, help="Allowed decrease for mcpLowerTokens")
    parser.add_argument("--max-speed-regression", type=int, default=2, help="Allowed decrease for mcpFaster")
    parser.add_argument("--max-accuracy-regression", type=int, default=1, help="Allowed decrease for mcpHigherAccuracy")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    conn = sqlite3.connect(db_path)
    try:
        run_ids = [
            row[0]
            for row in conn.execute(
                "SELECT run_id FROM benchmark_runs ORDER BY generated_at DESC LIMIT 2"
            ).fetchall()
        ]

        if len(run_ids) < 2:
            print("[benchmark-regression] Only one run found; skipping regression gate.")
            return

        latest, previous = run_ids[0], run_ids[1]
        latest_summary = read_summary(conn, latest)
        previous_summary = read_summary(conn, previous)

        deltas = {
            "mcpLowerTokens": to_int(latest_summary, "mcpLowerTokens") - to_int(previous_summary, "mcpLowerTokens"),
            "mcpFaster": to_int(latest_summary, "mcpFaster") - to_int(previous_summary, "mcpFaster"),
            "mcpHigherAccuracy": to_int(latest_summary, "mcpHigherAccuracy") - to_int(previous_summary, "mcpHigherAccuracy"),
        }

        print("[benchmark-regression] latest:", latest)
        print("[benchmark-regression] previous:", previous)
        print("[benchmark-regression] deltas:", deltas)

        failures: List[str] = []
        if deltas["mcpLowerTokens"] < -args.max_token_regression:
            failures.append(
                f"mcpLowerTokens regressed by {deltas['mcpLowerTokens']} (limit {-args.max_token_regression})"
            )
        if deltas["mcpFaster"] < -args.max_speed_regression:
            failures.append(
                f"mcpFaster regressed by {deltas['mcpFaster']} (limit {-args.max_speed_regression})"
            )
        if deltas["mcpHigherAccuracy"] < -args.max_accuracy_regression:
            failures.append(
                f"mcpHigherAccuracy regressed by {deltas['mcpHigherAccuracy']} (limit {-args.max_accuracy_regression})"
            )

        if failures:
            print("[benchmark-regression] FAILED")
            for failure in failures:
                print(f"- {failure}")
            raise SystemExit(1)

        print("[benchmark-regression] PASSED")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
