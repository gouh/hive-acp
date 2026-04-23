import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

const root = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

export const log = {
  acp: root.child({ module: "acp" }),
  telegram: root.child({ module: "telegram" }),
  mcp: root.child({ module: "mcp" }),
  main: root.child({ module: "main" }),
};
