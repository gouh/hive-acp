import pino from "pino";

const root = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label: string) => ({ level: label }),
    bindings: () => ({}),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const log = {
  acp: root.child({ module: "acp" }),
  telegram: root.child({ module: "telegram" }),
  mcp: root.child({ module: "mcp" }),
  main: root.child({ module: "main" }),
};
