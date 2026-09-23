import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../src/session.mjs'
import { DomProvider } from '../src/providers/dom-provider.mjs'
import { reserveOutputFile } from '../src/core/output-file.mjs'
import { recordThreadEvent, readThreadEvents } from '../src/core/ledger.mjs'
import { providerSettings, loadConfig } from '../src/core/config.mjs'
import { providerClass } from '../src/providers/registry.mjs'
import { safeFileName } from '../src/transports/files-wire.mjs'

const log = { debug() {}, info() {}, warn() {}, child() { return this } }
class FakeProvider {
  constructor({ settings }) { this.settings = settings }
  get id() { return 'fake' }
  async prepareAuth() {}
  async sessionState() { return { state: 'in' } }
  async open() {}
  async newConversation(page) { page.thread = null }
  async currentThread(page) { return page.thread }
  async resumeThread(page, id) { page.thread = id }
  async dismissNotices() { return [] }
  async selectModel() { return this.settings.modelVerdict ?? { verified: true } }
  async readState() { return 'test' }
  async responseTexts() { return ['previous'] }
  async turnCount() { return 1 }
  async lastResponseText() { return 'previous' }
  async threadIds() { return [] }
  async attach(page, paths) {
    this.settings.observed.files = [...paths]
    this.settings.observed.fileText = readFileSync(paths.at(-1), 'utf8')
  }
  async submit(page, prompt) {
    const o = this.settings.observed
    if (this.settings.composeFailsOnce && !o.composeFailed) {
      o.composeFailed = true
      const e = new Error('The composer did not retain the complete prompt')
      e.code = 'compose_failed'
      throw e
    }
    o.prompt = prompt
    o.active++
    o.maxActive = Math.max(o.maxActive, o.active)
    page.thread ??= `fresh-${++o.turns}`
    await new Promise((r) => setTimeout(r, 5))
  }
  async awaitCompletion() {}
  async extract() {
    this.settings.observed.active--
    if (this.settings.failExtract) throw new Error('extraction failed')
    return { text: 'answer', files: [], sources: [], ...(this.settings.answerAs ?? {}) }
  }
}
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uibridge-session-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const observed = { active: 0, maxActive: 0, turns: 0 }
  const settings = { ledgerDir: dir, pollMs: 1, historyBaselineMs: 1000, newChatPerRequest: true, observed, ...overrides }
  const session = new Session({ provider: new FakeProvider({ settings }), settings, ctx: {}, log,
    pool: { withTab: (fn) => fn({ thread: null }), close: async () => {} } })
  return { session, observed, dir }
}

test('oversized inputs arrive byte-exact in an attachment and temporary files are removed', async (t) => {
  const { session, observed } = fixture(t, { maxComposerChars: 16 })
  const prompt = 'Unicode ciência αβ\n'.repeat(100)
  const r = await session.ask({ prompt })
  assert.equal(observed.fileText, prompt)
  assert.ok(observed.prompt.length < prompt.length)
  assert.equal(r.input.transport, 'attachment')
  assert.equal(r.input.characters, prompt.length)
  assert.equal(existsSync(observed.files[0]), false)
})

test('temporary inputs are removed after failed inference too', async (t) => {
  const { session, observed } = fixture(t, { maxComposerChars: 16, failExtract: true })
  await assert.rejects(session.ask({ prompt: 'Evidence '.repeat(100) }), /extraction failed/)
  assert.equal(existsSync(observed.files[0]), false)
})

test('simultaneous continuations of one native thread never overlap', async (t) => {
  const { session, observed } = fixture(t)
  await Promise.all(Array.from({ length: 4 }, () => session.ask({ prompt: 'continue', threadId: 'same' })))
  assert.equal(observed.maxActive, 1)
})

test('strict model mismatch fails before any prompt is submitted', async (t) => {
  const { session, observed } = fixture(t, { strictModel: true, modelVerdict: { verified: false, applied: 'other' } })
  await assert.rejects(session.ask({ prompt: 'test', model: 'wanted' }), { code: 'model_not_applied' })
  assert.equal(observed.prompt, undefined)
})

test('an effort the page never recorded is unverified, not a mismatch', async (t) => {
  // The effort is read from the page's OWN request body, which a busy browser
  // sometimes never gives us. Comparing that absence against "standard" threw
  // away 5 of 67 calls on 2026-09-20, each after 90-170 s, while the picker
  // had verified the model and the answer's slug matched.
  const { session } = fixture(t, {
    strictModel: true,
    modelVerdict: { verified: true, expected_slug: 'gpt-5-6-thinking', expected_effort: 'standard' },
    answerAs: { model_slug: 'gpt-5-6-thinking' },   // no sent_effort: not observed
  })
  const r = await session.ask({ prompt: 'test', model: 'chatgpt-5.6-medium' })
  assert.equal(r.provenance.model.verified, true)
  assert.equal(r.provenance.model.effort_verified, false, 'the ledger says it rests on the picker')
  assert.match(r.provenance.model.note, /did not record which effort/)
})

test('an effort the page did record and that differs is still refused', async (t) => {
  const { session } = fixture(t, {
    strictModel: true,
    modelVerdict: { verified: true, expected_slug: 'gpt-5-6-thinking', expected_effort: 'standard' },
    answerAs: { model_slug: 'gpt-5-6-thinking', sent_effort: 'extended' },
  })
  await assert.rejects(session.ask({ prompt: 'test', model: 'chatgpt-5.6-medium' }),
    { code: 'model_not_applied' })
})

test('an effort the page recorded and that agrees is fully verified', async (t) => {
  const { session } = fixture(t, {
    strictModel: true,
    modelVerdict: { verified: true, expected_slug: 'gpt-5-6-thinking', expected_effort: 'standard' },
    answerAs: { model_slug: 'gpt-5-6-thinking', sent_effort: 'standard' },
  })
  const r = await session.ask({ prompt: 'test', model: 'chatgpt-5.6-medium' })
  assert.equal(r.provenance.model.verified, true)
  assert.equal(r.provenance.model.effort_verified, undefined, 'nothing to flag')
  assert.match(r.provenance.model.note, /the server confirms/)
})

test('a wrong slug is refused whatever the effort says', async (t) => {
  const { session } = fixture(t, {
    strictModel: true,
    modelVerdict: { verified: true, expected_slug: 'gpt-5-6-thinking', expected_effort: 'standard' },
    answerAs: { model_slug: 'gpt-4o', sent_effort: 'standard' },
  })
  await assert.rejects(session.ask({ prompt: 'test', model: 'chatgpt-5.6-medium' }),
    { code: 'model_not_applied' })
})

test('text goes to the composer, and an attachment is what failure falls back to', async (t) => {
  // An attachment spends one of the account's per-window uploads whether it
  // holds a PDF or a pasted CSV. A caller measured 89% of its screening
  // batches and 97% of its text reads becoming attachments at the old
  // 32,000-character threshold, spending 65 uploads of an 80-upload window
  // on text the editor would have taken (PHAROS, 2026-09-20).
  const { session, observed } = fixture(t, { maxComposerChars: 400000 })
  const prompt = 'a line of evidence\n'.repeat(5000)      // ~95,000 characters
  const r = await session.ask({ prompt })
  assert.equal(r.input.transport, 'composer', 'the editor took it')
  assert.equal(observed.prompt, prompt, 'all of it, unaltered')
  assert.equal(observed.files, undefined, 'and nothing was uploaded')
})

test('a compose_failed retry goes as an attachment, not as the same attempt again', async (t) => {
  // Repeating the attempt that just failed to place the text is the one
  // retry that cannot help.
  const { session, observed } = fixture(t, { maxComposerChars: 400000, composeFailsOnce: true })
  const r = await session.ask({ prompt: 'Evidence '.repeat(4000) })
  assert.equal(r.input.transport, 'attachment')
  assert.equal(observed.fileText, 'Evidence '.repeat(4000), 'the whole request is in the file')
  assert.match(observed.prompt, /contains the complete request/)
})

test('a cancelled Session request cannot reach submission', async (t) => {
  const { session, observed } = fixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(session.ask({ prompt: 'must not send', signal: controller.signal }), { code: 'request_cancelled' })
  assert.equal(observed.prompt, undefined)
})

test('closing a Session interrupts pacing and prevents subsequent submission', async (t) => {
  const { session, observed } = fixture(t, { minIntervalMs: 60000 })
  await session.ask({ prompt: 'first' })
  const waiting = session.ask({ prompt: 'must not send' })
  const rejected = assert.rejects(waiting, { code: 'session_closed' })
  await session.close()
  await rejected
  assert.equal(observed.prompt, 'first')
  await assert.rejects(session.ask({ prompt: 'after close' }), { code: 'session_closed' })
})

test('thread identity comes from URL or wire, never unrelated sidebar history', async () => {
  class Provider extends DomProvider { static selectors = { thread: { urlPattern: '/c/([^/?#]+)' } } }
  const p = new Provider({ settings: { url: 'https://example.com/' } })
  p.threadIds = async () => ['unrelated-history']
  assert.equal(await p.currentThread({ url: () => 'https://example.com/' }), null)
  assert.equal(await p.currentThread({ url: () => 'https://example.com/c/right' }), 'right')
  assert.equal(await p.currentThread({ url: () => 'https://example.com/' }, { wireResult: { decoded: { conversationId: 'wire-id' } } }), 'wire-id')
})

test('generated file reservations preserve earlier results across separate requests', (t) => {
  const { dir } = fixture(t)
  const first = reserveOutputFile(dir, 'result.txt')
  writeFileSync(first, 'earlier')
  const second = reserveOutputFile(dir, 'result.txt')
  writeFileSync(second, 'later')
  assert.notEqual(first, second)
  assert.equal(readFileSync(first, 'utf8'), 'earlier')
  assert.equal(readFileSync(second, 'utf8'), 'later')
})

test('a fallback generated filename is sanitized too', () => {
  assert.equal(safeFileName('', '../../.profiles/gemini/Cookies'), 'Cookies')
  assert.equal(safeFileName('', '..'), 'download.bin')
})

test('audit ledger stores file identities without inlined generated content', async (t) => {
  const { dir } = fixture(t)
  const path = join(dir, 'answer.txt')
  writeFileSync(path, 'private answer payload')
  await recordThreadEvent(dir, { provider: 'fake', thread_id: 't', inputs: [], outputs: [{ name: 'answer.txt', path, text: 'private answer payload' }] })
  const events = readThreadEvents(dir, 'fake', 't').events
  assert.equal(events[0].outputs[0].text, undefined)
  assert.match(events[0].outputs[0].sha256, /^[a-f0-9]{64}$/)
})

test('explicit headed/headless overrides beat provider defaults', () => {
  const cfg = loadConfig()
  assert.equal(providerSettings({ ...cfg, windowModeOverride: false }, 'chatgpt', { headless: 'offscreen' }).headless, false)
  assert.equal(providerSettings({ ...cfg, windowModeOverride: true }, 'chatgpt', { headless: 'offscreen' }).headless, true)
})

test('the distributed example configuration is valid JSON and loads', () => {
  const cfg = loadConfig('config.example.json')
  assert.equal(cfg.provider.strictModel, true)
  assert.equal(cfg.provider.maxComposerChars, 190000)
})

test('the observed Gemini non-answer is recognised without guessing new wording', () => {
  assert.match("I'm having a hard time fulfilling your request. Can I help you with something else instead?",
    new RegExp(providerClass('gemini').selectors.errorText, 'i'))
})
