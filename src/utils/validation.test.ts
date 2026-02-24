import { describe, expect, it } from "vitest";
import {
  createValidationError,
  extractProjectIdFromScopedId,
  generateSecureId,
  parseScopedId,
  validateCypherQuery,
  validateFilePath,
  validateLimit,
  validateMode,
  validateNodeId,
  validateProjectId,
  validateQuery,
} from "./validation.js";

describe("validation utils", () => {
  it("validateProjectId accepts valid IDs and rejects invalid ones", () => {
    expect(validateProjectId("proj_1-alpha")).toBe("proj_1-alpha");
    expect(() => validateProjectId(123)).toThrow("projectId must be a string");
    expect(() => validateProjectId("")).toThrow(
      "projectId must be between 1 and 128 characters",
    );
    expect(() => validateProjectId("bad/project")).toThrow(
      "projectId can only contain",
    );
  });

  it("validateFilePath enforces relative non-traversal paths", () => {
    expect(validateFilePath("src/foo.ts")).toBe("src/foo.ts");
    expect(() => validateFilePath("../secret")).toThrow(
      "filePath cannot contain .. or start with /",
    );
    expect(() => validateFilePath("/abs/path")).toThrow(
      "filePath cannot contain .. or start with /",
    );
  });

  it("validateQuery enforces type and max length", () => {
    expect(validateQuery("ok", 10)).toBe("ok");
    expect(() => validateQuery(42 as any)).toThrow("query must be a string");
    expect(() => validateQuery("toolong", 3)).toThrow(
      "query must be between 1 and 3 characters",
    );
  });

  it("validateCypherQuery enforces type and bounds", () => {
    expect(validateCypherQuery("MATCH (n) RETURN n")).toBe(
      "MATCH (n) RETURN n",
    );
    expect(() => validateCypherQuery(42 as any)).toThrow(
      "Cypher query must be a string",
    );
    expect(() => validateCypherQuery("")).toThrow(
      "Cypher query must be between 1 and 50000 characters",
    );
  });

  it("validateNodeId validates basic colon-delimited format", () => {
    expect(validateNodeId("proj:file:src/a.ts")).toBe("proj:file:src/a.ts");
    expect(() => validateNodeId(12 as any)).toThrow("nodeId must be a string");
    expect(() => validateNodeId(Array(12).fill("x").join(":"))).toThrow(
      "nodeId has invalid format",
    );
  });

  it("validateLimit handles string and number with range checks", () => {
    expect(validateLimit(10)).toBe(10);
    expect(validateLimit("25")).toBe(25);
    expect(() => validateLimit("0")).toThrow("limit must be an integer");
    expect(() => validateLimit("x")).toThrow("limit must be an integer");
  });

  it("validateMode enforces allowed list", () => {
    expect(validateMode("hybrid", ["local", "hybrid"])).toBe("hybrid");
    expect(() => validateMode(1 as any, ["a"])).toThrow(
      "mode must be a string",
    );
    expect(() => validateMode("global", ["local", "hybrid"])).toThrow(
      "mode must be one of",
    );
  });

  it("createValidationError includes field, reason, and value preview", () => {
    const err = createValidationError("limit", 99999, "too large");
    expect(err.message).toContain("Validation failed for limit");
    expect(err.message).toContain("too large");
    expect(err.message).toContain("99999");
  });

  it("extractProjectIdFromScopedId falls back safely", () => {
    expect(extractProjectIdFromScopedId("proj:file:src/a.ts", "dflt")).toBe(
      "proj",
    );
    expect(extractProjectIdFromScopedId("", "dflt")).toBe("dflt");
    expect(extractProjectIdFromScopedId(" :type:name", "dflt")).toBe("dflt");
  });

  it("parseScopedId returns parsed components", () => {
    expect(parseScopedId("proj:file:main")).toEqual({
      projectId: "proj",
      type: "file",
      name: "main",
      raw: "proj:file:main",
    });
    expect(parseScopedId("single")).toEqual({
      projectId: "single",
      type: undefined,
      name: undefined,
      raw: "single",
    });
  });

  it("generateSecureId returns prefixed random hex id", () => {
    const id = generateSecureId("tx", 4);
    expect(id).toMatch(/^tx-[a-f0-9]{8}$/);
  });
});
