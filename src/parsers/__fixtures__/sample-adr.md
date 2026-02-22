# ADR-002: Use Memgraph as Graph Database

Date: 2025-01-15
Status: Accepted

## Context

The project needs a graph database that supports:

- Cypher query language
- Community detection algorithms (Leiden)
- Full-text search via `text_search.search`
- Docker deployment via `memgraph/memgraph-mage`

We evaluated Neo4j, ArangoDB, and Memgraph.

## Decision

We will use **Memgraph** with the MAGE extension pack.

The `MemgraphClient` class wraps all database calls. The `GraphOrchestrator` is
responsible for building and persisting the code graph.

```cypher
MATCH (f:FUNCTION {projectId: $pid})
RETURN f.name, f.filePath
LIMIT 100
```

## Consequences

### Good

- Zero-cost community detection via `community_detection.get`
- Native BM25 via `text_search.search`
- Compatible with existing `CypherStatement` interface

### Bad

- Requires Docker for local development
- Less community support than Neo4j

## Alternatives Considered

- [Neo4j](https://neo4j.com) — heavier, requires GDS plugin for algorithms
- ArangoDB — multi-model but Cypher not supported
