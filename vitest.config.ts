import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use V8 for fast native coverage instrumentation
    coverage: {
      provider: "v8",
      // Coverage is only collected from source files under src/,
      // excluding test files, generated dist, and legacy entry points.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/test-*.ts",
        "src/index.ts", // legacy entry point, excluded from tsconfig
      ],
      // Fail the CI run if overall coverage drops below these thresholds.
      // Raise these incrementally as coverage improves.
      thresholds: {
        statements: 60,
        lines: 60,
        functions: 60,
        branches: 50,
      },
      reporter: ["text", "lcov", "html"],
    },
  },
});
