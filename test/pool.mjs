import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TabPool } from '../src/core/pool.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))
function page() {
  let closed = false
  return { isClosed: () => closed, close: async () => { closed = true } }
}

test('concurrent acquisitions reserve capacity and hand off exclusively', async () => {
  let opened = 0
  const pool = new TabPool({ newPage: async () => { opened++; await tick(); return page() } }, { max: 2 })
  const requests = Array.from({ length: 12 }, () => pool.withTab(async () => {
    assert.ok(pool.stats.busy <= 2)
    await tick()
  }))
  await Promise.all(requests)
  assert.equal(opened, 2)
  assert.deepEqual(pool.stats, { tabs: 2, busy: 0, waiting: 0 })
  await pool.close()
})

test('failed tab creation rejects its caller and frees capacity for a waiter', async () => {
  let attempts = 0
  const pool = new TabPool({ newPage: async () => {
    if (++attempts === 1) throw new Error('creation failed')
    return page()
  } }, { max: 1 })
  const failed = assert.rejects(pool.acquire(), /creation failed/)
  const next = pool.acquire()
  await failed
  assert.ok(await next)
  await pool.close()
})

test('shutdown rejects queued and future acquisitions and closes in-flight tabs', async () => {
  let finish
  const p = page()
  const pool = new TabPool({ newPage: () => new Promise((resolve) => { finish = resolve }) }, { max: 1 })
  const opening = assert.rejects(pool.acquire(), { code: 'pool_closed' })
  const queued = assert.rejects(pool.acquire(), { code: 'pool_closed' })
  await tick()
  const closing = pool.close()
  assert.equal(pool.close(), closing)
  finish(p)
  await Promise.all([opening, queued, closing])
  assert.equal(p.isClosed(), true)
  await assert.rejects(pool.acquire(), { code: 'pool_closed' })
  assert.deepEqual(pool.stats, { tabs: 0, busy: 0, waiting: 0 })
})

test('discard replaces failed tabs; duplicate release cannot duplicate ownership', async () => {
  const pool = new TabPool({ newPage: async () => page() }, { max: 1 })
  const first = await pool.acquire()
  const next = pool.acquire()
  pool.release(first, { discard: true })
  const second = await next
  assert.notEqual(second, first)
  assert.equal(first.isClosed(), true)
  pool.release(second)
  pool.release(second)
  assert.equal(pool.stats.tabs, 1)
  await second.close()
  const third = await pool.acquire()
  assert.notEqual(third, second)
  await pool.close()
  pool.release(third)
  assert.equal(pool.stats.tabs, 0)
})

test('invalid concurrency cannot create a permanently stalled pool', () => {
  for (const max of [0, -1, NaN, Infinity, 1.5, '2']) {
    assert.throws(() => new TabPool({}, { max }), RangeError)
  }
})
