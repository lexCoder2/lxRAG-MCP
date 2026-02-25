# Plans, Pending Actions, and Execution Priorities

## Purpose

This document merges the main planning artifacts into one actionable execution summary with clear priorities, dependencies, and acceptance criteria.

---

## Source Plans Consolidated

- `docs/ACTION_PLAN_LXRAG_TOOL_FIXES.md`
- `docs/REVISED_ACTION_PLAN_WITH_CLI_ANALYSIS.md`
- `docs/COMPREHENSIVE_REVIEW_AND_REVISED_PLAN.md`
- `docs/AGENT_CONTEXT_ENGINE_PLAN.md`
- `RESOLUTION_PLAN.md`
- `ANALYSIS_WORKFLOW.md`

---

## Current Planning Reality

The repository contains both:

- records of substantial completed implementation work, and
- remaining plan backlogs marked as draft or pending.

To avoid stale-status ambiguity, this summary uses a **forward execution model**: what still yields the highest operational value now.

---

## Priority Backlog

## P0 — Must complete first

### 1) Enforce graph/index readiness gates

Actions:
- Ensure startup/diagnostic flow hard-fails clearly when graph/index is stale or unavailable.
- Standardize health/readiness checks before dependent tool execution paths.

Acceptance criteria:
- Clear, deterministic readiness state available before analysis tools run.
- Error envelope includes direct remediation hints.

Dependencies:
- Graph orchestrator and health modules.

### 2) Eliminate workspace/session ambiguity in operational docs

Actions:
- Normalize host vs container path guidance into one canonical section.
- Ensure quickstart/integration docs use the same examples and sequence.

Acceptance criteria:
- One unambiguous onboarding path for native and Docker workflows.
- Reduced first-run failures due to path/session mismatch.

Dependencies:
- `README.md`, `QUICK_START.md`, `docs/MCP_INTEGRATION_GUIDE.md`.

---

## P1 — High-value hardening

### 3) Contract strictness and argument normalization sweep

Actions:
- Run contract validations for all tools and normalize edge-case argument handling.
- Align tool envelopes for consistent downstream parsing.

Acceptance criteria:
- No category-level contract drift in integration checks.
- Stable response shape across all profile levels.

Dependencies:
- `src/tools/registry.ts`, handler modules, response schemas.

### 4) Add failure-mode integration tests for lifecycle transitions

Actions:
- Add test coverage for graph rebuild in-progress state, session reconnect, and stale index scenarios.
- Include both stdio and HTTP mode assumptions where feasible.

Acceptance criteria:
- Reproducible tests that prevent regressions in known failure families.

Dependencies:
- Existing integration scripts and test harness.

---

## P2 — Consolidation and maintainability

### 5) Documentation governance cleanup

Actions:
- Designate canonical docs for tools/features/audits/plans.
- Archive or clearly mark superseded plan/audit snapshots.

Acceptance criteria:
- New contributors can identify “current truth” in under 5 minutes.
- Reduced duplication and contradictory status statements.

Dependencies:
- docs index and maintainers’ update cadence.

### 6) Observability and KPI cadence

Actions:
- Define a recurring KPI set: rebuild latency, health failures, contract failures, benchmark drift.
- Publish periodic summary in docs.

Acceptance criteria:
- Comparable metric snapshots across releases.

Dependencies:
- benchmark scripts and graph health instrumentation.

---

## Suggested Execution Order (Practical)

1. P0.1 readiness gates
2. P0.2 onboarding path normalization
3. P1.3 contract sweep
4. P1.4 lifecycle failure-mode tests
5. P2.5 docs governance
6. P2.6 KPI cadence

This order minimizes user-facing instability first, then hardens integration reliability, then improves long-term maintainability.

---

## 2-Week Implementation Slice (Recommended)

### Week 1
- Complete P0.1 and P0.2.
- Validate with integration smoke checks and revised onboarding docs.

### Week 2
- Complete P1.3 and first pass of P1.4.
- Publish short status update against acceptance criteria.

Carry P2 items as rolling maintenance after reliability baseline is stable.

---

## Tracking Template

Use this minimal status grid in PRs/issues:

| Item | Priority | Owner | Status | Evidence |
|---|---|---|---|---|
| Readiness gates | P0 | TBD | Not Started / In Progress / Done | Test + logs |
| Onboarding normalization | P0 | TBD | Not Started / In Progress / Done | Updated docs |
| Contract sweep | P1 | TBD | Not Started / In Progress / Done | Validation output |
| Lifecycle tests | P1 | TBD | Not Started / In Progress / Done | Test reports |
| Docs governance | P2 | TBD | Not Started / In Progress / Done | Doc index updates |
| KPI cadence | P2 | TBD | Not Started / In Progress / Done | Periodic summary |
