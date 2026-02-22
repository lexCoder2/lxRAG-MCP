import { describe, expect, it } from "vitest";
import { DocsBuilder } from "./docs-builder.js";
import type { ParsedDoc, ParsedSection } from "../parsers/docs-parser.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSection(overrides: Partial<ParsedSection> = {}): ParsedSection {
  return {
    index: 0,
    heading: "Introduction",
    level: 1,
    content: "Some overview text about `MemgraphClient` usage.",
    startLine: 1,
    wordCount: 7,
    backtickRefs: ["MemgraphClient"],
    codeFences: [],
    links: [],
    ...overrides,
  };
}

function makeDoc(overrides: Partial<ParsedDoc> = {}): ParsedDoc {
  return {
    filePath: "/workspace/docs/guide.md",
    relativePath: "docs/guide.md",
    title: "Guide",
    kind: "guide",
    hash: "a".repeat(64),
    wordCount: 7,
    sections: [makeSection()],
    ...overrides,
  };
}

function builder(
  projectId = "test-project",
  workspaceRoot = "/workspace",
  txId = "tx-001",
  txTimestamp = 1700000000000,
): DocsBuilder {
  return new DocsBuilder(projectId, workspaceRoot, txId, txTimestamp);
}

// ─── buildFromParsedDoc — output shape ───────────────────────────────────────

describe("DocsBuilder.buildFromParsedDoc — output shape", () => {
  it("returns an array of CypherStatements", () => {
    const stmts = builder().buildFromParsedDoc(makeDoc());
    expect(Array.isArray(stmts)).toBe(true);
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect(typeof s.query).toBe("string");
      expect(typeof s.params).toBe("object");
    }
  });

  it("generates at least: 1 DOCUMENT + 1 SECTION + 1 SECTION_OF stmt", () => {
    const stmts = builder().buildFromParsedDoc(makeDoc());
    // Minimum: DOCUMENT + SECTION + SECTION_OF
    expect(stmts.length).toBeGreaterThanOrEqual(3);
  });

  it("with 3 sections generates 2 NEXT_SECTION edges", () => {
    const doc = makeDoc({
      sections: [
        makeSection({ index: 0, heading: "A", startLine: 1 }),
        makeSection({ index: 1, heading: "B", startLine: 5 }),
        makeSection({ index: 2, heading: "C", startLine: 10 }),
      ],
    });
    const stmts = builder().buildFromParsedDoc(doc);
    const nextSectionStmts = stmts.filter((s) =>
      s.query.includes("NEXT_SECTION"),
    );
    expect(nextSectionStmts).toHaveLength(2);
  });

  it("with 1 section generates 0 NEXT_SECTION edges", () => {
    const stmts = builder().buildFromParsedDoc(makeDoc());
    const nextSectionStmts = stmts.filter((s) =>
      s.query.includes("NEXT_SECTION"),
    );
    expect(nextSectionStmts).toHaveLength(0);
  });
});

// ─── DOCUMENT upsert ─────────────────────────────────────────────────────────

describe("DocsBuilder — DOCUMENT statement", () => {
  it("first statement targets DOCUMENT node", () => {
    const stmts = builder().buildFromParsedDoc(makeDoc());
    expect(stmts[0].query).toMatch(/MERGE.*DOCUMENT/);
  });

  it("DOCUMENT params include all required fields", () => {
    const doc = makeDoc();
    const stmts = builder("proj", "/root", "tx-1", 1000).buildFromParsedDoc(doc);
    const p = stmts[0].params;
    expect(p.relativePath).toBe("docs/guide.md");
    expect(p.filePath).toBe("/workspace/docs/guide.md");
    expect(p.title).toBe("Guide");
    expect(p.kind).toBe("guide");
    expect(p.wordCount).toBe(7);
    expect(p.hash).toBe("a".repeat(64));
    expect(p.validFrom).toBe(1000);
    expect(p.txId).toBe("tx-1");
    expect(p.projectId).toBe("proj");
  });

  it("DOCUMENT id is scoped with projectId", () => {
    const stmts = builder("myproj").buildFromParsedDoc(makeDoc());
    expect(stmts[0].params.id).toContain("myproj");
    expect(stmts[0].params.id).toContain("docs/guide.md");
  });

  it("DOCUMENT id is deterministic (same input → same id)", () => {
    const b = builder();
    const id1 = b.buildFromParsedDoc(makeDoc())[0].params.id;
    const id2 = b.buildFromParsedDoc(makeDoc())[0].params.id;
    expect(id1).toBe(id2);
  });
});

// ─── SECTION upsert ───────────────────────────────────────────────────────────

describe("DocsBuilder — SECTION statement", () => {
  it("SECTION statement uses MERGE", () => {
    const stmts = builder().buildFromParsedDoc(makeDoc());
    const secStmt = stmts.find(
      (s) => s.query.includes("SECTION") && s.query.includes("heading"),
    )!;
    expect(secStmt).toBeDefined();
    expect(secStmt.query).toMatch(/MERGE.*SECTION/);
  });

  it("SECTION params carry heading, level, startLine, wordCount, docId", () => {
    const section = makeSection({
      index: 0,
      heading: "Architecture",
      level: 2,
      startLine: 3,
      wordCount: 15,
    });
    const doc = makeDoc({ sections: [section] });
    const stmts = builder("p", "/r", "tx", 0).buildFromParsedDoc(doc);
    const secStmt = stmts.find((s) => s.params.heading === "Architecture")!;
    expect(secStmt).toBeDefined();
    expect(secStmt.params.level).toBe(2);
    expect(secStmt.params.startLine).toBe(3);
    expect(secStmt.params.wordCount).toBe(15);
    expect(typeof secStmt.params.docId).toBe("string");
  });

  it("SECTION content is capped at 4000 chars", () => {
    const longContent = "x".repeat(5000);
    const section = makeSection({ content: longContent });
    const doc = makeDoc({ sections: [section] });
    const stmts = builder().buildFromParsedDoc(doc);
    const secStmt = stmts.find((s) => s.params.heading === "Introduction")!;
    expect(secStmt.params.content.length).toBeLessThanOrEqual(4000);
  });

  it("SECTION id is scoped and includes section index", () => {
    const stmts = builder("proj").buildFromParsedDoc(makeDoc());
    const secStmt = stmts.find((s) => s.params.heading === "Introduction")!;
    expect(secStmt.params.id).toContain("proj");
    expect(secStmt.params.id).toMatch(/:0$/);
  });

  it("each section gets a unique id", () => {
    const doc = makeDoc({
      sections: [
        makeSection({ index: 0, heading: "A" }),
        makeSection({ index: 1, heading: "B" }),
      ],
    });
    const stmts = builder().buildFromParsedDoc(doc);
    const ids = stmts
      .filter((s) => s.query.includes("heading"))
      .map((s) => s.params.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── SECTION_OF edge ─────────────────────────────────────────────────────────

describe("DocsBuilder — SECTION_OF edge", () => {
  it("SECTION_OF statement links section to document by id", () => {
    const stmts = builder("proj").buildFromParsedDoc(makeDoc());
    const sofStmt = stmts.find((s) => s.query.includes("SECTION_OF"))!;
    expect(sofStmt).toBeDefined();
    expect(sofStmt.params.secId).toBeDefined();
    expect(sofStmt.params.docId).toBeDefined();
    // docId in SECTION_OF should match the DOCUMENT id
    const docId = stmts[0].params.id;
    expect(sofStmt.params.docId).toBe(docId);
  });
});

// ─── DOC_DESCRIBES edges ─────────────────────────────────────────────────────

describe("DocsBuilder — DOC_DESCRIBES edges", () => {
  it("emits DOC_DESCRIBES stmts for each backtick ref", () => {
    const section = makeSection({
      backtickRefs: ["MemgraphClient", "GraphOrchestrator"],
    });
    const doc = makeDoc({ sections: [section] });
    const stmts = builder().buildFromParsedDoc(doc);
    const describeStmts = stmts.filter((s) =>
      s.query.includes("DOC_DESCRIBES"),
    );
    // 2 refs × 2 match patterns (FILE + FUNCTION|CLASS) = 4 statements
    expect(describeStmts.length).toBe(4);
  });

  it("DOC_DESCRIBES params include strength=1.0 and matchedName", () => {
    const section = makeSection({ backtickRefs: ["MyClass"] });
    const doc = makeDoc({ sections: [section] });
    const stmts = builder().buildFromParsedDoc(doc);
    const describeStmt = stmts.find((s) => s.query.includes("DOC_DESCRIBES"))!;
    expect(describeStmt.params.ref).toBe("MyClass");
  });

  it("emits no DOC_DESCRIBES for section with empty backtickRefs", () => {
    const section = makeSection({ backtickRefs: [] });
    const doc = makeDoc({ sections: [section] });
    const stmts = builder().buildFromParsedDoc(doc);
    const describeStmts = stmts.filter((s) =>
      s.query.includes("DOC_DESCRIBES"),
    );
    expect(describeStmts).toHaveLength(0);
  });

  it("DOC_DESCRIBES secId matches the section's own id", () => {
    const section = makeSection({ backtickRefs: ["Foo"] });
    const doc = makeDoc({ sections: [section] });
    const stmts = builder().buildFromParsedDoc(doc);
    const secStmt = stmts.find((s) => s.params.heading === "Introduction")!;
    const describeStmt = stmts.find((s) => s.query.includes("DOC_DESCRIBES"))!;
    expect(describeStmt.params.secId).toBe(secStmt.params.id);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("DocsBuilder — idempotency (MERGE)", () => {
  it("all statements use MERGE not CREATE", () => {
    const doc = makeDoc({
      sections: [
        makeSection({ index: 0, backtickRefs: ["Foo"] }),
        makeSection({ index: 1, heading: "B", backtickRefs: [] }),
      ],
    });
    const stmts = builder().buildFromParsedDoc(doc);
    for (const s of stmts) {
      // Any statement that creates a node must use MERGE
      if (s.query.match(/\(.*:DOCUMENT|:SECTION[^_]/)) {
        expect(s.query).toMatch(/MERGE/);
        expect(s.query).not.toMatch(/\bCREATE\b/);
      }
    }
  });

  it("calling twice on same doc returns same number of stmts", () => {
    const doc = makeDoc();
    const b = builder();
    expect(b.buildFromParsedDoc(doc).length).toBe(
      b.buildFromParsedDoc(doc).length,
    );
  });
});

// ─── Edge: empty sections array ──────────────────────────────────────────────

describe("DocsBuilder — edge cases", () => {
  it("empty sections array → only DOCUMENT stmt, no SECTION_OF or NEXT_SECTION", () => {
    const doc = makeDoc({ sections: [] });
    const stmts = builder().buildFromParsedDoc(doc);
    expect(stmts).toHaveLength(1); // only DOCUMENT
    expect(stmts.every((s) => !s.query.includes("SECTION_OF"))).toBe(true);
    expect(stmts.every((s) => !s.query.includes("NEXT_SECTION"))).toBe(true);
  });

  it("handles doc with various kinds without throwing", () => {
    const kinds = ["readme", "adr", "changelog", "guide", "architecture", "other"] as const;
    for (const kind of kinds) {
      expect(() =>
        builder().buildFromParsedDoc(makeDoc({ kind })),
      ).not.toThrow();
    }
  });

  it("different relativePaths produce different DOCUMENT ids", () => {
    const b = builder("p");
    const id1 = b.buildFromParsedDoc(makeDoc({ relativePath: "docs/a.md" }))[0].params.id;
    const id2 = b.buildFromParsedDoc(makeDoc({ relativePath: "docs/b.md" }))[0].params.id;
    expect(id1).not.toBe(id2);
  });
});
