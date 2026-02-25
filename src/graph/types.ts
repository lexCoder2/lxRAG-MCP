/**
 * @file graph/types
 * @description Shared low-level graph write/query type contracts.
 */

export interface CypherStatement {
  query: string;
  params: Record<string, any>;
}
