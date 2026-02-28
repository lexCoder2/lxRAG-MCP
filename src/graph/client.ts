/**
 * @file graph/client
 * @description Memgraph client wrapper for Cypher execution and connection lifecycle.
 * @remarks Provides resilient query utilities used across graph and engine modules.
 */

import type { CypherStatement } from "./types";
import neo4j from "neo4j-driver";
import * as env from "../env.js";
import { logger } from "../utils/logger.js";

export interface MemgraphConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface QueryResult {
  data: Record<string, unknown>[];
  error?: string;
}

// ── Retry / resilience constants ─────────────────────────────────────────────

/** Delays (ms) between successive retry attempts: 100 → 400 → 1600 ms. */
const BACKOFF_INTERVALS_MS = [100, 400, 1600] as const;

/**
 * Number of consecutive query errors that open the circuit breaker.
 * Once open, all queries short-circuit immediately until the cooldown expires.
 */
const CIRCUIT_BREAKER_THRESHOLD = 5;

/** Milliseconds the circuit stays open before entering half-open state. */
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

/** Interval for background liveness pings while connected (ms). */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Sleep helper used for exponential backoff between retries. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Memgraph client for executing Cypher queries.
 *
 * Resilience features:
 *  - **3-retry with exponential backoff** (100ms → 400ms → 1600ms) for
 *    transient errors (ServiceUnavailable, session expired, connection lost).
 *  - **Circuit breaker** — after 5 consecutive failures the circuit opens
 *    and all queries fail fast for 30 s, then auto-resets to half-open.
 *  - **Periodic health check** — background ping every 30 s while connected;
 *    marks client as disconnected if the ping fails so the next `executeCypher`
 *    call triggers a reconnect.
 */
export class MemgraphClient {
  private config: MemgraphConfig;
  private driver: any;
  private connected = false;
  private readonly queryRetryAttempts = 3;

  // ── Circuit breaker state ─────────────────────────────────────────────────

  private consecutiveFailures = 0;
  private circuitOpen = false;
  private circuitOpenAt = 0;

  // ── Health check handle ───────────────────────────────────────────────────

  private healthCheckHandle: NodeJS.Timeout | null = null;

  constructor(config: Partial<MemgraphConfig> = {}) {
    this.config = {
      host: config.host || "localhost",
      port: config.port || 7687,
      username: config.username || "memgraph",
      password: config.password || "",
    };

    this.driver = this.createDriver(this.config.host);

    const boltUrl = `bolt://${this.config.host}:${this.config.port}`;
    logger.info("[MemgraphClient] Initialized", { boltUrl });
  }

  async connect(): Promise<void> {
    try {
      // Verify connection by running a simple query
      const session = this.driver.session();
      await session.run("RETURN 1");
      await session.close();
      this.connected = true;
      this.resetCircuitBreaker();
      logger.info("[Memgraph] Connected successfully via Bolt protocol");
      this.startHealthCheck();
    } catch (error) {
      if (this.shouldFallbackToLocalhost(error)) {
        logger.warn(
          `[Memgraph] Host '${this.config.host}' is not resolvable from this runtime. Retrying with localhost...`,
        );

        await this.driver.close();
        this.config.host = "localhost";
        this.driver = this.createDriver(this.config.host);

        const session = this.driver.session();
        await session.run("RETURN 1");
        await session.close();
        this.connected = true;
        this.resetCircuitBreaker();
        logger.info("[Memgraph] Connected successfully via Bolt protocol");
        this.startHealthCheck();
        return;
      }

      logger.error("[Memgraph] Connection failed", error);
      this.connected = false;
      throw error;
    }
  }

  private createDriver(host: string): any {
    const boltUrl = `bolt://${host}:${this.config.port}`;
    const authToken = neo4j.auth.basic(
      this.config.username || "memgraph",
      this.config.password || "",
    );

    return neo4j.driver(boltUrl, authToken, {
      maxConnectionPoolSize: env.LXDIG_MEMGRAPH_MAX_POOL_SIZE,
      connectionAcquisitionTimeout: env.LXDIG_MEMGRAPH_CONNECTION_TIMEOUT_MS,
      connectionLivenessCheckTimeout: env.LXDIG_MEMGRAPH_LIVENESS_TIMEOUT_MS,
    });
  }

  private shouldFallbackToLocalhost(error: unknown): boolean {
    if (this.config.host === "localhost" || this.config.host === "127.0.0.1") {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    return message.includes("ENOTFOUND");
  }

  // ── Circuit breaker ───────────────────────────────────────────────────────

  private resetCircuitBreaker(): void {
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
    this.circuitOpenAt = 0;
  }

  /**
   * Returns true when the circuit is currently open (fast-fail mode).
   * Transitions from open → half-open after the cooldown expires.
   */
  private isCircuitOpen(): boolean {
    if (!this.circuitOpen) return false;
    const elapsed = Date.now() - this.circuitOpenAt;
    if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
      // Half-open: allow one probe request through
      logger.info("[Memgraph] Circuit breaker half-open — probing...");
      this.circuitOpen = false;
      return false;
    }
    return true;
  }

  private recordQuerySuccess(): void {
    this.consecutiveFailures = 0;
    if (this.circuitOpen) this.circuitOpen = false;
  }

  private recordQueryFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpen = true;
      this.circuitOpenAt = Date.now();
      logger.error("[Memgraph] Circuit breaker OPENED — too many consecutive failures", {
        threshold: CIRCUIT_BREAKER_THRESHOLD,
        cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
      });
    }
  }

  // ── Periodic health check ─────────────────────────────────────────────────

  private startHealthCheck(): void {
    if (this.healthCheckHandle) return; // already running
    this.healthCheckHandle = setInterval(async () => {
      try {
        const session = this.driver.session();
        await session.run("RETURN 1");
        await session.close();
        // Silent success — no log spam on healthy ping
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn("[Memgraph] Health check failed — marking as disconnected", { cause: msg });
        this.connected = false;
        this.stopHealthCheck();
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    // Don't hold the Node.js event loop open just for the health check
    if (this.healthCheckHandle.unref) {
      this.healthCheckHandle.unref();
    }
  }

  private stopHealthCheck(): void {
    if (this.healthCheckHandle) {
      clearInterval(this.healthCheckHandle);
      this.healthCheckHandle = null;
    }
  }

  // ── Public methods ────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    this.stopHealthCheck();
    if (this.driver) {
      await this.driver.close();
      this.connected = false;
      logger.info("[Memgraph] Disconnected");
    }
  }

  async executeCypher(query: string, params: Record<string, any> = {}): Promise<QueryResult> {
    // ── Circuit breaker fast-fail ─────────────────────────────────────────
    if (this.isCircuitOpen()) {
      return {
        data: [],
        error: "Circuit breaker open — Memgraph unavailable, retrying after cooldown",
      };
    }

    // ── Lazy connect ──────────────────────────────────────────────────────
    if (!this.connected) {
      logger.warn("[Memgraph] Not connected - attempting to connect before executing query");
      try {
        await this.connect();
      } catch (error) {
        return {
          data: [],
          error: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // Sanitize params: replace undefined with null (Bolt requires explicit null)
    const sanitizedParams = Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, v === undefined ? null : v]),
    );

    // ── Retry loop with exponential backoff ───────────────────────────────
    for (let attempt = 0; attempt <= this.queryRetryAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = BACKOFF_INTERVALS_MS[attempt - 1] ?? 1600;
        logger.warn("[Memgraph] Retrying query after backoff", {
          attempt,
          maxAttempts: this.queryRetryAttempts,
          delayMs,
        });
        await sleep(delayMs);
      }

      const session = this.driver.session();
      try {
        const result = await session.run(query, sanitizedParams);
        const data = result.records.map((record: { toObject(): Record<string, unknown> }) => record.toObject());

        this.recordQuerySuccess();
        return { data, error: undefined };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const canRetry = attempt < this.queryRetryAttempts && this.isRetryableQueryError(error);

        if (canRetry) {
          logger.warn("[Memgraph] Transient query error, will retry", {
            attempt: attempt + 1,
            maxAttempts: this.queryRetryAttempts,
            cause: errorMsg,
          });
          continue;
        }

        this.recordQueryFailure();
        logger.error("[Memgraph] Query execution failed", {
          cause: errorMsg,
          query: query.substring(0, 200),
        });
        return { data: [], error: `Query failed: ${errorMsg}` };
      } finally {
        await session.close();
      }
    }

    this.recordQueryFailure();
    return { data: [], error: "Query failed: exhausted retry attempts" };
  }

  private isRetryableQueryError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return (
      normalized.includes("serviceunavailable") ||
      normalized.includes("session expired") ||
      normalized.includes("connection") ||
      normalized.includes("temporarily unavailable")
    );
  }

  async executeBatch(statements: CypherStatement[]): Promise<QueryResult[]> {
    const results: QueryResult[] = [];

    for (const statement of statements) {
      const result = await this.executeCypher(statement.query, statement.params);
      results.push(result);

      // Log errors but continue
      if (result.error) {
        logger.error(`[Memgraph] Error in query: ${result.error}`);
      }
    }

    return results;
  }

  /**
   * Execute a natural language query and convert to Cypher.
   *
   * @deprecated Use HybridRetriever for natural language queries instead.
   * This method uses simple hardcoded pattern matching and will be removed
   * in a future release.
   */
  async queryNaturalLanguage(query: string): Promise<QueryResult> {
    const cypher = this.naturalLanguageToCypher(query);
    return this.executeCypher(cypher);
  }

  /**
   * Convert common natural language patterns to Cypher.
   *
   * @deprecated Use HybridRetriever for production NL routing.
   * This is an MVP stub retained for backward compatibility only.
   */
  private naturalLanguageToCypher(query: string): string {
    const lower = query.toLowerCase();

    // "Show all files"
    if (lower.includes("all files") || lower.includes("list files")) {
      return "MATCH (f:FILE) RETURN f.path, f.LOC, f.lastModified ORDER BY f.path";
    }

    // "Files in components layer"
    if (lower.includes("files") && lower.includes("layer")) {
      const layerMatch = /layer\s+['"]?(\w+)['"]?/i.exec(query);
      const layerId = layerMatch ? layerMatch[1] : "components";
      return `MATCH (l:LAYER {id: '${layerId}'})<-[:BELONGS_TO_LAYER]-(f:FILE) RETURN f.path, f.LOC`;
    }

    // "Functions in file"
    if (lower.includes("functions")) {
      const fileMatch = /file\s+['"]?([^'"]+)['"]?/i.exec(query);
      const filePath = fileMatch ? fileMatch[1] : "";
      return `MATCH (f:FILE {path: '${filePath}'})-[:CONTAINS]->(func:FUNCTION) RETURN func.name, func.kind, func.startLine`;
    }

    // "Test coverage"
    if (lower.includes("test") && lower.includes("cover")) {
      return `MATCH (t:TEST_CASE)-[:TESTS]->(c:CLASS|FUNCTION) RETURN c.name, count(t) as test_count ORDER BY test_count DESC`;
    }

    // "Architecture violations"
    if (lower.includes("violation")) {
      return `MATCH (f:FILE)-[:VIOLATES_RULE]->(r) RETURN f.path, r.rule`;
    }

    // Default fallback
    return `MATCH (n) RETURN labels(n)[0] as type, count(n) as count ORDER BY count DESC`;
  }

  /**
   * Load all nodes and relationships for a project from Memgraph
   * Used for Phase 2c: Populate in-memory index from database on startup
   */
  async loadProjectGraph(projectId: string): Promise<{
    nodes: Array<{ id: string; type: string; properties: Record<string, any> }>;
    relationships: Array<{
      id: string;
      from: string;
      to: string;
      type: string;
      properties?: Record<string, any>;
    }>;
  }> {
    if (!this.connected) {
      return { nodes: [], relationships: [] };
    }

    try {
      // Load all nodes for this projectId
      const nodesResult = await this.executeCypher(
        `MATCH (n {projectId: $projectId})
         RETURN n.id AS id, labels(n)[0] AS type, properties(n) AS props`,
        { projectId },
      );

      const nodes = nodesResult.data.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        type: String(row.type),
        properties: (row.props as Record<string, unknown>) || {},
      }));

      // Load all relationships for this projectId
      const relsResult = await this.executeCypher(
        `MATCH (n1 {projectId: $projectId})-[r]->(n2 {projectId: $projectId})
         RETURN n1.id AS from, n2.id AS to, type(r) AS type, properties(r) AS props`,
        { projectId },
      );

      const relationships = relsResult.data.map((row: Record<string, unknown>) => ({
        id: `${String(row.from)}-${String(row.type)}-${String(row.to)}`,
        from: String(row.from),
        to: String(row.to),
        type: String(row.type),
        properties: (row.props as Record<string, unknown>) || {},
      }));

      return { nodes, relationships };
    } catch (error) {
      logger.error(`[MemgraphClient] Failed to load project graph for ${projectId}:`, error);
      return { nodes: [], relationships: [] };
    }
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.connected;
  }
}

export default MemgraphClient;
