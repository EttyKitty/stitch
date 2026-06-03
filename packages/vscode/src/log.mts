import { Pathy } from '@bscotch/pathy';
import vscode from 'vscode';

export async function showErrorMessage<T extends string>(
  message: string | Error,
  ...items: T[]
) {
  return await vscode.window.showErrorMessage(
    typeof message === 'string' ? message : message.message,
    ...items,
  );
}

/**
 * Create a drop-in replacement for `console` that will
 * write to both STDI/O and to a VSCode output channel.
 */
export class Logger {
  static outputChannels = new Map<string, vscode.OutputChannel>();

  constructor(
    readonly channel: string,
    readonly prefix?: string,
  ) {
    if (!Logger.outputChannels.has(channel)) {
      Logger.outputChannels.set(
        channel,
        vscode.window.createOutputChannel(channel, 'stitch-logs'),
      );
    }
  }

  withPrefix(prefix: string) {
    return new Logger(this.channel, prefix);
  }

  get output() {
    return Logger.outputChannels.get(this.channel)!;
  }

  protected emit(type: 'debug' | 'info' | 'warn' | 'error', ...args: any[]) {
    const processedArgs = args.map((arg) => {
      const isObject = arg && typeof arg === 'object';
      if (isObject && 'uri' in arg && 'fsPath' in arg.uri) {
        arg = arg.uri;
      }
      if (isObject && 'fsPath' in arg) {
        arg = arg.fsPath;
      }
      if (isObject && arg instanceof Pathy) {
        arg = arg.relativeFrom(
          vscode.workspace.workspaceFolders![0].uri.fsPath,
        );
      }
      if (isObject && arg instanceof Error) {
        arg = stringifyError(arg, true);
      }
      if (isObject && arg.toString() === '[object Object]') {
        try {
          arg = JSON.stringify(arg);
        } catch {}
      }
      return arg;
    });
  
    const time = new Date().toISOString().replace(/^.*T(.*)Z$/, '$1');
    const level = type.toUpperCase();
    const metadata = [time, level];
    if (this.prefix) {
      metadata.push(`[${this.prefix}]`);
    }
    const message = processedArgs.join(' ');
    const line = [...metadata, message].join(' | ');
    this.output.appendLine(line);
    console[type](this.channel, ...metadata, ...processedArgs);
  }

  log(...args: any[]) {
    this.emit('info', ...args);
  }

  debug(...args: any[]) {
    this.emit('debug', ...args);
  }

  info(...args: any[]) {
    this.emit('info', ...args);
  }

  warn(...args: any[]) {
    this.emit('warn', ...args);
  }

  error(...args: any[]) {
    this.emit('error', ...args);
  }

  dir(obj: any, options?: any) {
    this.output.appendLine(JSON.stringify(obj, null, 2));
    console.dir(obj, options);
  }
}

export const logger = new Logger('Stitch', 'EXTENSION');

export function info(...args: any[]) {
  logger.info(...args);
}

export function warn(...args: any[]) {
  logger.warn(...args);
}

export class Timer {
  start = Date.now();
  restart() {
    this.start = Date.now();
  }
  millis(message: string) {
    info(message, Date.now() - this.start, 'millis');
  }
  seconds(message: string) {
    info(message, (Date.now() - this.start) / 1000, 'seconds');
  }

  static start() {
    const timer = new Timer();
    return timer;
  }
}

function stringifyError(error: Error, includeStack = false, indent = 0) {
  const indentation = '  '.repeat(indent);
  const lines = [
    `${indentation}${indent === 0 ? 'ERROR' : 'CAUSE'}: ${error.message}`,
  ];
  if (includeStack && error.stack) {
    lines.push(
      ...error.stack.split(/[\r\n]/).map((line) => `${indentation}${line}`),
    );
  }
  if (error.cause && error.cause instanceof Error) {
    lines.push(stringifyError(error.cause, includeStack, indent + 1));
  }
  return lines.join('\n');
}

export function getErrorMessage(error: unknown): string {
  let combinedMessage = '';
  if (error instanceof Error) {
    if (
      'message' in error &&
      typeof error.message === 'string' &&
      error.message.length
    ) {
      combinedMessage = error.message;
    }
    if ('cause' in error && error.cause instanceof Error) {
      const causeError = getErrorMessage(error.cause);
      if (combinedMessage && causeError) {
        combinedMessage += ` ← ${causeError}`;
      } else if (causeError) {
        combinedMessage = causeError;
      }
    }
  }
  return combinedMessage;
}
