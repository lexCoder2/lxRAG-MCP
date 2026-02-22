/**
 * Graph Index Manager
 * Tracks all nodes and relationships in the code graph
 * Provides in-memory index for query optimization
 */

export interface GraphNode {
  id: string;
  type: string;
  properties: Record<string, any>;
}

export interface GraphRelationship {
  id: string;
  from: string;
  to: string;
  type: string;
  properties?: Record<string, any>;
}

export interface GraphIndex {
  nodesByType: Map<string, GraphNode[]>;
  nodeById: Map<string, GraphNode>;
  relationshipsByFrom: Map<string, GraphRelationship[]>;
  relationshipsByTo: Map<string, GraphRelationship[]>;
  relationshipsByType: Map<string, GraphRelationship[]>;
  statistics: {
    totalNodes: number;
    totalRelationships: number;
    nodesByType: Record<string, number>;
    relationshipsByType: Record<string, number>;
  };
}

export class GraphIndexManager {
  private index: GraphIndex = {
    nodesByType: new Map(),
    nodeById: new Map(),
    relationshipsByFrom: new Map(),
    relationshipsByTo: new Map(),
    relationshipsByType: new Map(),
    statistics: {
      totalNodes: 0,
      totalRelationships: 0,
      nodesByType: {},
      relationshipsByType: {},
    },
  };

  /**
   * Add a node to the index
   */
  addNode(id: string, type: string, properties: Record<string, any>): void {
    if (this.index.nodeById.has(id)) {
      return; // Deduplication
    }

    const node: GraphNode = { id, type, properties };

    this.index.nodeById.set(id, node);

    if (!this.index.nodesByType.has(type)) {
      this.index.nodesByType.set(type, []);
    }
    this.index.nodesByType.get(type)!.push(node);

    this.index.statistics.totalNodes++;
    this.index.statistics.nodesByType[type] = (this.index.statistics.nodesByType[type] || 0) + 1;
  }

  /**
   * Add a relationship to the index
   */
  addRelationship(
    id: string,
    from: string,
    to: string,
    type: string,
    properties?: Record<string, any>,
  ): void {
    const rel: GraphRelationship = { id, from, to, type, properties };

    if (!this.index.relationshipsByFrom.has(from)) {
      this.index.relationshipsByFrom.set(from, []);
    }
    this.index.relationshipsByFrom.get(from)!.push(rel);

    if (!this.index.relationshipsByTo.has(to)) {
      this.index.relationshipsByTo.set(to, []);
    }
    this.index.relationshipsByTo.get(to)!.push(rel);

    if (!this.index.relationshipsByType.has(type)) {
      this.index.relationshipsByType.set(type, []);
    }
    this.index.relationshipsByType.get(type)!.push(rel);

    this.index.statistics.totalRelationships++;
    this.index.statistics.relationshipsByType[type] =
      (this.index.statistics.relationshipsByType[type] || 0) + 1;
  }

  /**
   * Query nodes by type
   */
  getNodesByType(type: string): GraphNode[] {
    return this.index.nodesByType.get(type) || [];
  }

  /**
   * Query node by ID
   */
  getNode(id: string): GraphNode | undefined {
    return this.index.nodeById.get(id);
  }

  /**
   * Query relationships from a node
   */
  getRelationshipsFrom(nodeId: string): GraphRelationship[] {
    return this.index.relationshipsByFrom.get(nodeId) || [];
  }

  /**
   * Query relationships to a node (Phase 7.1 - reverse lookup)
   */
  getRelationshipsTo(nodeId: string): GraphRelationship[] {
    return this.index.relationshipsByTo.get(nodeId) || [];
  }

  /**
   * Query relationships by type
   */
  getRelationshipsByType(type: string): GraphRelationship[] {
    return this.index.relationshipsByType.get(type) || [];
  }

  /**
   * Get graph statistics
   */
  getStatistics(): GraphIndex['statistics'] {
    return this.index.statistics;
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.index.nodesByType.clear();
    this.index.nodeById.clear();
    this.index.relationshipsByFrom.clear();
    this.index.relationshipsByTo.clear();
    this.index.relationshipsByType.clear();
    this.index.statistics = {
      totalNodes: 0,
      totalRelationships: 0,
      nodesByType: {},
      relationshipsByType: {},
    };
  }

  /**
   * Get all nodes in the index
   */
  getAllNodes(): GraphNode[] {
    return Array.from(this.index.nodeById.values());
  }

  /**
   * Get all relationships in the index
   */
  getAllRelationships(): GraphRelationship[] {
    return Array.from(this.index.relationshipsByType.values()).flat();
  }

  /**
   * Sync nodes and relationships from another index into this one
   * Used to merge orchestrator's built index into the shared context index
   */
  syncFrom(sourceIndex: GraphIndexManager): { nodesSynced: number; relationshipsSynced: number } {
    let nodesSynced = 0;
    let relationshipsSynced = 0;

    // Sync all nodes from source
    for (const node of sourceIndex.getAllNodes()) {
      try {
        this.addNode(node.id, node.type, node.properties);
        nodesSynced++;
      } catch (e) {
        // Deduplication may skip nodes - that's okay
      }
    }

    // Sync all relationships from source
    for (const rel of sourceIndex.getAllRelationships()) {
      try {
        this.addRelationship(rel.id, rel.from, rel.to, rel.type, rel.properties);
        relationshipsSynced++;
      } catch (e) {
        // Deduplication may skip relationships - that's okay
      }
    }

    return { nodesSynced, relationshipsSynced };
  }

  /**
   * Export index as JSON (for snapshots)
   */
  export(): string {
    return JSON.stringify(
      {
        nodesByType: Array.from(this.index.nodesByType.entries()),
        nodeById: Array.from(this.index.nodeById.entries()),
        statistics: this.index.statistics,
      },
      null,
      2,
    );
  }
}

export default GraphIndexManager;
