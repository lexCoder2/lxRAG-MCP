# Graph State Analysis - Complete Documentation Index

## Overview

This directory contains a comprehensive analysis of the graph state management system in lexRAG-MCP, specifically addressing multi-project support, context switching, index synchronization, and architecture patterns.

**Analysis Date**: February 22, 2026
**Scope**: Full codebase examination of graph state across initialization, context switching, rebuilding, and querying
**Focus**: Understanding index lifecycle and multi-project implications

---

## Document Guide

### 1. **GRAPH_STATE_QUICK_REF.txt** (12 KB) - START HERE
**Best for**: Quick answers to the 4 key questions

Quick reference guide with formatted sections:
- Question 1: Multiple projects setup
- Question 2: What happens on context switching
- Question 3: Graph rebuild behavior
- Question 4: Index initialization
- Core architecture issue summary
- Quick fixes ranked by priority
- Key file locations
- Risk assessment

**Read this if**: You want answers fast without deep dives

---

### 2. **GRAPH_STATE_SUMMARY.md** (13 KB) - EXECUTIVE SUMMARY
**Best for**: Understanding the big picture

Structured answer to your 4 questions with detailed explanations:
- Question-by-question breakdowns
- The core problem (two separate, unsynced indices)
- Design issues summary with examples
- Impact analysis (what works, what breaks)
- Recommended fixes with priority order
- Session management best practices
- Risk level assessment

**Read this if**: You want comprehensive answers with context

---

### 3. **GRAPH_STATE_ANALYSIS.md** (19 KB) - DEEP DIVE
**Best for**: Complete technical understanding

9 detailed sections covering:
1. Multiple Projects Setup (session-based architecture)
2. Project Context Switching (what changes vs. what doesn't)
3. Graph Rebuild Behavior (three separate indices)
4. Index Initialization (where it gets populated from)
5. Design Implications and Issues (the core problems)
6. Recommended Fixes (short, medium, long-term)
7. Current Tool Behavior (which tools work/fail)
8. Session Management Example (safe multi-project workflow)
9. Summary Table (component status overview)

**Read this if**: You need to understand the complete architecture

---

### 4. **GRAPH_STATE_DIAGRAMS.md** (24 KB) - VISUAL REFERENCE
**Best for**: Understanding architecture and data flow visually

8 ASCII diagrams showing:
1. Current index architecture (system layout)
2. Data flow during graph_rebuild (process steps)
3. Data flow during graph_set_workspace (context switching)
4. Tool context switching flow (session isolation)
5. Index population sources and sinks
6. Engine initialization and data flow
7. Session isolation (current vs. ideal)
8. Critical path analysis (3 key workflows)

**Read this if**: You're a visual learner or need to explain to others

---

### 5. **GRAPH_STATE_FIXES.md** (23 KB) - IMPLEMENTATION GUIDE
**Best for**: Actually implementing the fixes

3 levels of fixes with complete code examples:

**Fix Level 1: Immediate Quick Wins (1-2 hours)**
- 1.1: Clear index on context switch
- 1.2: Add projectId filters to queries

**Fix Level 2: Index Synchronization (3-4 hours)**
- 2.1: Export index from GraphOrchestrator
- 2.2: Sync orchestrator index after build
- 2.3: Load index from Memgraph on startup

**Fix Level 3: Project-Scoped Indices (8-10 hours)**
- 3.1: Project index management
- 3.2: Update graph_set_workspace
- 3.3: Update initializeEngines
- 3.4: Update graph_rebuild

Plus:
- Implementation roadmap (phases 1-3)
- Testing strategy (unit & integration tests)
- Validation checklist
- Performance considerations
- Rollback plan

**Read this if**: You're implementing the fixes

---

## Quick Navigation by Use Case

### "I need to understand the problem in 5 minutes"
→ Read: **GRAPH_STATE_QUICK_REF.txt**

### "I need to explain this to my team"
→ Read: **GRAPH_STATE_SUMMARY.md** + **GRAPH_STATE_DIAGRAMS.md**

### "I need to implement fixes"
→ Read: **GRAPH_STATE_FIXES.md**

### "I need complete technical details"
→ Read: **GRAPH_STATE_ANALYSIS.md** then **GRAPH_STATE_DIAGRAMS.md**

### "I need to debug graph state issues"
→ Read: **GRAPH_STATE_ANALYSIS.md** (section 2 & 3) + **GRAPH_STATE_DIAGRAMS.md** (diagram 1 & 2)

### "I need to add multi-project support safely"
→ Read: **GRAPH_STATE_SUMMARY.md** (session management) + **GRAPH_STATE_FIXES.md**

---

## Key Findings Summary

### The Core Issue
**Two separate, unsynced index systems:**
1. `ToolContext.index` - Shared, empty, used by engines
2. `GraphOrchestrator.index` - Internal, populated during build, then discarded
3. `Memgraph` - Database, source of truth, used by query tools

### Critical Problems
1. **Index Accumulation**: Shared index never cleared on project switch
2. **Orphaned Build State**: Orchestrator's populated index never synced back
3. **Startup Desync**: Shared index never populated from database
4. **Engine Stale State**: Engines reference empty index for entire server lifetime

### Immediate Impact
- ✅ Single-project workflows: SAFE
- ⚠️ Multi-project with sessions: RISKY (data contamination)
- ❌ Multi-project without sessions: DANGEROUS (data mixing)

### What Works
- Query tools (use Memgraph directly)
- FileWatcher (per-project monitoring)
- ProjectContext switching

### What Breaks
- Embedding generation (uses empty index)
- Progress tracking (reads empty index)
- Architecture validation (uses empty index)
- Multi-project data isolation

---

## Code Location Reference

| Component | File | Lines | Section |
|-----------|------|-------|---------|
| **ToolContext** | tool-handlers.ts | 41-46 | GRAPH_STATE_ANALYSIS §1 |
| **ProjectContext** | tool-handlers.ts | 48-52 | GRAPH_STATE_ANALYSIS §1 |
| **Session Management** | tool-handlers.ts | 69-106 | GRAPH_STATE_ANALYSIS §1 |
| **graph_set_workspace** | tool-handlers.ts | 1543-1615 | GRAPH_STATE_ANALYSIS §2 |
| **graph_rebuild** | tool-handlers.ts | 1617-1776 | GRAPH_STATE_ANALYSIS §3 |
| **initializeEngines** | tool-handlers.ts | 290-314 | GRAPH_STATE_ANALYSIS §7 |
| **Orchestrator** | orchestrator.ts | 70-176 | GRAPH_STATE_ANALYSIS §3 |
| **Orchestrator.build()** | orchestrator.ts | 181-423 | GRAPH_STATE_ANALYSIS §3 |
| **addToIndex()** | orchestrator.ts | 763-828 | GRAPH_STATE_ANALYSIS §3 |
| **GraphIndexManager** | index.ts | 35-178 | GRAPH_STATE_ANALYSIS §4 |
| **ProgressEngine** | progress-engine.ts | 59-96 | GRAPH_STATE_ANALYSIS §7 |
| **Server Init** | mcp-server.ts | 618-623 | GRAPH_STATE_ANALYSIS §4 |

---

## Recommended Reading Order

### For Quick Understanding (30 minutes)
1. GRAPH_STATE_QUICK_REF.txt (5 min)
2. GRAPH_STATE_DIAGRAMS.md - Diagram 1 (5 min)
3. GRAPH_STATE_DIAGRAMS.md - Diagram 2-3 (10 min)
4. GRAPH_STATE_SUMMARY.md - "Core Problem" section (10 min)

### For Complete Understanding (2 hours)
1. GRAPH_STATE_QUICK_REF.txt (10 min)
2. GRAPH_STATE_SUMMARY.md (30 min)
3. GRAPH_STATE_ANALYSIS.md (60 min)
4. GRAPH_STATE_DIAGRAMS.md (20 min)

### For Implementation (4 hours)
1. GRAPH_STATE_SUMMARY.md - "Recommended Fixes" (10 min)
2. GRAPH_STATE_FIXES.md - Fix Level 1 (30 min to implement)
3. GRAPH_STATE_FIXES.md - Fix Level 2 (60 min to implement)
4. GRAPH_STATE_FIXES.md - Testing Strategy (30 min)
5. GRAPH_STATE_FIXES.md - Validation Checklist (30 min)

---

## Changes Required by Fix Level

### Fix Level 1 (Stabilization - 30 min)
**Files affected**: 1
- `src/tools/tool-handlers.ts` (graph_set_workspace method)

**Result**: Prevents index accumulation on context switches

### Fix Level 2 (Synchronization - 2 hours)
**Files affected**: 2
- `src/graph/orchestrator.ts` (add getIndex method)
- `src/tools/tool-handlers.ts` (sync in graph_rebuild)

**Result**: Enables embedding and progress tracking

### Fix Level 3 (Refactoring - 8+ hours)
**Files affected**: All engines
- `src/tools/tool-handlers.ts` (complete redesign)
- All engine constructors

**Result**: Production-ready multi-project support

---

## Testing Resources

### Unit Test Examples
- Located in: GRAPH_STATE_FIXES.md - Testing Strategy
- Topics covered:
  - Index clearing on context switch
  - Index syncing after rebuild
  - Index loading from Memgraph

### Integration Test Examples
- Located in: GRAPH_STATE_FIXES.md - Testing Strategy
- Topics covered:
  - Multi-project workflow with sessions
  - Session isolation verification

### Validation Checklist
- Located in: GRAPH_STATE_FIXES.md - Validation Checklist
- 10-item checklist for post-implementation verification

---

## Questions Answered

### Question 1: Multiple Projects Setup
**Document**: GRAPH_STATE_SUMMARY.md - "1. Multiple Projects Setup"
**Diagram**: GRAPH_STATE_DIAGRAMS.md - Diagram 4

**Answer**: One project per session, multiple isolated sessions supported

### Question 2: Context Switching
**Document**: GRAPH_STATE_ANALYSIS.md - Section 2
**Diagram**: GRAPH_STATE_DIAGRAMS.md - Diagram 3
**Summary Table**: GRAPH_STATE_ANALYSIS.md - Section 9 (bottom)

**Answer**: ProjectContext updated, but shared index NOT cleared

### Question 3: Graph Rebuild
**Document**: GRAPH_STATE_ANALYSIS.md - Section 3
**Diagram**: GRAPH_STATE_DIAGRAMS.md - Diagram 2

**Answer**: Creates new index internally, never syncs back to shared index

### Question 4: Index Initialization
**Document**: GRAPH_STATE_ANALYSIS.md - Section 4
**Diagram**: GRAPH_STATE_DIAGRAMS.md - Diagram 5

**Answer**: Started empty, never populated from database

---

## Performance Impact Analysis

**Read**: GRAPH_STATE_FIXES.md - "Performance Considerations"

Topics:
- Index loading performance (lazy loading solution)
- Memory usage with multiple indices (cache eviction solution)
- Recommended env vars for tuning

---

## Rollback and Safety

**Read**: GRAPH_STATE_FIXES.md - "Rollback Plan"

Topics:
- Per-phase rollback instructions
- Feature flags for gradual deployment
- Low-risk implementation order

---

## Related Architecture Documentation

The following existing documentation may provide context:

- **ARCHITECTURE.md**: General system architecture
- **QUICK_REFERENCE.md**: Tool usage and API
- **QUICK_START.md**: Getting started guide

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-22 | Initial analysis and documentation |

---

## Glossary

**ToolContext**: Shared server-level context containing memgraph connection, shared index, and config

**ProjectContext**: Per-session project metadata (workspace root, source dir, project ID)

**GraphIndexManager**: In-memory graph index with nodes and relationships

**GraphOrchestrator**: Builder that parses files and generates Cypher statements

**Memgraph**: Graph database that serves as source of truth

**Session**: Client-specific context identified by mcp-session-id header

**Index Synchronization**: Process of copying data from one index to another

---

## Document Statistics

- **Total Documentation**: 91 KB (5 files)
- **Code Examples**: 45+
- **Diagrams**: 8
- **Tables**: 15+
- **Implementation Steps**: 30+
- **Test Cases**: 5+ examples
- **Code Locations Referenced**: 100+

---

## How to Use This Documentation

1. **Choose your document** based on your goal (see "Quick Navigation")
2. **Read the recommended sections** for your use case
3. **Reference the code locations** when examining the codebase
4. **Implement fixes** using the step-by-step guides
5. **Validate** using the provided checklists
6. **Test** using the example test cases

---

## Contributing

If you find issues with this analysis or implement the fixes:

1. Update the documentation with actual results
2. Add new diagrams if you discover new patterns
3. Share test results and performance metrics
4. Note any deviations from the predicted behavior

---

## Questions?

Refer to:
- **For architecture questions**: GRAPH_STATE_ANALYSIS.md
- **For visual understanding**: GRAPH_STATE_DIAGRAMS.md
- **For implementation help**: GRAPH_STATE_FIXES.md
- **For quick answers**: GRAPH_STATE_QUICK_REF.txt
- **For context**: GRAPH_STATE_SUMMARY.md

---

**Last Updated**: February 22, 2026
**Analysis Scope**: Complete lexRAG-MCP codebase
**Focus Area**: Graph state management and multi-project support
