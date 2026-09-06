// Logging.
//
// Every log line carries the request id, so concurrent tabs can be told apart
// in a single terminal. Without that, six parallel requests interleave into
// noise and the timing questions ("why did this take 40s?") become unanswerable.

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
let threshold = LEVELS[process.env.UIBRIDGE_LOG ?? 'info'] ?? LEVELS.info

export function setLevel(name) {
  threshold = LEVELS[name] ?? threshold
}

const stamp = () => new Date().toISOString().slice(11, 23)

function emit(level, scope, msg) {
  if (LEVELS[level] > threshold) return
  const line = `${stamp()} ${level === 'info' ? '' : level.toUpperCase() + ' '}[${scope}] ${msg}`
  ;(level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n')
}

/** A logger bound to one scope, e.g. a request id or "pool:gemini". */
export function logger(scope) {
  return {
    scope,
    debug: (m) => emit('debug', scope, m),
    info: (m) => emit('info', scope, m),
    warn: (m) => emit('warn', scope, m),
    error: (m) => emit('error', scope, m),
    child: (sub) => logger(`${scope}:${sub}`),
  }
}

/** Short, sortable, unique enough to correlate a request across the log. */
export function requestId() {
  return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6)
}
