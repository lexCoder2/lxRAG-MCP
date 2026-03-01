/**
 * ResponseFormatter
 * Single responsibility: serialise tool results into the wire JSON format.
 * Extracted from ToolHandlerBase (SRP / SOLID refactor).
 */
import { formatResponse, errorResponse } from "../response/shaper";

export class ResponseFormatter {
  public errorEnvelope(code: string, reason: string, recoverable = true, hint?: string): string {
    const response = errorResponse(
      code,
      reason,
      hint || "Review tool input and retry.",
    ) as unknown as Record<string, unknown>;
    response.error = { code, reason, recoverable, hint };
    return JSON.stringify(response, null, 2);
  }

  public canonicalizePaths(text: string): string {
    return text
      .replaceAll("/workspace/", "")
      .replace(/\/home\/[^/]+\/stratSolver\//g, "")
      .replaceAll("//", "/");
  }

  public compactValue(value: unknown): unknown {
    if (typeof value === "string") {
      const normalized = this.canonicalizePaths(value);
      return normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 10).map((item) => this.compactValue(item));
    }

    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
      return Object.fromEntries(entries.map(([key, val]) => [key, this.compactValue(val)]));
    }

    return value;
  }

  public formatSuccess(
    data: unknown,
    profile: string = "compact",
    summary?: string,
    toolName?: string,
  ): string {
    const shaped = profile === "debug" ? data : this.compactValue(data);
    const safeProfile = profile === "balanced" || profile === "debug" ? profile : "compact";
    return JSON.stringify(
      formatResponse(summary || "Operation completed successfully.", shaped, safeProfile, toolName),
      (_key, value) => (typeof value === "bigint" ? Number(value) : value),
      2,
    );
  }
}
