import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  transport: {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createModuleLogger(module: string) {
  return logger.child({ module });
}
