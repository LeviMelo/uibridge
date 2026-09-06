// A pool of browser tabs for one service.
//
// Each tab is an independent conversation. N tabs => N concurrent requests
// against the same signed-in profile, which is exactly what you would get
// by opening N windows and typing in all of them.
//
// Tabs are created lazily: a run that only ever needs two never opens six.

export class TabPool {
  /**
   * @param {import('playwright').BrowserContext} ctx
   * @param {string} url      landing page for a fresh conversation
   * @param {number} size     max concurrent tabs
   */
  constructor(ctx, url, size) {
    this.ctx = ctx
    this.url = url
    this.size = Math.max(1, size | 0)
    this.idle = []       // available pages
    this.created = 0
    this.waiters = []    // resolvers queued for a free tab
  }

  get busy() {
    return this.created - this.idle.length
  }

  async acquire() {
    const free = this.idle.pop()
    if (free && !free.isClosed()) return free

    if (this.created < this.size) {
      this.created++
      try {
        const page = await this.ctx.newPage()
        await page.goto(this.url, { waitUntil: 'domcontentloaded' })
        return page
      } catch (err) {
        this.created--
        throw err
      }
    }

    // All tabs busy - wait for one to come back.
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  release(page) {
    if (!page || page.isClosed()) {
      this.created = Math.max(0, this.created - 1)
      // A waiter can now claim the freed slot by creating a fresh tab.
      const w = this.waiters.shift()
      if (w) this.acquire().then(w)
      return
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter(page)
    else this.idle.push(page)
  }

  /** Run fn with a tab, always returning it to the pool. */
  async withTab(fn) {
    const page = await this.acquire()
    try {
      return await fn(page)
    } finally {
      this.release(page)
    }
  }

  async close() {
    for (const p of this.idle) await p.close().catch(() => {})
    this.idle = []
    this.created = 0
  }
}
