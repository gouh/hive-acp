import { createConsola } from "consola";

const level = process.env.LOG_LEVEL ? Number(process.env.LOG_LEVEL) : 3;

export const log = {
  acp: createConsola({ level }).withTag("acp"),
  telegram: createConsola({ level }).withTag("telegram"),
  mcp: createConsola({ level }).withTag("mcp"),
  main: createConsola({ level }).withTag("main"),
};
