import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureDownload } from '../src/transports/download.mjs'
import { copyMarkdown, downloadGeneratedFiles } from '../src/transports/dom.mjs'
import { auditProvenance } from '../src/core/ledger.mjs'
import { connectBrowser } from '../src/core/chrome.mjs'

test('browser attachment retries a transient failure with a finite timeout', async () => {
  let attempts = 0
  const browser = {}
  assert.equal(await connectBrowser(9333, { connect: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:9333')
    assert.equal(options.timeout, 8000)
    if (++attempts === 1) throw new Error('temporary connection failure')
    return browser
  } }), browser)
  assert.equal(attempts, 2)
})

test('persistent attachment failure is typed and explicitly precedes submission', async () => {
  let attempts = 0
  await assert.rejects(connectBrowser(9333, { connect: async () => {
    attempts++
    throw new Error('Timeout exceeded.\nUnnecessary protocol details')
  } }), error => {
    assert.equal(error.code, 'browser_unavailable')
    assert.equal(error.status, 503)
    assert.equal(error.detail.submission_started, false)
    assert.equal(error.detail.stage, 'browser_attach')
    assert.equal(error.detail.cause, 'Timeout exceeded.')
    assert.equal(error.retryable, false) // same durable key replays the failure
    return true
  })
  assert.equal(attempts, 2)
})

test('download capture saves owned artifact bytes and ignores foreign-frame events', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'uibridge-download-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const browser = new EventEmitter()
  let incoming
  browser.send = async (method, args) => { if (method === 'Browser.setDownloadBehavior') incoming = args.downloadPath }
  browser.detach = async () => {}
  const target = { send: async () => ({ frameTree: { frame: { id: 'ours' } }, targetInfo: { targetId: 'ours' } }), detach: async () => {} }
  const page = { context: () => ({ browser: () => ({ newBrowserCDPSession: async () => browser }), newCDPSession: async () => target }) }
  const file = await captureDownload(page, async () => {
    browser.emit('Browser.downloadWillBegin', { frameId: 'foreign', guid: 'wrong', suggestedFilename: 'foreign.csv' })
    browser.emit('Target.targetCreated', { targetInfo: { targetId: 'owned-popup', openerId: 'ours' } })
    writeFileSync(join(incoming, 'owned-guid'), 'id,n\nA,42\n')
    browser.emit('Browser.downloadWillBegin', { frameId: 'owned-popup', guid: 'owned-guid', suggestedFilename: '../trial.csv' })
    browser.emit('Browser.downloadProgress', { guid: 'owned-guid', state: 'completed' })
  }, { dir })
  assert.equal(file.name, 'trial.csv')
  assert.equal(readFileSync(file.path, 'utf8'), 'id,n\nA,42\n')
  assert.equal(existsSync(join(incoming, 'owned-guid')), false)
  assert.equal(browser.listenerCount('Browser.downloadProgress'), 0)
})

test('historical generated files are never searched during response-scoped retrieval', async () => {
  let pageQueries = 0
  const page = { locator() { pageQueries++; throw new Error('must not search historical page') } }
  const scope = { locator: () => ({ count: async () => 0 }) }
  assert.deepEqual(await downloadGeneratedFiles(page, { chip: 'generated-file', download: '.download', toolMarker: '.tool' }, { scope }), [])
  assert.equal(pageQueries, 0)
})

test('serialized canonical copies refresh permission and focus for every continuation', async () => {
  let buffer = 'stale', focus = 0, grants = 0
  const answers = ['第一条回答', 'Second answer about αβ', 'Third answer, original markdown.']
  const results = await Promise.all(answers.map((answer) => {
    const cdp = { send: async (_m, { enabled }) => { focus += enabled ? 1 : -1; assert.ok(focus <= 1) }, detach: async () => {} }
    const page = {
      context: () => ({ newCDPSession: async () => cdp, grantPermissions: async () => { grants++ } }),
      url: () => 'https://example.com/thread', bringToFront: async () => {},
      evaluate: async (fn) => {
        if (String(fn).includes('writeText')) { buffer = ''; return true }
        return buffer
      },
      locator: () => ({ last: () => ({ click: async () => { buffer = answer } }) }),
    }
    return copyMarkdown(page, { copyButton: '.copy' }, { expectLen: answer.length, rendered: answer })
  }))
  assert.deepEqual(results, answers)
  assert.equal(grants, 3); assert.equal(focus, 0)
})

test('hidden code in canonical markdown does not invalidate its visible short answer', async () => {
  const answer = '```python\nprint(42)\n```\nThe value of n for row A is 42.'
  let buffer = ''
  const page = {
    context: () => ({ newCDPSession: async () => ({ send: async () => {}, detach: async () => {} }), grantPermissions: async () => {} }),
    url: () => 'https://example.com', bringToFront: async () => {},
    evaluate: async (fn) => { if (String(fn).includes('writeText')) { buffer = ''; return true } return buffer },
    locator: () => ({ last: () => ({ click: async () => { buffer = answer } }) }),
  }
  assert.equal(await copyMarkdown(page, { copyButton: '.copy' }, { expectLen: 28, rendered: 'The value of n for row A is 42.' }), answer)
})

test('clipboard outage yields explicit diagnostics and releases focus', async () => {
  let disabled = false
  const diagnostics = {}
  const page = {
    context: () => ({ newCDPSession: async () => ({ send: async (_m, { enabled }) => { if (!enabled) disabled = true }, detach: async () => {} }), grantPermissions: async () => {} }),
    url: () => 'https://example.com', bringToFront: async () => {},
    evaluate: async () => { throw new Error('document not focused') },
  }
  assert.equal(await copyMarkdown(page, { copyButton: '.copy' }, { diagnostics }), null)
  assert.equal(diagnostics.phase, 'clear'); assert.equal(diagnostics.reason, 'Error'); assert.equal(disabled, true)
})

test('audit records retain both on/off verification while dropping unrelated data', () => {
  for (const on of [true, false]) {
    const output = auditProvenance({ model: { requested: 'gemini-pro', applied: 'Pro', verified: true, cookie: 'secret' },
      modes: { thinking: { requested: on, applied: on, verified: true, token: 'secret' } }, final_state: 'Pro', token: 'secret' })
    assert.equal(output.modes.thinking.applied, on)
    assert.equal(output.modes.thinking.verified, true)
    assert.equal(output.final_state, 'Pro')
    assert.ok(!JSON.stringify(output).includes('secret'))
  }
})
