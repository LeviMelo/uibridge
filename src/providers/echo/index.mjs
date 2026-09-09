// A DETERMINISTIC STAND-IN FOR A CHAT UI.
//
// WHY THIS EXISTS. Most of uibridge is not a chat UI: it is an
// OpenAI-compatible HTTP surface, a CLI, a durable request layer, a thread
// ledger, a pacer, an idempotency store and an error taxonomy. All of that is
// ours, and all of it can be wrong. Testing it by asking Gemini or ChatGPT a
// question measures THEIR model - slowly, non-deterministically, and out of
// the user's paid subscription - while telling us almost nothing about
// whether OUR envelope, exit codes and retry semantics are right.
//
// So this provider answers immediately, from a script, with no browser and no
// network. It exists to make the tool falsifiable:
//
//   - the exact prompt that went in comes back out (a bridge's first duty),
//   - every branch the real providers can reach (a provider error, a
//     truncated stream, a rate-limit notice, a missing model, a generated
//     file) can be REQUESTED instead of waited for,
//   - a test suite runs in seconds, offline, with the same result every time.
//
// It is not a mock in the usual sense: it implements the real Provider
// contract and is driven by the real Session, so a change that breaks the
// orchestrator breaks these tests too.
//
// IT IS NOT ADVERTISED. `calibrated: false` keeps it out of /v1/models and
// out of the CLI's provider list unless UIBRIDGE_TEST_PROVIDER is set, so it
// can never be reached by accident in ordinary use.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Provider, Capabilities } from '../contract.mjs'
import { BridgeError } from '../../core/errors.mjs'
import { sleep } from '../../core/async.mjs'
import selectors from './selectors.json' with { type: 'json' }

/** `@@key` or `@@key=value` directives, stripped from the text they control. */
export function parseDirectives(prompt) {
  const directives = {}
  const text = String(prompt ?? '').replace(/@@([a-z_]+)(?:=([^\s@]+))?/g, (_, key, value) => {
    directives[key] = value ?? true
    return ''
  })
  return { directives, text: text.replace(/[ \t]+\n/g, '\n').trim() }
}

/** The simulated server's conversations: id -> turns. See #history. */
const THREADS = new Map()

let counter = 0
const nextId = () => `echo${String(++counter).padStart(6, '0')}${Date.now().toString(36)}`

export default class EchoProvider extends Provider {
  static id = 'echo'
  static selectors = selectors
  static usesBrowser = false
  static defaults = {
    // Nothing is being protected from a burst, so no pacing: a suite that
    // waits 8s between cases is a suite nobody runs.
    minIntervalMs: 0,
    concurrency: 4,
    newChatPerRequest: true,
    strictModel: true,
  }

  // A REAL SITE KEEPS THE CONVERSATION, NOT THE TAB. Closing a ChatGPT tab
  // does not delete the thread; reopening its URL brings the history back.
  // The pool discards a tab whose turn threw, so when this store lived on the
  // page a simulated failure erased the conversation - and the NEXT turn then
  // paid the full history-baseline timeout finding nothing. That is not what
  // the code under test would face in production, so the stand-in would have
  // been lying. Threads live here, keyed by id, exactly as the server holds
  // them; the page holds only which thread it is looking at.
  //
  // It is MODULE-level, not instance-level, for the same reason: Session
  // builds a fresh provider object for an export, and a per-instance store
  // made that look like a different website - the export of a thread the very
  // same session had just created failed with thread_unavailable. One store
  // per process is what "the site" means here.
  #history(thread) {
    if (!thread) return []
    if (!THREADS.has(thread)) THREADS.set(thread, [])
    return THREADS.get(thread)
  }

  /** The "tab": which conversation this view is open on. */
  newPage() {
    let closed = false
    const provider = this
    return {
      thread: null,
      get turns() { return provider.#history(this.thread) },
      isClosed: () => closed,
      close: async () => { closed = true },
      on: () => {},
    }
  }

  capabilities() {
    return new Capabilities({
      models: selectors.models,
      modes: selectors.modes,
      attachments: true,
      generatedFiles: true,
      citations: true,
      transports: ['scripted'],
      threadExport: true,
    })
  }

  async prepareAuth() {}

  async sessionState() {
    // A test must be able to exercise the signed-out and challenge paths
    // without logging anything out for real.
    if (process.env.UIBRIDGE_ECHO_SESSION === 'out') return { state: 'out', evidence: { reason: 'requested by UIBRIDGE_ECHO_SESSION' } }
    if (process.env.UIBRIDGE_ECHO_SESSION === 'challenge') {
      return { state: 'challenge', evidence: { challengeText: 'a simulated verification challenge' } }
    }
    return { state: 'in', evidence: { cookie: 'present' } }
  }

  async isSignedIn(page) {
    return (await this.sessionState(page)).state === 'in'
  }

  async open() {}

  async newConversation(page) {
    page.thread = null
  }

  // A SITE CANNOT OPEN A CONVERSATION IT NEVER CREATED. Accepting any string
  // here let a request carrying a bogus thread_id come back 200 with a
  // brand-new thread - the caller believing it had continued a conversation
  // that does not exist. The real providers navigate to a thread URL and
  // fail; so does this.
  async resumeThread(page, threadId) {
    // A "ghost" thread is what Gemini actually does with an id it never
    // issued: the navigation succeeds, the URL keeps the id, and the
    // conversation is simply empty. The provider cannot tell that apart from
    // a real thread, so the refusal has to come from Session's history
    // check - which is the thing these ids exist to exercise.
    if (String(threadId).startsWith('ghost-')) {
      THREADS.set(threadId, [])
      page.thread = threadId
      return
    }
    if (!THREADS.has(threadId)) {
      throw new BridgeError(`echo: thread ${threadId} did not open`, { status: 503, code: 'thread_unavailable', retryable: true })
    }
    page.thread = threadId
  }

  async currentThread(page) {
    return page.thread
  }

  async threadIds(page) {
    return page.thread ? [page.thread] : []
  }

  async responseTexts(page) {
    return page.turns.map((t) => t.answer)
  }

  async lastResponseText(page) {
    return page.turns.at(-1)?.answer ?? null
  }

  async turnCount(page) {
    return page.turns.length
  }

  async dismissNotices(page) {
    return page.throttled ? [{ kind: 'rate_limit', name: 'rate limit', text: 'echo: simulated rate-limit notice' }] : []
  }

  async selectModel(_page, modelId) {
    const spec = selectors.models[modelId]
    if (!spec) return { requested: modelId, applied: null, verified: false, note: 'unknown model' }
    this.model = modelId
    if (spec.refuse) return { requested: modelId, applied: 'echo-other', verified: false, note: 'the picker ignored the click' }
    return { requested: modelId, applied: spec.label, verified: true, note: 'verified' }
  }

  async setMode(_page, mode, on) {
    if (!selectors.modes[mode]) return { mode, applied: null, verified: false, note: 'unknown mode' }
    this.modes = { ...this.modes, [mode]: on }
    return { mode, applied: on, verified: true, note: 'verified' }
  }

  async readState() {
    return `echo picker: ${this.model ?? 'default'}${this.modes?.thinking ? ' + thinking' : ''}`
  }

  async attach(page, files) {
    page.attached = files.map((f) => resolve(f))
  }

  async submit(page, prompt, ctx) {
    const { directives, text } = parseDirectives(prompt)
    ctx.echo = { directives, text }
    if (directives.throw) {
      throw new BridgeError(`echo: simulated ${directives.throw}`, {
        status: Number(directives.status ?? 502),
        code: String(directives.throw),
        retryable: directives.retryable === 'true',
      })
    }
    page.throttled = !!directives.throttled
    page.thread = page.thread ?? (directives.thread ? String(directives.thread) : nextId())
  }

  async awaitCompletion(_page, ctx) {
    const ms = Number(ctx.echo?.directives.sleep ?? 0)
    if (ms) await sleep(ms)
  }

  async extract(page, ctx) {
    const { directives, text } = ctx.echo
    const answer = this.#answer(directives, text)

    // Streaming: the API layer only sees progress through onProgress, so a
    // scripted provider must drive it the way a real transport does.
    if (ctx.onProgress) {
      const n = Math.max(1, Number(directives.chunks ?? 1))
      const size = Math.ceil(answer.length / n)
      // `@@throw_at=k` fails AFTER k chunks have already gone out. That is a
      // different code path from a request that fails before its first byte:
      // the HTTP status is already 200 and the headers are already sent, so
      // the only way left to tell the truth is an error frame inside the
      // stream. A caller that instead saw a clean end would read a truncated
      // answer as a complete one.
      const failAt = directives.throw_at === undefined ? null : Math.max(0, Number(directives.throw_at))
      for (let i = 0; i < n; i++) {
        if (failAt !== null && i === failAt) {
          throw new BridgeError(`echo: simulated ${directives.throw ?? 'ui_contract'} after ${i} chunks`,
            { status: Number(directives.status ?? 502), code: String(directives.throw ?? 'ui_contract'), retryable: directives.retryable === 'true' })
        }
        await ctx.onProgress(answer.slice(0, (i + 1) * size))
      }
    }

    const files = []
    if (directives.file) {
      const dir = this.settings.downloadDir
      mkdirSync(dir, { recursive: true })
      const name = String(directives.file)
      const path = resolve(dir, name)
      const body = `col_a,col_b\n1,2\n`
      writeFileSync(path, body)
      files.push({ name, path, bytes: Buffer.byteLength(body), mime: 'text/csv', source: 'scripted' })
    }

    page.turns.push({ prompt: text, answer })
    return {
      text: answer,
      markdown: true,
      extraction: 'scripted',
      tables: directives.table ? [{ header: ['a', 'b'], rows: [['1', '2']] }] : [],
      code_blocks: directives.code ? [{ language: 'python', code: 'print(1)' }] : [],
      files,
      sources: directives.sources ? [{ url: 'https://example.invalid/1', title: 'Example' }] : [],
      citations: [],
      browsed: !!directives.sources,
      searched: !!directives.sources,
      truncated: !!directives.truncated,
      provider_error: !!directives.error,
      provider_error_suspected: !!directives.suspect,
      provider_error_match: directives.error ? 'echo: simulated failure' : null,
      model_slug: this.model ? selectors.models[this.model]?.slug ?? null : null,
    }
  }

  /** The scripted answer. Echoing the prompt back is the default on purpose. */
  #answer(directives, text) {
    if (directives.error) return 'Sorry, something went wrong. Please try your request again.'
    if (directives.suspect) return 'I could not complete that.'
    if (directives.json) return JSON.stringify({ ok: true, echo: text })
    if (directives.table) return `| a | b |\n| --- | --- |\n| 1 | 2 |`
    if (directives.code) return '```python\nprint(1)\n```'
    if (directives.long) return 'x'.repeat(Number(directives.long))
    return text
  }

  async exportThread(page, threadId) {
    const messages = page.turns.flatMap((t, i) => [
      { id: `m${i}u`, role: 'user', text: t.prompt, attachments: [], file_controls: [] },
      { id: `m${i}a`, role: 'assistant', text: t.answer, attachments: [], file_controls: [] },
    ])
    return {
      provider: this.id,
      thread_id: threadId,
      messages,
      complete: true,
      evidence: {
        reached_top: true, reached_bottom: true,
        message_count: messages.length, ordered_count: messages.length,
        stable_ids: true, readings: 1, order_verified: true,
        branch_pager: false, branched_messages: 0, branches_walked: false,
        mounted_at_end: messages.length,
      },
    }
  }

  async downloadThreadFiles() {
    return { files: [] }
  }
}
