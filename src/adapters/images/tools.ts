/**
 * Images tool category — search and send free stock photos via Pexels API.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolCategory } from "../../mcp/types.js";
import type { ChatAdapter } from "../chat/types.js";

const PEXELS_API = "https://api.pexels.com/v1";

export function createImageTools(adapter: ChatAdapter): ToolCategory {
  const apiKey = process.env.HIVE_PEXELS_KEY || "";

  return {
    name: "images",
    tools: [
      {
        name: "images_search",
        description:
          "Search for free stock photos on Pexels and send the best match to the active chat. " +
          "Use when the user asks for an image, photo, or picture of something.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query (e.g. 'sunset beach', 'cat programming')" },
            count: { type: "number", description: "Number of photos to send (default: 1, max: 5)" },
          },
          required: ["query"],
        },
      },
    ],

    async execute(toolName: string, args: any): Promise<string> {
      if (toolName !== "images_search") throw new Error(`Unknown tool: ${toolName}`);
      if (!apiKey) throw new Error("HIVE_PEXELS_KEY not configured");

      const ctx = adapter.getActiveContext();
      if (!ctx) throw new Error("No active chat");

      const query: string = args.query;
      const count = Math.min(Math.max(args.count ?? 1, 1), 5);

      const res = await fetch(`${PEXELS_API}/search?query=${encodeURIComponent(query)}&per_page=${count}`, {
        headers: { Authorization: apiKey },
      });
      if (!res.ok) throw new Error(`Pexels API error: ${res.status}`);

      const data = (await res.json()) as { photos: Array<{ src: { large: string }; photographer: string; alt: string }> };
      if (!data.photos?.length) return `No photos found for "${query}"`;

      for (const photo of data.photos) {
        const imgRes = await fetch(photo.src.large);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const tmpFile = path.join(os.tmpdir(), `pexels-${Date.now()}.jpg`);
        fs.writeFileSync(tmpFile, buffer);
        try {
          await adapter.sendPhoto(ctx.chatId, tmpFile, `📷 ${photo.alt || query} — by ${photo.photographer} (Pexels)`);
        } finally {
          fs.unlinkSync(tmpFile);
        }
      }

      return `✅ Sent ${data.photos.length} photo(s) for "${query}"`;
    },
  };
}
