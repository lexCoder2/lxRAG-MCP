export interface CypherStatement {
  query: string;
  params: Record<string, any>;
}
