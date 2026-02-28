import { describe, expect, it } from "vitest";
import {
  GoParser,
  JavaParser,
  PythonParser,
  RustParser,
} from "../regex-language-parsers.js";
import type { ParsedSymbol } from "../parser-interface.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function names(symbols: ParsedSymbol[], type?: string): string[] {
  const filtered = type ? symbols.filter((s) => s.type === type) : symbols;
  return filtered.map((s) => s.name);
}

// ---------------------------------------------------------------------------
// PythonParser
// ---------------------------------------------------------------------------

describe("PythonParser", () => {
  const parser = new PythonParser();

  it("exposes correct language / extensions metadata", () => {
    expect(parser.language).toBe("python");
    expect(parser.extensions).toContain(".py");
  });

  it("parses an empty file without error", async () => {
    const result = await parser.parse("empty.py", "");
    expect(result.symbols).toHaveLength(0);
    expect(result.file).toBe("empty.py");
    expect(result.language).toBe("python");
  });

  describe("imports", () => {
    it("extracts bare `import x` statements", async () => {
      const code = `import os\nimport sys\n`;
      const { symbols } = await parser.parse("mod.py", code);
      expect(names(symbols, "import")).toEqual(["os", "sys"]);
    });

    it("extracts `from x import y` as import with module name", async () => {
      const code = `from pathlib import Path\nfrom os.path import join\n`;
      const { symbols } = await parser.parse("mod.py", code);
      expect(names(symbols, "import")).toEqual(["pathlib", "os.path"]);
    });
  });

  describe("classes", () => {
    it("extracts class declarations", async () => {
      const code = `class MyClass:\n    pass\n`;
      const { symbols } = await parser.parse("mod.py", code);
      expect(names(symbols, "class")).toContain("MyClass");
    });

    it("records correct startLine (1-based)", async () => {
      const code = `\nclass Foo:\n    pass\n`;
      const { symbols } = await parser.parse("mod.py", code);
      const cls = symbols.find((s) => s.name === "Foo");
      // class is on line 2 (1-indexed)
      expect(cls?.startLine).toBe(2);
    });

    it("endLine is computed via python block end (indent)", async () => {
      const code = `class Outer:\n    x = 1\n    y = 2\n\nclass Inner:\n    pass\n`;
      const { symbols } = await parser.parse("mod.py", code);
      const outer = symbols.find((s) => s.name === "Outer");
      // findPythonBlockEnd returns the 0-based index of the next less-indented line
      // "class Inner:" is at index 4 in the split array → endLine = 4
      expect(outer?.endLine).toBe(4);
    });
  });

  describe("functions", () => {
    it("extracts function definitions", async () => {
      const code = `def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n`;
      const { symbols } = await parser.parse("funcs.py", code);
      expect(names(symbols, "function")).toEqual(["add", "sub"]);
    });

    it("allows underscore-prefixed (private) function names", async () => {
      const code = `def _helper():\n    pass\n`;
      const { symbols } = await parser.parse("mod.py", code);
      expect(names(symbols, "function")).toContain("_helper");
    });
  });

  it("parses a realistic mixed file", async () => {
    const code = [
      "import os",
      "from typing import List",
      "",
      "class Config:",
      "    debug = False",
      "",
      "def load_config(path: str) -> Config:",
      "    return Config()",
    ].join("\n");

    const { symbols } = await parser.parse("config.py", code);
    expect(names(symbols, "import")).toEqual(["os", "typing"]);
    expect(names(symbols, "class")).toContain("Config");
    expect(names(symbols, "function")).toContain("load_config");
  });
});

// ---------------------------------------------------------------------------
// GoParser
// ---------------------------------------------------------------------------

describe("GoParser", () => {
  const parser = new GoParser();

  it("exposes correct language / extensions metadata", () => {
    expect(parser.language).toBe("go");
    expect(parser.extensions).toContain(".go");
  });

  it("parses an empty file without error", async () => {
    const result = await parser.parse("main.go", "");
    expect(result.symbols).toHaveLength(0);
  });

  describe("imports", () => {
    it("extracts single-line import", async () => {
      const code = `import "fmt"\n`;
      const { symbols } = await parser.parse("main.go", code);
      expect(names(symbols, "import")).toContain("fmt");
    });

    it("extracts block imports (entry immediately after import line)", async () => {
      const code = `import\n"fmt"\n"os"\n`;
      const { symbols } = await parser.parse("main.go", code);
      // block entry regex requires previous line to have "import"
      expect(names(symbols, "import")).toContain("fmt");
    });
  });

  describe("types (structs / interfaces)", () => {
    it("classifies struct as class", async () => {
      const code = `type Server struct {\n    port int\n}\n`;
      const { symbols } = await parser.parse("srv.go", code);
      const sym = symbols.find((s) => s.name === "Server");
      expect(sym?.type).toBe("class");
    });

    it("classifies interface as interface", async () => {
      const code = `type Writer interface {\n    Write(p []byte) (n int, err error)\n}\n`;
      const { symbols } = await parser.parse("iface.go", code);
      const sym = symbols.find((s) => s.name === "Writer");
      expect(sym?.type).toBe("interface");
    });

    it("endLine covers the closing brace", async () => {
      const code = `type Point struct {\n    X int\n    Y int\n}\n`;
      // findBraceBlockEnd returns i+1 where '}' is found;
      // closing brace is at line index 3 → endLine = 4
      const { symbols } = await parser.parse("point.go", code);
      const sym = symbols.find((s) => s.name === "Point");
      expect(sym?.endLine).toBe(4);
    });
  });

  describe("functions", () => {
    it("extracts top-level function", async () => {
      const code = `func Hello(name string) string {\n    return "hi " + name\n}\n`;
      const { symbols } = await parser.parse("greet.go", code);
      expect(names(symbols, "function")).toContain("Hello");
    });

    it("extracts method (function with receiver)", async () => {
      const code = `func (s *Server) Start() error {\n    return nil\n}\n`;
      const { symbols } = await parser.parse("srv.go", code);
      expect(names(symbols, "function")).toContain("Start");
    });
  });

  it("parses a realistic mixed file", async () => {
    const code = [
      `import "fmt"`,
      "",
      "type App struct {",
      "    name string",
      "}",
      "",
      "func (a *App) Run() {",
      `    fmt.Println(a.name)`,
      "}",
    ].join("\n");

    const { symbols } = await parser.parse("app.go", code);
    expect(names(symbols, "import")).toContain("fmt");
    expect(names(symbols, "class")).toContain("App");
    expect(names(symbols, "function")).toContain("Run");
  });
});

// ---------------------------------------------------------------------------
// RustParser
// ---------------------------------------------------------------------------

describe("RustParser", () => {
  const parser = new RustParser();

  it("exposes correct language / extensions metadata", () => {
    expect(parser.language).toBe("rust");
    expect(parser.extensions).toContain(".rs");
  });

  it("parses an empty file without error", async () => {
    const result = await parser.parse("lib.rs", "");
    expect(result.symbols).toHaveLength(0);
  });

  describe("imports", () => {
    it("extracts use statements", async () => {
      const code = `use std::collections::HashMap;\nuse std::io;\n`;
      const { symbols } = await parser.parse("lib.rs", code);
      expect(names(symbols, "import")).toEqual([
        "std::collections::HashMap",
        "std::io",
      ]);
    });
  });

  describe("structs, enums and traits", () => {
    it("classifies struct as class", async () => {
      const code = `struct Point {\n    x: f32,\n    y: f32,\n}\n`;
      const { symbols } = await parser.parse("geo.rs", code);
      expect(symbols.find((s) => s.name === "Point")?.type).toBe("class");
    });

    it("classifies pub struct as class", async () => {
      const code = `pub struct Config {\n    debug: bool,\n}\n`;
      const { symbols } = await parser.parse("cfg.rs", code);
      expect(symbols.find((s) => s.name === "Config")?.type).toBe("class");
    });

    it("classifies enum as class", async () => {
      const code = `enum Color {\n    Red,\n    Green,\n    Blue,\n}\n`;
      const { symbols } = await parser.parse("color.rs", code);
      expect(symbols.find((s) => s.name === "Color")?.type).toBe("class");
    });

    it("classifies trait as interface", async () => {
      const code = `pub trait Serialize {\n    fn serialize(&self) -> String;\n}\n`;
      const { symbols } = await parser.parse("ser.rs", code);
      expect(symbols.find((s) => s.name === "Serialize")?.type).toBe("interface");
    });
  });

  describe("functions", () => {
    it("extracts plain fn", async () => {
      const code = `fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n`;
      const { symbols } = await parser.parse("math.rs", code);
      expect(names(symbols, "function")).toContain("add");
    });

    it("extracts pub fn", async () => {
      const code = `pub fn greet(name: &str) -> String {\n    format!("hi {}", name)\n}\n`;
      const { symbols } = await parser.parse("greet.rs", code);
      expect(names(symbols, "function")).toContain("greet");
    });
  });

  it("parses a realistic mixed file", async () => {
    const code = [
      "use std::fmt;",
      "",
      "pub struct App {",
      "    name: String,",
      "}",
      "",
      "pub trait Runner {",
      "    fn run(&self);",
      "}",
      "",
      "pub fn start() {",
      "    println!(\"started\");",
      "}",
    ].join("\n");

    const { symbols } = await parser.parse("app.rs", code);
    expect(names(symbols, "import")).toContain("std::fmt");
    expect(names(symbols, "class")).toContain("App");
    expect(names(symbols, "interface")).toContain("Runner");
    expect(names(symbols, "function")).toContain("start");
  });
});

// ---------------------------------------------------------------------------
// JavaParser
// ---------------------------------------------------------------------------

describe("JavaParser", () => {
  const parser = new JavaParser();

  it("exposes correct language / extensions metadata", () => {
    expect(parser.language).toBe("java");
    expect(parser.extensions).toContain(".java");
  });

  it("parses an empty file without error", async () => {
    const result = await parser.parse("App.java", "");
    expect(result.symbols).toHaveLength(0);
  });

  describe("imports", () => {
    it("extracts import statements", async () => {
      const code = `import java.util.List;\nimport java.io.InputStream;\n`;
      const { symbols } = await parser.parse("App.java", code);
      expect(names(symbols, "import")).toEqual(["java.util.List", "java.io.InputStream"]);
    });

    it("extracts wildcard imports", async () => {
      const code = `import java.util.*;\n`;
      const { symbols } = await parser.parse("App.java", code);
      expect(names(symbols, "import")).toContain("java.util.*");
    });
  });

  describe("classes and interfaces", () => {
    it("extracts public class", async () => {
      const code = `public class Service {\n}\n`;
      const { symbols } = await parser.parse("Service.java", code);
      expect(symbols.find((s) => s.name === "Service")?.type).toBe("class");
    });

    it("extracts interface as interface type", async () => {
      const code = `public interface Runnable {\n    void run();\n}\n`;
      const { symbols } = await parser.parse("Runnable.java", code);
      expect(symbols.find((s) => s.name === "Runnable")?.type).toBe("interface");
    });

    it("extracts enum", async () => {
      const code = `public enum Status {\n    OK, ERROR\n}\n`;
      const { symbols } = await parser.parse("Status.java", code);
      expect(symbols.find((s) => s.name === "Status")?.type).toBe("class");
    });

    it("handles abstract class", async () => {
      const code = `public abstract class Base {\n}\n`;
      const { symbols } = await parser.parse("Base.java", code);
      expect(names(symbols, "class")).toContain("Base");
    });
  });

  describe("methods", () => {
    it("extracts public method", async () => {
      const code = `public class Foo {\n    public void doWork() {\n    }\n}\n`;
      const { symbols } = await parser.parse("Foo.java", code);
      expect(names(symbols, "function")).toContain("doWork");
    });

    it("does not extract reserved keywords as methods", async () => {
      const code = [
        "public class Guard {",
        "    public void check() {",
        "        if (x > 0) {",
        "        }",
        "        for (int i=0; i<10; i++) {",
        "        }",
        "        while (x > 0) {",
        "        }",
        "    }",
        "}",
      ].join("\n");
      const { symbols } = await parser.parse("Guard.java", code);
      // "if", "for", "while" must not appear as function symbols
      const fnNames = names(symbols, "function");
      expect(fnNames).not.toContain("if");
      expect(fnNames).not.toContain("for");
      expect(fnNames).not.toContain("while");
    });

    it("extracts private static method", async () => {
      const code = `public class Util {\n    private static String format(String s) {\n        return s;\n    }\n}\n`;
      const { symbols } = await parser.parse("Util.java", code);
      expect(names(symbols, "function")).toContain("format");
    });
  });

  it("parses a realistic mixed file", async () => {
    const code = [
      "import java.util.List;",
      "import java.util.ArrayList;",
      "",
      "public class Repository {",
      "    private List<String> items;",
      "",
      "    public void add(String item) {",
      "        items.add(item);",
      "    }",
      "",
      "    public List<String> getAll() {",
      "        return items;",
      "    }",
      "}",
    ].join("\n");

    const { symbols } = await parser.parse("Repository.java", code);
    expect(names(symbols, "import")).toEqual(["java.util.List", "java.util.ArrayList"]);
    expect(names(symbols, "class")).toContain("Repository");
    expect(names(symbols, "function")).toContain("add");
    expect(names(symbols, "function")).toContain("getAll");
  });
});
