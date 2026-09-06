// Tab pool.
//
// One browser tab can serve one request at a time, so concurrency means
// several tabs. The pool exists because the alternative - serialising every
// request behind one tab - wasted most of the benefit of using a fast model:
// six independent prompts took six times as long for no reason.
//
// It is deliberately small and dumb: acquire, release, cap. No pre-warming,
// no idle reaping, no health checks. Tabs are cheap and the failure mode of
// clever pooling (handing out a broken tab) is worse than opening a new one.

import { logger } from './log.mjs'

export class TabPool {
  #ctx
  #max
  #idle = []
  #busy = new Set()
  #waiters = []
  #log

  constructor(ctx, { max = 2, name = 'pool' } = {}) {
    this.#ctx = ctx
    this.#max = Math.max(1, max)
    this.#log = logger(name)
  }

  get stats() {
    return { tabs: this.#idle.length + this.#busy.size, busy: this.#busy.size, waiting: this.#waiters.length }
  }

  async acquire() {
    const page = this.#idle.pop() ?? (this.#total < this.#max ? await this.#open() : await this.#queue())
    this.#busy.add(page)
    return page
  }

  release(page) {
    this.#busy.delete(page)
    if (page.isClosed()) return this.#pump()
    const next = this.#waiters.shift()
    if (next) return next(page)
    this.#idle.push(page)
  }

  /** Borrow a tab for the duration of `fn`, returning it even on throw. */
  async withTab(fn) {
    const page = await this.acquire()
    try {
      return await fn(page)
    } finally {
      this.release(page)
    }
  }

  async close() {
    for (const p of [...this.#idle, ...this.#busy]) await p.close().catch(() => {})
    this.#idle = []
    this.#busy.clear()
    for (const w of this.#waiters.splice(0)) w(null)
  }

  get #total() {
    return this.#idle.length + this.#busy.size
  }

  async #open() {
    const page = await this.#ctx.newPage()
    this.#log.debug(`opened tab (${this.#total + 1}/${this.#max})`)
    return page
  }

  #queue() {
    return new Promise((res) => this.#waiters.push(res))
  }

  /** A closed tab freed capacity: let a waiter open a fresh one. */
  async #pump() {
    if (!this.#waiters.length || this.#total >= this.#max) return
    const next = this.#waiters.shift()
    next(await this.#open())
  }
}
