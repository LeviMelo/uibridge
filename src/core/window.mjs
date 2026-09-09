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
