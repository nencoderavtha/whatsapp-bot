import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

export interface LoggerContext {
  correlationId: string;
  restaurantId?: number;
  customerId?: number;
  phone?: string;
  [key: string]: any;
}

export const loggerContext = new AsyncLocalStorage<LoggerContext>();

// Base Pino logger
const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Proxy logger that automatically injects the current AsyncLocalStorage context
 * into every log statement.
 */
export interface ForgivingLogger extends pino.Logger {
  info(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
  debug(...args: any[]): void;
}

export const logger = new Proxy(baseLogger, {
  get(target, property: keyof pino.Logger) {
    if (typeof target[property] === 'function' && ['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(property as string)) {
      return (...args: any[]) => {
        const store = loggerContext.getStore() || {};
        
        let obj: any = { ...store };
        let msgArgs: any[] = [];

        // Find if there's an Error object to extract
        const errIndex = args.findIndex(a => a instanceof Error);
        if (errIndex !== -1) {
          obj.err = args[errIndex];
          // Remove the error from args so it doesn't print twice
          args.splice(errIndex, 1);
        }

        if (args.length > 0) {
          if (typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
            obj = { ...obj, ...args[0] };
            msgArgs = args.slice(1);
          } else {
            msgArgs = args;
          }
        }

        if (msgArgs.length === 0) {
          return (target[property] as any)(obj);
        } else if (msgArgs.length === 1 && typeof msgArgs[0] === 'string') {
          return (target[property] as any)(obj, msgArgs[0]);
        } else {
          // If there are multiple arguments or non-string, just use them as the message array
          // Pino will use util.format on msgArgs if the first is a string
          return (target[property] as any)(obj, ...msgArgs);
        }
      };
    }
    return target[property];
  },
}) as unknown as ForgivingLogger;

/**
 * Run a function within a new logging context.
 */
export function runWithContext<T>(context: Partial<LoggerContext>, fn: () => T): T {
  const store = loggerContext.getStore() || {};
  const newContext = {
    correlationId: crypto.randomUUID(),
    ...store,
    ...context,
  };
  return loggerContext.run(newContext, fn);
}

/**
 * Get current context or correlation ID
 */
export function getCorrelationId(): string | undefined {
  return loggerContext.getStore()?.correlationId;
}
