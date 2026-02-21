export type SummaryKind = "file" | "function" | "class" | "import";

export interface SummaryInput {
  kind: SummaryKind;
  cacheKey: string;
  name?: string;
  path?: string;
  language?: string;
  loc?: number;
  metadata?: Record<string, unknown>;
}

export default class CodeSummarizer {
  private cache = new Map<string, string>();

  constructor(private endpointUrl?: string) {}

  isConfigured(): boolean {
    return !!this.endpointUrl;
  }

  async summarize(input: SummaryInput): Promise<string> {
    const existing = this.cache.get(input.cacheKey);
    if (existing) {
      return existing;
    }

    const remote = await this.tryRemoteSummary(input);
    const summary = remote || this.localSummary(input);
    this.cache.set(input.cacheKey, summary);
    return summary;
  }

  private async tryRemoteSummary(input: SummaryInput): Promise<string | null> {
    if (!this.endpointUrl) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    try {
      const response = await fetch(this.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: input.kind,
          name: input.name,
          path: input.path,
          language: input.language,
          loc: input.loc,
          metadata: input.metadata || {},
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as unknown;
      if (typeof payload === "string") {
        return payload.slice(0, 400);
      }

      if (payload && typeof payload === "object") {
        const obj = payload as Record<string, unknown>;
        if (typeof obj.summary === "string") {
          return obj.summary.slice(0, 400);
        }
        if (
          obj.data &&
          typeof obj.data === "object" &&
          typeof (obj.data as Record<string, unknown>).summary === "string"
        ) {
          return String((obj.data as Record<string, unknown>).summary).slice(
            0,
            400,
          );
        }
      }

      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private localSummary(input: SummaryInput): string {
    const name = input.name || "unknown";
    const path = input.path || "";
    const loc = Number.isFinite(input.loc) ? Number(input.loc) : undefined;

    if (input.kind === "file") {
      const functions = Number(input.metadata?.functionCount || 0);
      const classes = Number(input.metadata?.classCount || 0);
      const imports = Number(input.metadata?.importCount || 0);
      return `${input.language || "source"} file ${path} with ${loc || 0} LOC, ${functions} function(s), ${classes} class(es), and ${imports} import(s).`;
    }

    if (input.kind === "function") {
      return `Function ${name} in ${path}${loc ? ` (${loc} LOC)` : ""}.`;
    }

    if (input.kind === "class") {
      return `Class/interface ${name} in ${path}${loc ? ` (${loc} LOC)` : ""}.`;
    }

    return `Import ${name} used in ${path}.`;
  }
}
