import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import util from 'util';

export interface LoggerContext {
  correlationId: string;
  restaurantId?: number;
  customerId?: number;
  phone?: string;
  [key: string]: any;
}

export const loggerContext = new AsyncLocalStorage<LoggerContext>();

const isPretty = process.env.LOG_FORMAT !== 'json';
const logLevel = process.env.LOG_LEVEL || 'info';

const LEVEL_WEIGHTS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const currentLevelWeight = LEVEL_WEIGHTS[logLevel.toLowerCase()] ?? 30;

// ANSI Colors for Pretty Output
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bright: '\x1b[1m',
  info: '\x1b[36m',    // Cyan
  warn: '\x1b[33m',    // Yellow
  error: '\x1b[31m',   // Red
  debug: '\x1b[35m',   // Magenta
  trace: '\x1b[90m',   // Gray
  context: '\x1b[34m', // Blue
  time: '\x1b[90m',    // Gray
};

function formatTimestamp(): string {
  const d = new Date();
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  const secs = String(d.getSeconds()).padStart(2, '0');
  return `${hours}:${mins}:${secs}`;
}

function formatLevel(level: string): string {
  const upper = level.toUpperCase().padEnd(5);
  switch (level.toLowerCase()) {
    case 'info':
      return `${COLORS.info}${COLORS.bright}[${upper}]${COLORS.reset}`;
    case 'warn':
      return `${COLORS.warn}${COLORS.bright}[${upper}]${COLORS.reset}`;
    case 'error':
    case 'fatal':
      return `${COLORS.error}${COLORS.bright}[${upper}]${COLORS.reset}`;
    case 'debug':
      return `${COLORS.debug}${COLORS.bright}[${upper}]${COLORS.reset}`;
    default:
      return `${COLORS.trace}[${upper}]${COLORS.reset}`;
  }
}

function formatContext(store?: LoggerContext): string {
  if (!store) return '';
  const parts: string[] = [];
  if (store.correlationId) parts.push(`cid:${store.correlationId.slice(0, 8)}`);
  if (store.phone) parts.push(`phone:${store.phone}`);
  if (store.restaurantId) parts.push(`r:${store.restaurantId}`);
  if (store.customerId) parts.push(`c:${store.customerId}`);

  if (parts.length === 0) return '';
  return `${COLORS.context}(${parts.join(' | ')})${COLORS.reset} `;
}

function prettyOutput(level: string, args: any[], store?: LoggerContext) {
  const timeStr = `${COLORS.time}${formatTimestamp()}${COLORS.reset}`;
  const levelStr = formatLevel(level);
  const ctxStr = formatContext(store);

  const formattedParts: string[] = [];

  for (const arg of args) {
    if (typeof arg === 'string') {
      formattedParts.push(arg);
    } else if (arg instanceof Error) {
      const errHeader = `${COLORS.error}${arg.name}: ${arg.message}${COLORS.reset}`;
      const stack = arg.stack ? `\n${COLORS.dim}${arg.stack}${COLORS.reset}` : '';
      formattedParts.push(`${errHeader}${stack}`);
    } else if (typeof arg === 'object' && arg !== null) {
      formattedParts.push(
        util.inspect(arg, {
          colors: true,
          depth: 4,
          compact: false,
          maxArrayLength: 20,
        })
      );
    } else {
      formattedParts.push(String(arg));
    }
  }

  const message = formattedParts.join(' ');
  const prefix = `${timeStr} ${levelStr} ${ctxStr}`;

  if (level === 'error' || level === 'fatal') {
    console.error(`${prefix}${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix}${message}`);
  } else {
    console.log(`${prefix}${message}`);
  }
}

// Base Pino logger (used if LOG_FORMAT=json)
const baseLogger = pino({
  level: logLevel,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export interface ForgivingLogger extends pino.Logger {
  info(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
  debug(...args: any[]): void;
}

export const logger = new Proxy(baseLogger, {
  get(target, property: keyof pino.Logger) {
    if (
      typeof target[property] === 'function' &&
      ['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(property as string)
    ) {
      return (...args: any[]) => {
        const levelName = property as string;
        const weight = LEVEL_WEIGHTS[levelName] ?? 30;

        if (weight < currentLevelWeight) return;

        const store = loggerContext.getStore();

        if (isPretty) {
          prettyOutput(levelName, args, store);
          return;
        }

        // Standard Pino JSON logging
        let obj: any = { ...store };
        let msgArgs: any[] = [];

        const errIndex = args.findIndex((a) => a instanceof Error);
        if (errIndex !== -1) {
          obj.err = args[errIndex];
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
