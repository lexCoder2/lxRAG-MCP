/**
 * @file graph/index
 * @description In-memory graph index for nodes, relationships, and fast lookups.
 * @remarks Acts as the primary runtime cache for tool and engine query operations.
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
  addNode(id: string, type: string, properties: Record<string, any>, overwrite = false): void {
    const existing = this.index.nodeById.get(id);
    if (existing) {
      if (!overwrite) {
        return; // Deduplication
      }

      const mergedNode: GraphNode = {
        id: existing.id,
        type,
        properties: {
          ...existing.properties,
          ...properties,
        },
      };

      this.index.nodeById.set(id, mergedNode);

      const typeNodes = this.index.nodesByType.get(existing.type) || [];
      const idx = typeNodes.findIndex((node) => node.id === id);
      if (idx >= 0) {
        typeNodes.splice(idx, 1);
      }

      if (!this.index.nodesByType.has(type)) {
        this.index.nodesByType.set(type, []);
      }
      this.index.nodesByType.get(type)!.push(mergedNode);

      if (existing.type !== type) {
        this.index.statistics.nodesByType[existing.type] = Math.max(
          (this.index.statistics.nodesByType[existing.type] || 1) - 1,
          0,
        );
        this.index.statistics.nodesByType[type] =
          (this.index.statistics.nodesByType[type] || 0) + 1;
      }

      return;
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
  getStatistics(): GraphIndex["statistics"] {
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
  syncFrom(sourceIndex: GraphIndexManager): {
    nodesSynced: number;
    relationshipsSynced: number;
  } {
    let nodesSynced = 0;
    let relationshipsSynced = 0;

    // Sync all nodes from source
    for (const node of sourceIndex.getAllNodes()) {
      this.addNode(node.id, node.type, node.properties, true);
      nodesSynced++;
    }

    // Sync all relationships from source
    for (const rel of sourceIndex.getAllRelationships()) {
      try {
        this.addRelationship(rel.id, rel.from, rel.to, rel.type, rel.properties);
        relationshipsSynced++;
      } catch (_e) {
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
