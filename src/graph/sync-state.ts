/**
 * Sync State Manager
 * Tracks synchronization state of each system component
 * Phase 3.3: State machine for comprehensive system health
 */

import * as env from "../env.js";

export type SyncState = "uninitialized" | "synced" | "drifted" | "rebuilding";

export interface SystemHealth {
  memgraph: SyncState;
  index: SyncState;
  qdrant: SyncState;
  embeddings: SyncState;
}

export class SyncStateManager {
  private state: SystemHealth = {
    memgraph: "uninitialized",
    index: "uninitialized",
    qdrant: "uninitialized",
    embeddings: "uninitialized",
  };

  private stateHistory: Array<{ timestamp: number; state: SystemHealth }> = [];
  // Phase 4.6: Use configurable history size limit
  private maxHistorySize = env.LXRAG_STATE_HISTORY_MAX_SIZE;

  constructor(private projectId: string) {
    console.log(
      `[SyncStateManager] Initialized for project ${projectId}`,
    );
  }

  /**
   * Update state of a specific system
   */
  setState(system: keyof SystemHealth, newState: SyncState): void {
    const oldState = this.state[system];
    if (oldState === newState) return;

    this.state[system] = newState;
    console.log(
      `[SyncState:${this.projectId}] ${system}: ${oldState} → ${newState}`,
    );

    // Record history
    this.recordHistory();
  }

  /**
   * Get current state of a specific system
   */
  getSystemState(system: keyof SystemHealth): SyncState {
    return this.state[system];
  }

  /**
   * Get complete system health snapshot
   */
  getState(): SystemHealth {
    return { ...this.state };
  }

  /**
   * Check if system is healthy (all components synced)
   */
  isHealthy(): boolean {
    return Object.values(this.state).every((s) => s === "synced");
  }

  /**
   * Check if system is drifted
   */
  isDrifted(): boolean {
    return Object.values(this.state).some((s) => s === "drifted");
  }

  /**
   * Find first system that needs sync
   */
  needsSync(): keyof SystemHealth | null {
    for (const [system, state] of Object.entries(this.state)) {
      if (state !== "synced" && state !== "rebuilding") {
        return system as keyof SystemHealth;
      }
    }
    return null;
  }

  /**
   * Get all systems that need attention
   */
  getDriftedSystems(): (keyof SystemHealth)[] {
    return Object.entries(this.state)
      .filter(([_, state]) => state === "drifted")
      .map(([system, _]) => system as keyof SystemHealth);
  }

  /**
   * Mark all systems as rebuilding
   */
  startRebuild(): void {
    console.log(`[SyncState:${this.projectId}] Starting rebuild - all systems rebuilding`);
    this.setState("memgraph", "rebuilding");
    this.setState("index", "rebuilding");
    this.setState("qdrant", "rebuilding");
    this.setState("embeddings", "rebuilding");
  }

  /**
   * Mark all systems as synced after rebuild
   */
  completeRebuild(): void {
    console.log(`[SyncState:${this.projectId}] Rebuild complete - all systems synced`);
    this.setState("memgraph", "synced");
    this.setState("index", "synced");
    this.setState("qdrant", "synced");
    this.setState("embeddings", "synced");
  }

  /**
   * Mark incremental build - index and embeddings need sync
   */
  startIncrementalRebuild(): void {
    console.log(`[SyncState:${this.projectId}] Starting incremental rebuild`);
    this.setState("index", "rebuilding");
    this.setState("embeddings", "rebuilding");
  }

  /**
   * Complete incremental build
   */
  completeIncrementalRebuild(): void {
    console.log(`[SyncState:${this.projectId}] Incremental rebuild complete`);
    this.setState("index", "synced");
    this.setState("embeddings", "synced");
  }

  /**
   * Record state snapshot to history
   */
  private recordHistory(): void {
    this.stateHistory.push({
      timestamp: Date.now(),
      state: { ...this.state },
    });

    // Keep history size bounded
    if (this.stateHistory.length > this.maxHistorySize) {
      this.stateHistory.shift();
    }
  }

  /**
   * Get state history
   */
  getHistory(limit: number = 10): Array<{ timestamp: number; state: SystemHealth }> {
    return this.stateHistory.slice(-limit);
  }

  /**
   * Get diagnostics summary
   */
  getDiagnostics(): {
    healthy: boolean;
    drifted: boolean;
    needsSync: keyof SystemHealth | null;
    state: SystemHealth;
    driftedSystems: (keyof SystemHealth)[];
    recommendations: string[];
  } {
    const recommendations: string[] = [];

    if (!this.isHealthy()) {
      const drifted = this.getDriftedSystems();
      if (drifted.length > 0) {
        recommendations.push(
          `Systems are drifted: ${drifted.join(", ")}. Run graph_rebuild to resync.`,
        );
      }

      const needsSync = this.needsSync();
      if (needsSync) {
        recommendations.push(
          `${needsSync} needs sync. Run graph_rebuild to synchronize.`,
        );
      }
    }

    const rebuilding = Object.entries(this.state)
      .filter(([_, s]) => s === "rebuilding")
      .map(([k]) => k as keyof SystemHealth);

    if (rebuilding.length > 0) {
      recommendations.push(
        `Systems are rebuilding: ${rebuilding.join(", ")}. Wait for rebuild to complete.`,
      );
    }

    if (this.isHealthy()) {
      recommendations.push("System is healthy - all components synchronized.");
    }

    return {
      healthy: this.isHealthy(),
      drifted: this.isDrifted(),
      needsSync: this.needsSync(),
      state: this.getState(),
      driftedSystems: this.getDriftedSystems(),
      recommendations,
    };
  }

  /**
   * Reset to initial state
   */
  reset(): void {
    console.log(`[SyncState:${this.projectId}] Resetting sync state`);
    this.state = {
      memgraph: "uninitialized",
      index: "uninitialized",
      qdrant: "uninitialized",
      embeddings: "uninitialized",
    };
    this.stateHistory = [];
  }
}

export default SyncStateManager;
