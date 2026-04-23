import { config } from "dotenv";
import path from "node:path";

config({ path: path.join(import.meta.dirname, "..", "..", ".env") });
