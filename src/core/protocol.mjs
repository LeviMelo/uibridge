// Identity of the local daemon protocol. A random process on the configured
// port must never receive prompts merely because it has a `/health` route.
export const SERVICE_ID = 'uibridge'
export const PROTOCOL_VERSION = 1

/**
 * What is answering the port?
 *
 *   ours              this build; safe to send prompts to
 *   version-mismatch  a uibridge speaking another protocol
 *   legacy            unidentified, but shaped exactly like our /health -
 *                     a uibridge from before identity was added
 *   foreign           something else entirely
 *   absent            nothing listening
 *
 * `legacy` exists because identity was added to a tool that starts itself in
 * the background: without it, a newer CLI could neither use NOR stop the
 * older daemon already holding the port, which is a trap of our own making.
 * It is enough to justify asking that daemon to shut down; it is not enough
 * to justify sending it a prompt.
 */
export function identify(payload) {
  if (!payload) return 'absent'
  if (payload.service === SERVICE_ID) {
    return payload.protocol === PROTOCOL_VERSION ? 'ours' : 'version-mismatch'
  }
  if (payload.status === 'ok' && Array.isArray(payload.providers) && payload.sessions) return 'legacy'
  return 'foreign'
}

export const isUibridge = (kind) => kind === 'ours' || kind === 'version-mismatch' || kind === 'legacy'
