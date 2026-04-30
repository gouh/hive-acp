/**
 * Triple — Subject-Predicate-Object fact stored in the knowledge graph.
 */

export interface Triple {
  s: string;
  p: string;
  o: string;
  t: number;
}
