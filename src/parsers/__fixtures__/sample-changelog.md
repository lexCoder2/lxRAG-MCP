# Changelog

All notable changes to `lxDIG-MCP` are documented here.

## [1.3.0] - 2026-02-21

### Added

- `DocsEngine` for markdown/ADR indexing
- `index_docs` and `search_docs` MCP tools
- `DOCUMENT` and `SECTION` node types in graph schema

### Changed

- `GraphOrchestrator` now accepts `indexDocs` option in `BuildOptions`
- `HybridRetriever` now includes `SECTION` nodes in BM25 and vector search

## [1.2.0] - 2026-01-10

### Added

- `EpisodeEngine` for agent memory persistence
- `CoordinationEngine` for multi-agent `agent_claim`/`agent_release`

### Fixed

- `MemgraphClient` connection timeout on slow Docker startup

## [1.1.0] - 2025-12-01

### Added

- Tree-sitter parsers for TypeScript, JavaScript, Python, Go, Rust, Java
- `CommunityDetector` using Leiden algorithm via Memgraph MAGE
- `HybridRetriever` with RRF fusion of vector + BM25 + graph

## [1.0.0] - 2025-11-01

Initial release.

- `GraphOrchestrator` with incremental rebuild
- `TestEngine` for test impact analysis
- `ProgressEngine` for task tracking
