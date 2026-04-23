import fs from "node:fs";
import path from "node:path";

const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf-8"));

export const pkg = { name: raw.name as string, version: raw.version as string };
