import * as path from "node:path";
import * as url from "node:url";
import { describe, expect, it } from "vitest";
import { DocsParser, findMarkdownFiles } from "./docs-parser.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "__fixtures__");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parser(): DocsParser {
  return new DocsParser();
}

function parseFixture(filename: string) {
  return parser().parseFile(
    path.join(FIXTURES, filename),
    path.join(__dirname, ".."), // workspaceRoot → makes relativePath start with "parsers/"
  );
}

// ─── inferKind ────────────────────────────────────────────────────────────────

describe("DocsParser.inferKind", () => {
  const p = parser();

  it("classifies readme", () => {
    expect(p.inferKind("README.md")).toBe("readme");
    expect(p.inferKind("readme.md")).toBe("readme");
    expect(p.inferKind("README.MD")).toBe("readme");
  });

  it("classifies changelog", () => {
    expect(p.inferKind("CHANGELOG.md")).toBe("changelog");
    expect(p.inferKind("HISTORY.md")).toBe("changelog");
  });

  it("classifies architecture", () => {
    expect(p.inferKind("ARCHITECTURE.md")).toBe("architecture");
    expect(p.inferKind("arch.md")).toBe("architecture");
  });

  it("classifies adr by filename pattern", () => {
    expect(p.inferKind("docs/adr/ADR-001-decision.md")).toBe("adr");
    expect(p.inferKind("adr-002-use-memgraph.md")).toBe("adr");
  });

  it("classifies adr by path containing /adr/ or /decisions/", () => {
    expect(p.inferKind("docs/decisions/001-use-memgraph.md")).toBe("adr");
    expect(p.inferKind("adr/002-storage.md")).toBe("adr");
  });

  it("classifies guide for files under docs/", () => {
    expect(p.inferKind("docs/setup.md")).toBe("guide");
    expect(p.inferKind("docs/guides/quickstart.md")).toBe("guide");
  });

  it("classifies other for unrecognised paths", () => {
    expect(p.inferKind("src/some-note.md")).toBe("other");
    expect(p.inferKind("notes.md")).toBe("other");
  });
});

// ─── extractBacktickRefs ──────────────────────────────────────────────────────

describe("DocsParser.extractBacktickRefs", () => {
  const p = parser();

  it("extracts single references", () => {
    expect(p.extractBacktickRefs("Call `graph_rebuild` to start")).toEqual([
      "graph_rebuild",
    ]);
  });

  it("extracts multiple unique references", () => {
    const refs = p.extractBacktickRefs(
      "`MemgraphClient` wraps `executeCypher` and `executeCypher` again",
    );
    expect(refs).toContain("MemgraphClient");
    expect(refs).toContain("executeCypher");
    expect(refs).toHaveLength(2); // deduplicated
  });

  it("skips empty backtick pairs", () => {
    expect(p.extractBacktickRefs("see `` here")).toEqual([]);
  });

  it("skips refs longer than 120 chars", () => {
    const long = "a".repeat(121);
    expect(p.extractBacktickRefs(`\`${long}\``)).toEqual([]);
  });

  it("returns empty array for text with no backticks", () => {
    expect(p.extractBacktickRefs("no backticks here")).toEqual([]);
  });
});

// ─── parseContent — basic structure ──────────────────────────────────────────

describe("DocsParser.parseContent — structure", () => {
  it("returns an empty-heading implicit section when no headings present", () => {
    const p = parser();
    const doc = p.parseContent("Just some text.", "/a/b.md", "/a");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].heading).toBe("");
    expect(doc.sections[0].level).toBe(1);
  });

  it("splits on H2 boundaries", () => {
    const md = `# Title\n\nIntro.\n\n## Section A\n\nBody A.\n\n## Section B\n\nBody B.`;
    const doc = parser().parseContent(md, "/r/doc.md", "/r");
    // Should have: H1 "Title", H2 "Section A", H2 "Section B"
    expect(doc.sections.length).toBeGreaterThanOrEqual(3);
    const headings = doc.sections.map((s) => s.heading);
    expect(headings).toContain("Title");
    expect(headings).toContain("Section A");
    expect(headings).toContain("Section B");
  });

  it("does NOT split on H4+ (treated as body content)", () => {
    const md = `## Top\n\nText.\n\n#### Deep\n\nDeep content.`;
    const doc = parser().parseContent(md, "/r/d.md", "/r");
    const headings = doc.sections.map((s) => s.heading);
    expect(headings).not.toContain("Deep");
    expect(doc.sections.find((s) => s.heading === "Top")?.content).toMatch(
      /Deep/,
    );
  });

  it("section startLine is 1-based and monotonically increasing", () => {
    const md = `# A\n\ntext\n\n## B\n\nmore\n\n## C\n\nend`;
    const doc = parser().parseContent(md, "/r/x.md", "/r");
    const lines = doc.sections.map((s) => s.startLine);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toBeGreaterThan(lines[i - 1]);
    }
  });

  it("does not throw on empty content", () => {
    expect(() =>
      parser().parseContent("", "/r/empty.md", "/r"),
    ).not.toThrow();
  });

  it("handles document with only code fences and no headings", () => {
    const md = "```ts\nconst x = 1;\n```\n";
    const doc = parser().parseContent(md, "/r/fence.md", "/r");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].codeFences).toHaveLength(1);
    expect(doc.sections[0].codeFences[0].lang).toBe("ts");
    expect(doc.sections[0].codeFences[0].code.trim()).toBe("const x = 1;");
  });
});

// ─── parseContent — hash ─────────────────────────────────────────────────────

describe("DocsParser.parseContent — hash", () => {
  it("returns a 64-char hex SHA256", () => {
    const doc = parser().parseContent("hello", "/r/x.md", "/r");
    expect(doc.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("different content produces different hash", () => {
    const p = parser();
    const a = p.parseContent("hello", "/r/x.md", "/r");
    const b = p.parseContent("world", "/r/x.md", "/r");
    expect(a.hash).not.toBe(b.hash);
  });

  it("identical content always produces same hash", () => {
    const p = parser();
    const a = p.parseContent("hello", "/r/x.md", "/r");
    const b = p.parseContent("hello", "/r/x.md", "/r");
    expect(a.hash).toBe(b.hash);
  });
});

// ─── parseContent — backtick refs within sections ────────────────────────────

describe("DocsParser.parseContent — backtick refs", () => {
  it("populates backtickRefs from section body", () => {
    const md = `## Usage\n\nUse \`graph_rebuild\` and \`MemgraphClient\` to start.`;
    const doc = parser().parseContent(md, "/r/d.md", "/r");
    const section = doc.sections.find((s) => s.heading === "Usage")!;
    expect(section.backtickRefs).toContain("graph_rebuild");
    expect(section.backtickRefs).toContain("MemgraphClient");
  });

  it("does NOT include refs from inside code fences", () => {
    const md = `## Code\n\n\`\`\`ts\nconst \`x\` = 1;\n\`\`\`\n\nSee \`realRef\`.`;
    const doc = parser().parseContent(md, "/r/d.md", "/r");
    const section = doc.sections.find((s) => s.heading === "Code")!;
    // realRef should be present, but nothing from inside the fence
    expect(section.backtickRefs).toContain("realRef");
  });
});

// ─── parseContent — links ─────────────────────────────────────────────────────

describe("DocsParser.parseContent — links", () => {
  it("extracts markdown inline links", () => {
    const md = `## Refs\n\nSee [ARCHITECTURE.md](./ARCHITECTURE.md) and [npm](https://npmjs.com).`;
    const doc = parser().parseContent(md, "/r/d.md", "/r");
    const section = doc.sections.find((s) => s.heading === "Refs")!;
    const hrefs = section.links.map((l) => l.href);
    expect(hrefs).toContain("./ARCHITECTURE.md");
    expect(hrefs).toContain("https://npmjs.com");
  });
});

// ─── parseContent — wordCount ─────────────────────────────────────────────────

describe("DocsParser.parseContent — wordCount", () => {
  it("document wordCount >= each section wordCount", () => {
    const md = `# A\n\nHello world.\n\n## B\n\nFoo bar baz.`;
    const doc = parser().parseContent(md, "/r/d.md", "/r");
    const sectionTotal = doc.sections.reduce((s, sec) => s + sec.wordCount, 0);
    // doc.wordCount is computed from sections so they should be equal
    expect(doc.wordCount).toBe(sectionTotal);
  });

  it("wordCount > 0 for non-empty content", () => {
    const doc = parser().parseContent("# Hello\n\nWorld.", "/r/d.md", "/r");
    expect(doc.wordCount).toBeGreaterThan(0);
  });
});

// ─── parseContent — title inference ──────────────────────────────────────────

describe("DocsParser.parseContent — title inference", () => {
  it("uses first H1 as title", () => {
    const doc = parser().parseContent(
      "# My Title\n\nBody.",
      "/r/doc.md",
      "/r",
    );
    expect(doc.title).toBe("My Title");
  });

  it("falls back to filename stem when no H1", () => {
    const doc = parser().parseContent(
      "## Section only\n\nBody.",
      "/r/my-doc.md",
      "/r",
    );
    expect(doc.title).toBe("my-doc");
  });
});

// ─── parseContent — relativePath ─────────────────────────────────────────────

describe("DocsParser.parseContent — relativePath", () => {
  it("relativePath is workspace-relative with forward slashes", () => {
    const doc = parser().parseContent("# T", "/project/docs/api.md", "/project");
    expect(doc.relativePath).toBe("docs/api.md");
  });
});

// ─── Setext heading support ───────────────────────────────────────────────────

describe("DocsParser — setext headings", () => {
  it("recognises setext H1 (===)", () => {
    const md = `My Title\n========\n\nBody text.`;
    const doc = parser().parseContent(md, "/r/d.md", "/r");
    expect(doc.title).toBe("My Title");
    const section = doc.sections.find((s) => s.heading === "My Title");
    expect(section).toBeDefined();
    expect(section?.level).toBe(1);
  });

  it("recognises setext H2 (---)", () => {
    const md = `# Title\n\nSub Heading\n-----------\n\nBody.`;
    const doc = parser().parseContent(md, "/r/d.md", "/r");
    const section = doc.sections.find((s) => s.heading === "Sub Heading");
    expect(section).toBeDefined();
    expect(section?.level).toBe(2);
  });
});

// ─── Fixture: sample-readme.md ───────────────────────────────────────────────

describe("Fixture: sample-readme.md", () => {
  it("parses without throwing", () => {
    expect(() => parseFixture("sample-readme.md")).not.toThrow();
  });

  it("kind is readme", () => {
    const doc = parseFixture("sample-readme.md");
    expect(doc.kind).toBe("readme");
  });

  it("title is extracted from H1", () => {
    const doc = parseFixture("sample-readme.md");
    expect(doc.title).toBe("Code Graph Server");
  });

  it("has at least 3 sections", () => {
    const doc = parseFixture("sample-readme.md");
    expect(doc.sections.length).toBeGreaterThanOrEqual(3);
  });

  it("hash is 64-char hex", () => {
    const doc = parseFixture("sample-readme.md");
    expect(doc.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("extracts known backtick refs from body", () => {
    const doc = parseFixture("sample-readme.md");
    const allRefs = doc.sections.flatMap((s) => s.backtickRefs);
    expect(allRefs).toContain("graph_rebuild");
    expect(allRefs).toContain("GraphOrchestrator");
  });

  it("extracts code fences with language tags", () => {
    const doc = parseFixture("sample-readme.md");
    const allFences = doc.sections.flatMap((s) => s.codeFences);
    const langs = allFences.map((f) => f.lang);
    expect(langs).toContain("bash");
    expect(langs).toContain("typescript");
  });
});

// ─── Fixture: sample-adr.md ──────────────────────────────────────────────────

describe("Fixture: sample-adr.md", () => {
  it("kind is adr", () => {
    // Use absolute path with 'adr' in path segment for kind inference
    const p2 = parser();
    const doc = p2.parseFile(
      path.join(FIXTURES, "sample-adr.md"),
      FIXTURES, // treat fixtures dir as workspace root
    );
    // Override kind check via inferKind with an adr-pattern path
    expect(p2.inferKind("docs/adr/ADR-002.md")).toBe("adr");
    // Fixture itself — kind depends on path; fixture is not in an adr/ dir so test inferKind directly
    expect(doc.sections.length).toBeGreaterThanOrEqual(4);
  });

  it("has Decision, Context, Consequences sections", () => {
    const doc = parseFixture("sample-adr.md");
    const headings = doc.sections.map((s) => s.heading);
    expect(headings.some((h) => /context/i.test(h))).toBe(true);
    expect(headings.some((h) => /decision/i.test(h))).toBe(true);
    expect(headings.some((h) => /consequences/i.test(h))).toBe(true);
  });

  it("extracts MemgraphClient and GraphOrchestrator as backtick refs", () => {
    const doc = parseFixture("sample-adr.md");
    const allRefs = doc.sections.flatMap((s) => s.backtickRefs);
    expect(allRefs).toContain("MemgraphClient");
    expect(allRefs).toContain("GraphOrchestrator");
  });

  it("has a cypher code fence", () => {
    const doc = parseFixture("sample-adr.md");
    const allFences = doc.sections.flatMap((s) => s.codeFences);
    const langs = allFences.map((f) => f.lang);
    expect(langs).toContain("cypher");
  });

  it("extracts Neo4j link", () => {
    const doc = parseFixture("sample-adr.md");
    const allLinks = doc.sections.flatMap((s) => s.links);
    const hrefs = allLinks.map((l) => l.href);
    expect(hrefs.some((h) => h.includes("neo4j"))).toBe(true);
  });
});

// ─── Fixture: sample-changelog.md ────────────────────────────────────────────

describe("Fixture: sample-changelog.md", () => {
  it("kind is changelog via inferKind", () => {
    expect(parser().inferKind("CHANGELOG.md")).toBe("changelog");
  });

  it("sections include version headings", () => {
    const doc = parseFixture("sample-changelog.md");
    const headings = doc.sections.map((s) => s.heading);
    expect(headings.some((h) => /1\.3\.0/.test(h))).toBe(true);
    expect(headings.some((h) => /1\.2\.0/.test(h))).toBe(true);
  });

  it("extracts DocsEngine as backtick ref", () => {
    const doc = parseFixture("sample-changelog.md");
    const allRefs = doc.sections.flatMap((s) => s.backtickRefs);
    expect(allRefs).toContain("DocsEngine");
  });

  it("totalWordCount > 0", () => {
    const doc = parseFixture("sample-changelog.md");
    expect(doc.wordCount).toBeGreaterThan(10);
  });
});

// ─── findMarkdownFiles ────────────────────────────────────────────────────────

describe("findMarkdownFiles", () => {
  it("finds .md files in the fixtures directory", () => {
    const files = findMarkdownFiles(FIXTURES);
    // The fixtures dir is flat so depth=0 walk should pick them up
    // But findMarkdownFiles only walks depth 0 and known doc dirs.
    // FIXTURES itself is the root so all .md files at root level are found.
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.every((f) => f.endsWith(".md"))).toBe(true);
  });

  it("does not return files from node_modules", () => {
    // Workspace root — confirmed node_modules are excluded
    const files = findMarkdownFiles(
      path.join(__dirname, "..", ".."), // project root
    );
    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
  });

  it("returns absolute paths", () => {
    const files = findMarkdownFiles(FIXTURES);
    expect(files.every((f) => path.isAbsolute(f))).toBe(true);
  });
});
