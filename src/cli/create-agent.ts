#!/usr/bin/env tsx
/**
 * Interactive CLI to create hive-acp agents.
 * Usage: npm run create-agent
 *
 * Supports both Kiro (JSON in ~/.kiro/agents/) and OpenCode (Markdown in ~/.config/opencode/agents/).
 * Registers all agents in ~/.hive-acp/agents.json for the ProviderRegistry.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";

const HIVE_HOME = path.join(os.homedir(), ".hive-acp");
const HIVE_SKILLS_DIR = path.join(HIVE_HOME, "skills");
const AGENTS_DB = path.join(HIVE_HOME, "agents.json");
const KIRO_AGENTS_DIR = path.join(os.homedir(), ".kiro", "agents");
const OPENCODE_AGENTS_DIR = path.join(os.homedir(), ".config", "opencode", "agents");
const BRIDGE_PATH = path.join(import.meta.dirname, "..", "..", "dist", "mcp", "bridge.js");

interface AgentRecord {
  name: string;
  provider: string;
  description: string;
}

function loadDb(): AgentRecord[] {
  if (!fs.existsSync(AGENTS_DB)) return [];
  try { return JSON.parse(fs.readFileSync(AGENTS_DB, "utf-8")); } catch { return []; }
}

function saveDb(records: AgentRecord[]): void {
  fs.mkdirSync(HIVE_HOME, { recursive: true });
  fs.writeFileSync(AGENTS_DB, JSON.stringify(records, null, 2), "utf-8");
}

function listSkills(): string[] {
  if (!fs.existsSync(HIVE_SKILLS_DIR)) return [];
  return fs.readdirSync(HIVE_SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(HIVE_SKILLS_DIR, d.name, "SKILL.md")))
    .map((d) => d.name);
}

async function ask(rl: readline.Interface, question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || "";
}

async function askMultiline(rl: readline.Interface, question: string): Promise<string> {
  console.log(`${question} (empty line to finish):`);
  const lines: string[] = [];
  for (;;) {
    const line = await rl.question("  ");
    if (line.trim() === "") break;
    lines.push(line);
  }
  return lines.join("\n");
}

async function askChoice(rl: readline.Interface, question: string, options: string[]): Promise<string> {
  console.log(`\n${question}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  for (;;) {
    const answer = (await rl.question("Choose (number): ")).trim();
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
    console.log("  Invalid option.");
  }
}

async function askSkills(rl: readline.Interface): Promise<string[]> {
  const available = listSkills();
  if (available.length === 0) {
    console.log("\n⚠️  No skills found in ~/.hive-acp/skills/");
    return [];
  }
  console.log("\n📋 Available skills:");
  available.forEach((s, i) => console.log(`  ${i + 1}) ${s}`));
  console.log(`  0) None`);
  const answer = (await rl.question("Skills (comma-separated numbers): ")).trim();
  if (answer === "0" || answer === "") return [];
  return answer.split(",")
    .map((n) => parseInt(n.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < available.length)
    .map((i) => available[i]);
}

function createKiroAgent(name: string, description: string, prompt: string, _skills: string[]): string {
  const config = {
    name,
    description,
    prompt: `${prompt}\n\nFORMATO:\n- Respondes vía Telegram. Sigue la skill de telegram-formatting para formatear tus mensajes correctamente.`,
    tools: ["*"],
    resources: ["skill://~/.hive-acp/skills/*/SKILL.md"],
    mcpServers: {
      "hive-acp": {
        command: "node",
        args: [path.resolve(BRIDGE_PATH)],
      },
    },
  };

  fs.mkdirSync(KIRO_AGENTS_DIR, { recursive: true });
  const filePath = path.join(KIRO_AGENTS_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
  return filePath;
}

function createOpencodeAgent(name: string, description: string, prompt: string, _skills: string[]): string {
  const md = `---
description: ${description}
mode: subagent
permission:
  edit: allow
  bash: allow
  read: allow
  glob: allow
  grep: allow
---

${prompt}

FORMATO:
- Respondes vía Telegram. Usa *bold* (un solo asterisco) para títulos, bullets para listas, emojis para legibilidad. No uses headers (#), tablas, ni HTML.
`;

  fs.mkdirSync(OPENCODE_AGENTS_DIR, { recursive: true });
  const filePath = path.join(OPENCODE_AGENTS_DIR, `${name}.md`);
  fs.writeFileSync(filePath, md, "utf-8");
  return filePath;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n🐝 Hive ACP — Create agent\n");

  const name = await ask(rl, "Agent name");
  if (!name) { console.log("❌ Name is required."); rl.close(); return; }

  const description = await ask(rl, "Short description");
  if (!description) { console.log("❌ Description is required."); rl.close(); return; }

  console.log("\n📝 Agent prompt:");
  const prompt = await askMultiline(rl, "Prompt");
  if (!prompt) { console.log("❌ Prompt is required."); rl.close(); return; }

  const skills = await askSkills(rl);
  const provider = await askChoice(rl, "Which provider?", ["kiro", "opencode"]);

  const filePath = provider === "kiro"
    ? createKiroAgent(name, description, prompt, skills)
    : createOpencodeAgent(name, description, prompt, skills);

  if (provider === "opencode") {
    const db = loadDb().filter((a) => a.name !== name);
    db.push({ name, provider, description });
    saveDb(db);
  }

  console.log(`\n✅ Agent created:`);
  console.log(`   File:      ${filePath}`);
  console.log(`   Provider:  ${provider}`);
  console.log(`   Skills:    ${skills.length > 0 ? skills.join(", ") : "none"}`);
  if (provider === "opencode") {
    console.log(`   Registry:  ${AGENTS_DB}`);
  }

  rl.close();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
