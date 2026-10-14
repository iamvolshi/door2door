import { serializeError, AppError } from './errors';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface LogContext {
  userId?: string;
  requestId?: string;
  action?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StructuredLogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
  error?: ReturnType<typeof serializeError>;
}

export type TelemetryHook = (entry: StructuredLogEntry) => void;

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'jwt',
  'secret',
  'authorization',
  'creditcard',
  'cvv',
  'pin',
  'apikey',
  'api_key',
  'phone_number',
  'national_id'
]);

export function scrubSensitiveData<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => scrubSensitiveData(item)) as unknown as T;
  }

  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      scrubbed[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      scrubbed[key] = scrubSensitiveData(value);
    } else {
      scrubbed[key] = value;
    }
  }

  return scrubbed as T;
}

export class Logger {
  private minLevel: LogLevel = 'info';
  private telemetryHooks: TelemetryHook[] = [];
  private outStream: (line: string) => void = console.log;

  constructor(level: LogLevel = 'info', outStream?: (line: string) => void) {
    this.minLevel = level;
    if (outStream) {
      this.outStream = outStream;
    }
  }

  public setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  public setOutputStream(stream: (line: string) => void): void {
    this.outStream = stream;
  }

  public addTelemetryHook(hook: TelemetryHook): void {
    this.telemetryHooks.push(hook);
  }

  public clearTelemetryHooks(): void {
    this.telemetryHooks = [];
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel];
  }

  private write(level: LogLevel, message: string, context?: LogContext, error?: unknown): StructuredLogEntry {
    const scrubbedContext = context ? (scrubSensitiveData(context) as Record<string, unknown>) : undefined;
    const serializedError = error ? serializeError(error, level === 'error') : undefined;

    const entry: StructuredLogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(scrubbedContext ? { context: scrubbedContext } : {}),
      ...(serializedError ? { error: serializedError } : {})
    };

    if (this.shouldLog(level)) {
      this.outStream(JSON.stringify(entry));
    }

    if (level === 'error' && this.telemetryHooks.length > 0) {
      for (const hook of this.telemetryHooks) {
        try {
          hook(entry);
        } catch (hookErr) {
          console.error('[Logger] Telemetry hook failed:', hookErr);
        }
      }
    }

    return entry;
  }

  public debug(message: string, context?: LogContext): StructuredLogEntry {
    return this.write('debug', message, context);
  }

  public info(message: string, context?: LogContext): StructuredLogEntry {
    return this.write('info', message, context);
  }

  public warn(message: string, context?: LogContext, error?: unknown): StructuredLogEntry {
    return this.write('warn', message, context, error);
  }

  public error(message: string, error?: unknown, context?: LogContext): StructuredLogEntry {
    return this.write('error', message, context, error);
  }
}

export const logger = new Logger();