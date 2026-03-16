import pino from 'pino';

// Default to 'warn' so the human-readable live feed is not buried in JSON noise.
// Set LOG_LEVEL=info or LOG_LEVEL=debug explicitly for verbose pino output.
const level = process.env.LOG_LEVEL || 'warn';

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
