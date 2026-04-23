import fs from "node:fs";
import path from "node:path";

const envPath = path.join(import.meta.dirname, "..", "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const [key, ...val] = line.split("=");
    if (key && !key.startsWith("#")) {
      process.env[key.trim()] = val.join("=").trim();
    }
  }
}
