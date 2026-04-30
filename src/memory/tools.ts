/**
 * Memory tool category — MCP tools for the triple store knowledge graph.
 */

import type { ToolCategory } from "../mcp/types.js";
import type { TripleStore } from "./store.js";

export function createMemoryTools(store: TripleStore): ToolCategory {
  return {
    name: "memory",
    tools: [
      {
        name: "memory_search",
        description:
          "Search the knowledge graph for facts about an entity. " +
          "Returns matching triples as readable text.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Entity name or keyword to search",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "memory_add",
        description:
          "Store a fact in the knowledge graph as a subject-predicate-object triple. " +
          "Use for concrete facts worth remembering across sessions. " +
          "Example: subject='Defensa', predicate='uses', object='PostgreSQL'",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string", description: "The entity (e.g. project name, person)" },
            predicate: { type: "string", description: "The relationship (e.g. uses, has_module, decided)" },
            object: { type: "string", description: "The value (e.g. PostgreSQL, auth module)" },
          },
          required: ["subject", "predicate", "object"],
        },
      },
      {
        name: "memory_forget",
        description:
          "Remove a specific fact from the knowledge graph. " +
          "All three fields must match exactly.",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            predicate: { type: "string" },
            object: { type: "string" },
          },
          required: ["subject", "predicate", "object"],
        },
      },
    ],

    async execute(toolName: string, args: any): Promise<string> {
      switch (toolName) {
        case "memory_search": {
          const results = store.search(args.query);
          if (results.length === 0) return `No facts found for "${args.query}"`;
          return results.map((t) => `${t.s} ${t.p} ${t.o}`).join("\n");
        }
        case "memory_add": {
          store.add(args.subject, args.predicate, args.object);
          return `✅ Stored: ${args.subject} ${args.predicate} ${args.object}`;
        }
        case "memory_forget": {
          const removed = store.remove(args.subject, args.predicate, args.object);
          return removed
            ? `✅ Removed: ${args.subject} ${args.predicate} ${args.object}`
            : `ℹ️ No matching fact found`;
        }
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    },
  };
}
