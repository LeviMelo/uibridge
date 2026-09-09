import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { manageWindows, positionWindow } from '../src/core/window.mjs'

function fixture(bounds = { left: 100, top: 100, windowState: 'normal' }) {
  const calls = []
  const page = { isClosed: () => false }
  const ctx = new EventEmitter()
  ctx.pages = () => [page]
  ctx.newCDPSession = async () => ({
    send: async (method, params) => {
      calls.push({ method, params })
      return { windowId: 7, bounds }
    },
    detach: async () => calls.push({ method: 'detach' }),
  })
  return { ctx, page, calls }
}

test('offscreen restores maximized windows before moving them', async () => {
  const { ctx, page, calls } = fixture({ windowState: 'maximized' })
  await positionWindow(ctx, page, 'offscreen')
  assert.deepEqual(calls.filter((c) => c.method === 'Browser.setWindowBounds').map((c) => c.params.bounds), [
    { windowState: 'normal' }, { left: -32000, top: -32000, width: 1500, height: 1000 },
  ])
  assert.equal(calls.at(-1).method, 'detach')
})

test('headed attach restores parked windows and preserves visible windows', async () => {
  const parked = fixture({ left: -21845, top: -21845, windowState: 'normal' })
  await positionWindow(parked.ctx, parked.page, false)
  assert.equal(parked.calls[1].params.bounds.left, 80)
  const visible = fixture()
  await positionWindow(visible.ctx, visible.page, false)
  assert.equal(visible.calls.some((c) => c.method === 'Browser.setWindowBounds'), false)
})

test('headless needs no window commands or page listeners', async () => {
  const { ctx, calls } = fixture()
  await manageWindows(ctx, true, {})
  assert.equal(ctx.listenerCount('page'), 0)
  assert.deepEqual(calls, [])
})

test('existing pages and new windows are positioned; failures are reported and detached', async () => {
  const { ctx, page, calls } = fixture()
  const warnings = []
  const prepare = await manageWindows(ctx, 'offscreen', { warn: (s) => warnings.push(s) })
  assert.equal(calls.filter((c) => c.method === 'Browser.setWindowBounds').length, 1)
  calls.length = 0
  ctx.emit('page', page)
  await prepare(page)
  assert.equal(calls.filter((c) => c.method === 'Browser.setWindowBounds').length, 1)
  let detached = false
  ctx.newCDPSession = async () => ({ send: async () => { throw new Error('unsupported') }, detach: async () => { detached = true } })
  await prepare(page)
  assert.equal(detached, true)
  assert.match(warnings[0], /unsupported/)
  ctx.emit('close')
  assert.equal(ctx.listenerCount('page'), 0)
})
