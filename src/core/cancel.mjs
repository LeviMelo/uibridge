import { AsyncLocalStorage } from 'node:async_hooks'
import { BridgeError } from './errors.mjs'

const scope = new AsyncLocalStorage()
export const currentSignal = () => scope.getStore()
export const withCancellation = (signal, fn) => scope.run(signal, fn)
export const cancellationError = () => new BridgeError('Request cancelled; provider-side generation may already have started', {
  status: 499, code: 'request_cancelled', retryable: false,
})
export function checkCancelled(signal = currentSignal()) {
  if (signal?.aborted) throw signal.reason instanceof BridgeError ? signal.reason : cancellationError()
}

/** Observe the underlying promise even after abort, so late failures are handled. */
export function abortable(work, signal = currentSignal()) {
  if (!signal) return Promise.resolve(work)
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted)
      try { checkCancelled(signal) } catch (err) { reject(err) }
    }
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
  })
}
