// electron-log replacement: in the browser everything goes to the console.
// Covers both import forms the renderer uses: `electron-log` and
// `electron-log/renderer` (aliased to this file in vite.config.mts).

interface TransportState {
  level: string | false
}

interface LogShape {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  verbose: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  silly: (...args: unknown[]) => void
  transports: { console: TransportState; file: TransportState; ipc: TransportState }
  scope: (name: string) => LogShape
}

let consoleLevel: string | false = 'info'

const shouldLog = (method: string): boolean => {
  if (consoleLevel === false) return false
  if (typeof consoleLevel !== 'string') return true
  const order = ['error', 'warn', 'info', 'verbose', 'debug', 'silly']
  return order.indexOf(method) <= order.indexOf(consoleLevel)
}

const createLogger = (scope?: string): LogShape => {
  const prefix = scope ? `[${scope}]` : ''
  const emit = (method: 'error' | 'warn' | 'info' | 'log', ...args: unknown[]): void => {
    if (!shouldLog(method === 'log' ? 'debug' : method)) return
    // eslint-disable-next-line no-console
    console[method](...(prefix ? [prefix, ...args] : args))
  }
  const logger: LogShape = {
    error: (...args) => emit('error', ...args),
    warn: (...args) => emit('warn', ...args),
    info: (...args) => emit('info', ...args),
    verbose: (...args) => emit('log', ...args),
    debug: (...args) => emit('log', ...args),
    silly: (...args) => emit('log', ...args),
    transports: {
      // Mutable transport state like electron-log; setting level to false
      // silences everything (bootstrap.ts does this in production).
      get console(): TransportState {
        return {
          get level(): string | false {
            return consoleLevel
          },
          set level(value: string | false) {
            consoleLevel = value
          }
        }
      },
      file: { level: false },
      ipc: { level: false }
    },
    scope: (name: string) => createLogger(name)
  }
  return logger
}

const logger = createLogger()

export default logger
export const {
  error,
  warn,
  info,
  verbose,
  debug,
  silly,
  scope
} = logger
export { logger }
export const transports = logger.transports
export const initialize = (): void => {}
export const functions = {}
