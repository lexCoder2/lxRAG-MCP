import type { CypherStatement } from "./types";
import neo4j from "neo4j-driver";
import * as env from "../env.js";

export interface MemgraphConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface QueryResult {
  data: any[];
  error?: string;
}

/**
 * Memgraph client for executing Cypher queries
 * Uses neo4j-driver with Bolt protocol (compatible with Memgraph)
 */
export class MemgraphClient {
  private config: MemgraphConfig;
  private driver: any;
  private connected = false;
  private readonly queryRetryAttempts = 1;

  constructor(config: Partial<MemgraphConfig> = {}) {
    this.config = {
      host: config.host || "localhost",
      port: config.port || 7687,
      username: config.username || "memgraph",
      password: config.password || "",
    };

    this.driver = this.createDriver(this.config.host);

    const boltUrl = `bolt://${this.config.host}:${this.config.port}`;

    console.error(`[MemgraphClient] Initialized with Bolt URL:`, boltUrl);
  }

  async connect(): Promise<void> {
    try {
      // Verify connection by running a simple query
      const session = this.driver.session();
      await session.run("RETURN 1");
      await session.close();
      this.connected = true;
      console.error("[Memgraph] Connected successfully via Bolt protocol");
    } catch (error) {
      if (this.shouldFallbackToLocalhost(error)) {
        console.warn(
          `[Memgraph] Host '${this.config.host}' is not resolvable from this runtime. Retrying with localhost...`,
        );

        await this.driver.close();
        this.config.host = "localhost";
        this.driver = this.createDriver(this.config.host);

        const session = this.driver.session();
        await session.run("RETURN 1");
        await session.close();
        this.connected = true;
        console.error("[Memgraph] Connected successfully via Bolt protocol");
        return;
      }

      console.error("[Memgraph] Connection failed:", error);
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

    // Phase 4.6: Use configurable connection pool settings
    return neo4j.driver(boltUrl, authToken, {
      maxConnectionPoolSize: env.LXRAG_MEMGRAPH_MAX_POOL_SIZE,
      connectionAcquisitionTimeout: env.LXRAG_MEMGRAPH_CONNECTION_TIMEOUT_MS,
      connectionLivenessCheckTimeout: env.LXRAG_MEMGRAPH_LIVENESS_TIMEOUT_MS,
    });
  }

  private shouldFallbackToLocalhost(error: unknown): boolean {
    if (this.config.host === "localhost" || this.config.host === "127.0.0.1") {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    return message.includes("ENOTFOUND");
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.connected = false;
      console.error("[Memgraph] Disconnected");
    }
  }

  async executeCypher(
    query: string,
    params: Record<string, any> = {},
  ): Promise<QueryResult> {
    if (!this.connected) {
      console.warn(
        "[Memgraph] Not connected - attempting to connect before executing query",
      );
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

    for (let attempt = 0; attempt <= this.queryRetryAttempts; attempt++) {
      const session = this.driver.session();
      try {
        const result = await session.run(query, sanitizedParams);
        const data = result.records.map((record: any) => record.toObject());

        return {
          data,
          error: undefined,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const canRetry =
          attempt < this.queryRetryAttempts &&
          this.isRetryableQueryError(error);

        if (canRetry) {
          console.warn(
            `[Memgraph] Transient query error, retrying (${attempt + 1}/${this.queryRetryAttempts}): ${errorMsg}`,
          );
          continue;
        }

        console.error("[Memgraph] Query execution error:", errorMsg);
        console.error("[Memgraph] Error in query:", query.substring(0, 200));
        return {
          data: [],
          error: `Query failed: ${errorMsg}`,
        };
      } finally {
        await session.close();
      }
    }

    return {
      data: [],
      error: "Query failed: exhausted retry attempts",
    };
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
      const result = await this.executeCypher(
        statement.query,
        statement.params,
      );
      results.push(result);

      // Log errors but continue
      if (result.error) {
        console.error(`[Memgraph] Error in query: ${result.error}`);
      }
    }

    return results;
  }

  /**
   * Execute a natural language query and convert to Cypher
   * MVP: Simple pattern matching, production: use LLM service
   */
  async queryNaturalLanguage(query: string): Promise<QueryResult> {
    const cypher = this.naturalLanguageToCypher(query);
    return this.executeCypher(cypher);
  }

  /**
   * Convert common natural language patterns to Cypher
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

      const nodes = nodesResult.data.map((row: any) => ({
        id: row.id,
        type: row.type,
        properties: row.props || {},
      }));

      // Load all relationships for this projectId
      const relsResult = await this.executeCypher(
        `MATCH (n1 {projectId: $projectId})-[r]->(n2 {projectId: $projectId})
         RETURN n1.id AS from, n2.id AS to, type(r) AS type, properties(r) AS props`,
        { projectId },
      );

      const relationships = relsResult.data.map((row: any) => ({
        id: `${row.from}-${row.type}-${row.to}`,
        from: row.from,
        to: row.to,
        type: row.type,
        properties: row.props || {},
      }));

      return { nodes, relationships };
    } catch (error) {
      console.error(
        `[MemgraphClient] Failed to load project graph for ${projectId}:`,
        error,
      );
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
