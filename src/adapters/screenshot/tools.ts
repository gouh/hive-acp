/**
 * Screenshot tool category — take screenshots of URLs via Puppeteer and send to chat.
 */

import puppeteer from "puppeteer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolCategory } from "../../mcp/types.js";
import type { ChatAdapter } from "../chat/types.js";

export function createScreenshotTools(adapter: ChatAdapter): ToolCategory {
  return {
    name: "screenshot",
    tools: [
      {
        name: "screenshot_url",
        description:
          "Take a screenshot of a URL and send it to the active chat. " +
          "Useful for previewing web pages, checking deployments, or sharing visual results.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to screenshot (e.g. https://example.com)" },
            full_page: { type: "boolean", description: "Capture the full scrollable page instead of just the viewport (default: false)" },
            width: { type: "number", description: "Viewport width in pixels (default: 1280)" },
            height: { type: "number", description: "Viewport height in pixels (default: 800)" },
            delay: { type: "number", description: "Seconds to wait after page load before taking the screenshot, useful for splash screens or animations (default: 0)" },
          },
          required: ["url"],
        },
      },
    ],

    async execute(toolName: string, args: any): Promise<string> {
      if (toolName !== "screenshot_url") throw new Error(`Unknown tool: ${toolName}`);

      const ctx = adapter.getActiveContext();
      if (!ctx) throw new Error("No active chat");

      const url: string = args.url;
      const fullPage: boolean = args.full_page ?? false;
      const width: number = args.width ?? 1280;
      const height: number = args.height ?? 800;
      const delay: number = Math.min(args.delay ?? 0, 30) * 1000;

      const tmpFile = path.join(os.tmpdir(), `screenshot-${Date.now()}.png`);

      const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width, height });
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        await page.screenshot({ path: tmpFile, fullPage });
      } finally {
        await browser.close();
      }

      try {
        await adapter.sendPhoto(ctx.chatId, tmpFile, url);
      } finally {
        fs.unlinkSync(tmpFile);
      }

      return `✅ Screenshot of ${url} sent to chat`;
    },
  };
}
