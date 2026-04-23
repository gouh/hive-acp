import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

const root = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            messageFormat: "[{module}] {msg}",
          },
        },
      }
    : {
        formatters: {
          level: (label: string) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});

export const log = {
  acp: root.child({ module: "acp" }),
  telegram: root.child({ module: "telegram" }),
  mcp: root.child({ module: "mcp" }),
  main: root.child({ module: "main" }),
};
