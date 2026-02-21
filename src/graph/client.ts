import type { CypherStatement } from "./types";
import neo4j from "neo4j-driver";

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

  constructor(config: Partial<MemgraphConfig> = {}) {
    this.config = {
      host: config.host || "localhost",
      port: config.port || 7687,
      username: config.username || "memgraph",
      password: config.password || "",
    };

    this.driver = this.createDriver(this.config.host);

    const boltUrl = `bolt://${this.config.host}:${this.config.port}`;

    console.log(`[MemgraphClient] Initialized with Bolt URL:`, boltUrl);
  }

  async connect(): Promise<void> {
    try {
      // Verify connection by running a simple query
      const session = this.driver.session();
      await session.run("RETURN 1");
      await session.close();
      this.connected = true;
      console.log("[Memgraph] Connected successfully via Bolt protocol");
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
        console.log("[Memgraph] Connected successfully via Bolt protocol");
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

    return neo4j.driver(boltUrl, authToken, {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 10000,
      connectionLivenessCheckTimeout: 5000,
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
      console.log("[Memgraph] Disconnected");
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

    const session = this.driver.session();
    try {
      // Sanitize params: replace undefined with null (Bolt requires explicit null)
      const sanitizedParams = Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, v === undefined ? null : v]),
      );

      const result = await session.run(query, sanitizedParams);
      const data = result.records.map((record: any) => record.toObject());

      return {
        data,
        error: undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
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
   * Check connection status
   */
  isConnected(): boolean {
    return this.connected;
  }
}

export default MemgraphClient;
