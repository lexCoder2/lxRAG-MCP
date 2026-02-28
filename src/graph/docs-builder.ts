/**
 * @file graph/docs-builder
 * @description Converts parsed markdown docs into idempotent Cypher graph statements.
 * @remarks Mirrors graph builder conventions for consistent write behavior.
 */

import * as path from "node:path";
import type { ParsedDoc, ParsedSection } from "../parsers/docs-parser.js";
import type { CypherStatement } from "./builder.js";
import * as env from "../env.js";

// ─── Re-export CypherStatement for callers who import only this module ────────
export type { CypherStatement };

export class DocsBuilder {
  private readonly projectId: string;
  private readonly workspaceRoot: string;
  private readonly txId: string;
  private readonly txTimestamp: number;

  constructor(projectId?: string, workspaceRoot?: string, txId?: string, txTimestamp?: number) {
    this.workspaceRoot = workspaceRoot ?? env.LXRAG_WORKSPACE_ROOT ?? process.cwd();
    this.projectId = projectId ?? env.LXRAG_PROJECT_ID ?? path.basename(this.workspaceRoot);
    this.txId = txId ?? env.LXRAG_TX_ID ?? `tx-${Date.now()}`;
    this.txTimestamp = txTimestamp ?? Date.now();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Build all Cypher statements to upsert one markdown document and its
   * sections into the graph.  All statements are MERGE-based (idempotent).
   *
   * Schema produced:
   *   (DOCUMENT { id, relativePath, filePath, title, kind, wordCount, hash,
   *                projectId, validFrom, validTo, txId })
   *   (SECTION  { id, heading, level, content, wordCount, startLine,
   *                docId, projectId })
   *   SECTION -[:SECTION_OF]-> DOCUMENT
   *   SECTIONₙ -[:NEXT_SECTION]-> SECTIONₙ₊₁
   *   SECTION -[:DOC_DESCRIBES { strength, matchedName }]-> FILE|FUNCTION|CLASS
   */
  buildFromParsedDoc(doc: ParsedDoc): CypherStatement[] {
    const stmts: CypherStatement[] = [];
    const docId = this.docId(doc.relativePath);

    stmts.push(this.upsertDocument(docId, doc));

    const sectionIds: string[] = [];
    for (const section of doc.sections) {
      const secId = this.sectionId(doc.relativePath, section.index);
      sectionIds.push(secId);
      stmts.push(this.upsertSection(secId, docId, section, doc.relativePath));
      stmts.push(this.upsertSectionOf(secId, docId));
    }

    // Chain NEXT_SECTION edges
    for (let i = 0; i < sectionIds.length - 1; i++) {
      stmts.push(this.upsertNextSection(sectionIds[i], sectionIds[i + 1]));
    }

    // DOC_DESCRIBES edges from backtickRefs
    for (const section of doc.sections) {
      const secId = this.sectionId(doc.relativePath, section.index);
      for (const ref of section.backtickRefs) {
        stmts.push(...this.upsertDocDescribes(secId, ref, doc.relativePath));
      }
    }

    return stmts;
  }

  // ── Node / edge builders ────────────────────────────────────────────────────

  private upsertDocument(docId: string, doc: ParsedDoc): CypherStatement {
    return {
      query: `
MERGE (d:DOCUMENT { id: $id, projectId: $projectId })
SET d.relativePath = $relativePath,
    d.filePath     = $filePath,
    d.title        = $title,
    d.kind         = $kind,
    d.wordCount    = $wordCount,
    d.hash         = $hash,
    d.validFrom    = $validFrom,
    d.validTo      = 9999999999999,
    d.txId         = $txId
`,
      params: {
        id: docId,
        projectId: this.projectId,
        relativePath: doc.relativePath,
        filePath: doc.filePath,
        title: doc.title,
        kind: doc.kind,
        wordCount: doc.wordCount,
        hash: doc.hash,
        validFrom: this.txTimestamp,
        txId: this.txId,
      },
    };
  }

  private upsertSection(
    secId: string,
    docId: string,
    section: ParsedSection,
    relativePath: string,
  ): CypherStatement {
    return {
      query: `
MERGE (s:SECTION { id: $id, projectId: $projectId })
SET s.heading      = $heading,
    s.level        = $level,
    s.content      = $content,
    s.wordCount    = $wordCount,
    s.startLine    = $startLine,
    s.docId        = $docId,
    s.relativePath = $relativePath,
    s.txId         = $txId
`,
      params: {
        id: secId,
        projectId: this.projectId,
        heading: section.heading,
        level: section.level,
        // Trim content to 4000 chars to stay within Memgraph string property limits
        content: section.content.slice(0, 4000),
        wordCount: section.wordCount,
        startLine: section.startLine,
        docId,
        relativePath,
        txId: this.txId,
      },
    };
  }

  private upsertSectionOf(secId: string, docId: string): CypherStatement {
    return {
      query: `
MATCH (s:SECTION { id: $secId, projectId: $projectId })
MATCH (d:DOCUMENT { id: $docId, projectId: $projectId })
MERGE (s)-[:SECTION_OF]->(d)
`,
      params: { secId, docId, projectId: this.projectId },
    };
  }

  private upsertNextSection(fromId: string, toId: string): CypherStatement {
    return {
      query: `
MATCH (a:SECTION { id: $fromId, projectId: $projectId })
MATCH (b:SECTION { id: $toId,   projectId: $projectId })
MERGE (a)-[:NEXT_SECTION]->(b)
`,
      params: { fromId, toId, projectId: this.projectId },
    };
  }

  /**
   * Emit DOC_DESCRIBES edges from a section to any graph nodes whose name
   * matches the backtick reference.
   *
   * Strength rules:
   *   1.0 — exact backtick match to a name property on FILE/FUNCTION/CLASS
   *   (The 0.9 code-fence-path and 0.6 prose-word-boundary variants are
   *    produced by the engine layer which has richer context.)
   */
  private upsertDocDescribes(secId: string, ref: string, _docRelPath: string): CypherStatement[] {
    const stmts: CypherStatement[] = [];

    // Match FILE nodes by relativePath ending with the ref
    stmts.push({
      query: `
MATCH (target:FILE { projectId: $projectId })
WHERE target.relativePath = $ref OR target.relativePath ENDS WITH $slash_ref
MATCH (s:SECTION { id: $secId, projectId: $projectId })
MERGE (s)-[r:DOC_DESCRIBES]->(target)
SET r.strength = 1.0, r.matchedName = $ref
`,
      params: {
        secId,
        projectId: this.projectId,
        ref,
        slash_ref: `/${ref}`,
      },
    });

    // Match FUNCTION or CLASS nodes by name
    stmts.push({
      query: `
MATCH (target { projectId: $projectId })
WHERE (target:FUNCTION OR target:CLASS) AND target.name = $ref
MATCH (s:SECTION { id: $secId, projectId: $projectId })
MERGE (s)-[r:DOC_DESCRIBES]->(target)
SET r.strength = 1.0, r.matchedName = $ref
`,
      params: {
        secId,
        projectId: this.projectId,
        ref,
      },
    });

    return stmts;
  }

  // ── ID helpers ───────────────────────────────────────────────────────────────

  private docId(relativePath: string): string {
    return `${this.projectId}:doc:${relativePath}`;
  }

  private sectionId(relativePath: string, index: number): string {
    return `${this.projectId}:sec:${relativePath}:${index}`;
  }
}
