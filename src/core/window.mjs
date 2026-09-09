// Window placement applies to the dedicated browser context only.
// Launch flags do not affect a Chrome instance we reattach to.
export async function positionWindow(ctx, page, mode) {
  if (mode === true || page.isClosed()) return
  const cdp = await ctx.newCDPSession(page)
  try {
    const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget')
    const offscreen = mode === 'offscreen'
    // Leave ordinary visible windows where the user put them. A headed
    // attach only restores windows parked by our offscreen mode.
    // Windows/DPI scaling can clamp -32000 to about -21845. Recognise the
    // parked region, not only the originally requested coordinates.
    if (!offscreen && !(bounds.left <= -10000 || bounds.top <= -10000)) return
    if (bounds.windowState !== 'normal') {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    }
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: offscreen ? -32000 : 80, top: offscreen ? -32000 : 80, width: 1500, height: 1000 },
    })
  } finally {
    await cdp.detach().catch(() => {})
  }
}

export async function manageWindows(ctx, mode, log) {
  const pending = new WeakMap()
  const preparePage = (page) => {
    if (!pending.has(page)) {
      const work = positionWindow(ctx, page, mode).catch((err) => {
        if (!page.isClosed()) log.warn(`Could not position browser window: ${err.message}`)
      }).finally(() => pending.delete(page))
      pending.set(page, work)
    }
    return pending.get(page)
  }
  if (mode !== true) {
    ctx.on('page', preparePage)
    ctx.once('close', () => ctx.off('page', preparePage))
    await Promise.all(ctx.pages().map(preparePage))
  }
  return preparePage
}

/**
 * Briefly put a parked window back on the desktop, then restore it.
 *
 * WHY THIS IS EVER NEEDED. A Chrome launched with its window parked at
 * -32000 sometimes never composites a frame, and an app that mounts its
 * editor from a frame callback then never mounts at all: MEASURED on
 * ChatGPT 2026-09-09, the page stayed on its no-JS fallback textarea
 * indefinitely, with the send button permanently disabled. It is a race, not
 * a rule - the same launch succeeds often enough that it read as random
 * flakiness for a whole test run.
 *
 * So this is a last-resort recovery, not part of the normal path: the window
 * comes back only when the app has demonstrably failed to start, and goes
 * straight back where it was.
 */
export async function nudgeOnScreen(page, fn) {
  const cdp = await page.context().newCDPSession(page)
  let restore = null
  try {
    const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget')
    restore = { windowId, bounds }
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 80, width: 1500, height: 1000 } })
    return await fn()
  } finally {
    if (restore) {
      await cdp.send('Browser.setWindowBounds', { windowId: restore.windowId, bounds: restore.bounds }).catch(() => {})
    }
    await cdp.detach().catch(() => {})
  }
}
