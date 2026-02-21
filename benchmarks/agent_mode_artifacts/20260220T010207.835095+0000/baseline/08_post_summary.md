# post_summary

- objective: Re-summarize project state from documentation and codebase only (excluding reverted synthetic diffs) to compare retention quality across methods.
- context_boundary: Fresh context reset: docs + codebase only, no execution diffs.
- documentation_targets: graph://summary/post, docs/agent-mode-baseline-post-summary.md

name=structural-app
docs_md_files=26
src_ts_files=527
src_tsx_files=165
tooling=dev,build,lint,tsc,fix,preview,test,test:watch,test:coverage,format,format:check,graph:build,graph:query,graph:validate,test:affected,graph:install-hooks,graph:uninstall-hooks,graph:docker:up,graph:docker:down,graph:docker:status
readme_head=# stratSolver

A web-based structural engineering tool for designing and analyzing reinforced concrete buildings. Draw your floor plans on an interactive canvas, place columns, slabs, beams, and footings, then get code-compliant design calculations and a full 3D finite element analysis — all in the browser.

## What It Does

### Interactive Floor Plan Drawing

The central workspace is a 2D grid canvas where you design your building floor by floor. Use the tool palette to:

- **Place columns** wi
graph_signal=
