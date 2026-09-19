// Deterministic structured logger.
// Collects entries into an array (sink) for assertions; optional console echo.
export function createLogger(opts = {}) {
  const sink = opts.sink ?? [];
  const nowFn = opts.now ?? (() => Date.now());
  let seq = 0;
  function emit(level, msg, meta = {}) {
    const entry = { seq: ++seq, ts: nowFn(), level, msg, ...meta };
    sink.push(entry);
    if (opts.console) console.log(JSON.stringify(entry));
    return entry;
  }
  return {
    sink,
    info: (m, meta) => emit('INFO', m, meta),
    warn: (m, meta) => emit('WARN', m, meta),
    error: (m, meta) => emit('ERROR', m, meta),
    debug: (m, meta) => emit('DEBUG', m, meta),
  };
}
