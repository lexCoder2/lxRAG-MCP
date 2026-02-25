# Code Comment Standard

This project uses a lightweight, standardized TSDoc format for comments.

## 1) File Header (required for core modules)

Use this at the top of important files:

```ts
/**
 * @file <path-or-module-name>
 * @description <what this module is responsible for>
 * @remarks <important constraints, assumptions, or behavior>
 */
```

## 2) Public API Comments (required)

Use TSDoc for exported functions, interfaces, and constants:

```ts
/**
 * Short summary of behavior.
 *
 * @param input - Meaningful argument description.
 * @returns What is returned and key shape guarantees.
 */
export function example(input: string): string { ... }
```

For exported constants:

```ts
/**
 * What this constant represents and where it is used.
 */
export const value = ...;
```

## 3) Internal Helper Comments (optional, but recommended)

Comment internal helpers when one of these is true:
- Non-obvious behavior (normalization, fallback logic, truncation).
- Performance-sensitive behavior.
- Subtle edge-case handling.

Prefer short comments that explain **why**, not line-by-line **what**.

## 4) Style Rules

- Keep comments accurate and behavior-focused.
- Keep summaries concise (1–2 lines).
- Use `@param` and `@returns` for callable APIs.
- Avoid stale phase/temporary migration wording.
- Update comments in the same change when behavior changes.

## 5) Scope Guidance

- Required: core runtime modules, registries, exported type contracts, tool definitions.
- Recommended: tests with fixtures/path assumptions, complex orchestration flows.
- Optional: obvious private one-liners.
