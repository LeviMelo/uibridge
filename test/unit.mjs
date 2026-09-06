// Unit tests: the pure layer, no browser, no network. Runs in milliseconds.
//
//   node --test test/
//
// These cover the parts that used to be untestable because they were welded
// into the driver. Every case below is a bug that actually happened or a
// contract worth pinning: markdown that must survive extraction, the
// clipboard lock that stops concurrent tabs reading each other's answer, and
// the message flattening these UIs force on us.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTables, parseCodeBlocks, extractJSON, parseMath } from '../src/core/markdown.mjs'
import { Mutex, retry, waitFor, waitStable } from '../src/core/async.mjs'
import { flattenMessages, readAttachments, readModes } from '../src/api/openai.mjs'
import { resolveModel, modelCatalogue, providerIds, providerClass } from '../src/providers/registry.mjs'
import { RequestError, SignedOutError, ContractError } from '../src/core/errors.mjs'
import { decideSession, signedOutMessage } from '../src/core/auth.mjs'
import { decodeDeltaStream, stripMarkers, parseSSE } from '../src/transports/sse-openai.mjs'
import { WireTap } from '../src/transports/wire.mjs'
import { Pacer } from '../src/core/async.mjs'
import { captureDownload, parseSchemeLinks, filenameFromDisposition, safeFileName } from '../src/transports/files-wire.mjs'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NL = String.fromCharCode(10)
const lines = (...l) => l.join(NL)

test('parseTables: header and rows', () => {
  const [t] = parseTables(
    lines('| PMID | drug | n |', '| --- | --- | --- |', '| 123 | Propofol | 85 |', '| 456 | Ketamine | 92 |')
  )
  assert.deepEqual(t.header, ['PMID', 'drug', 'n'])
  assert.equal(t.rows.length, 2)
  assert.deepEqual(t.rows[0], { PMID: '123', drug: 'Propofol', n: '85' })
})

test('parseTables: prose containing a pipe is not a table', () => {
  // The delimiter row is what makes a table a table. Without this rule,
  // ordinary text with a pipe produced phantom single-column tables.
  assert.deepEqual(parseTables(lines('effect | risk was unclear', 'no delimiter row here')), [])
})

test('parseTables: two tables in one answer', () => {
  const md = lines(
    '| a |', '| --- |', '| 1 |', '', 'text between', '', '| b | c |', '| --- | --- |', '| 2 | 3 |'
  )
  const ts = parseTables(md)
  assert.equal(ts.length, 2)
  assert.deepEqual(ts[1].header, ['b', 'c'])
})

test('parseCodeBlocks: language and body', () => {
  const [c] = parseCodeBlocks(lines('```python', 'x = 1', 'y = 2', '```'))
  assert.equal(c.lang, 'python')
  assert.equal(c.code, lines('x = 1', 'y = 2', ''))
})

test('parseCodeBlocks: unlabelled fence', () => {
  const [c] = parseCodeBlocks(lines('```', 'plain', '```'))
  assert.equal(c.lang, null)
})

test('parseMath: keeps LaTeX source', () => {
  // This is the point of copy-based extraction: rendered KaTeX keeps no
  // source at all, so scraped maths cannot be recovered.
  const m = parseMath('The estimator is $\\hat{\\tau}^2 = \\frac{Q-(k-1)}{C}$ overall.')
  assert.equal(m.length, 1)
  assert.match(m[0].tex, /\\frac/)
})

test('extractJSON: from a fenced block', () => {
  assert.deepEqual(extractJSON(lines('Sure:', '```json', '{"a": 1}', '```')), { a: 1 })
})

test('extractJSON: from prose with a preamble', () => {
  assert.deepEqual(extractJSON('Here you go: {"pmid": "123", "n": 85} - let me know'), {
    pmid: '123',
    n: 85,
  })
})

test('extractJSON: returns null rather than guessing', () => {
  assert.equal(extractJSON('no json here at all'), null)
  assert.equal(extractJSON('{ broken: '), null)
})

test('Mutex: serialises overlapping work', async () => {
  // The clipboard is one buffer for the whole machine: without this, two tabs
  // copying at once read each other's answer.
  const m = new Mutex()
  const order = []
  await Promise.all([
    m.run(async () => {
      order.push('a-start')
      await new Promise((r) => setTimeout(r, 30))
      order.push('a-end')
    }),
    m.run(async () => {
      order.push('b-start')
      order.push('b-end')
    }),
  ])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('Mutex: one failure does not poison the queue', async () => {
  const m = new Mutex()
  await assert.rejects(m.run(async () => { throw new Error('boom') }))
  assert.equal(await m.run(async () => 'ok'), 'ok')
})

test('waitFor: a throwing probe means "not yet", not failure', async () => {
  // DOM reads race with re-renders constantly; one detached-node error must
  // not abort a request.
  let n = 0
  const v = await waitFor(
    async () => {
      if (++n < 3) throw new Error('detached')
      return 'ready'
    },
    { timeout: 2000, poll: 5, what: 'test' }
  )
  assert.equal(v, 'ready')
})

test('waitFor: times out with a named cause', async () => {
  await assert.rejects(
    () => waitFor(async () => null, { timeout: 60, poll: 10, what: 'the thing' }),
    /the thing/
  )
})

test('waitStable: requires consecutive identical reads', async () => {
  const seq = ['a', 'ab', 'abc', 'abc', 'abc', 'abc']
  let i = 0
  const v = await waitStable(async () => seq[Math.min(i++, seq.length - 1)], {
    checks: 3,
    timeout: 2000,
    poll: 5,
  })
  assert.equal(v, 'abc')
})

test('waitStable: rejects a placeholder even when stable', async () => {
  // "Searching the internet" is stable for seconds before the real answer -
  // accepting it returned the placeholder as the model's reply.
  await assert.rejects(
    () =>
      waitStable(async () => 'Searching the internet', {
        checks: 2,
        timeout: 120,
        poll: 10,
        accept: (t) => !/Searching/i.test(t),
      }),
    /settle|finish/i
  )
})

test('waitStable: a long answer that merely mentions a placeholder word is accepted', async () => {
  // With extended thinking on, the response block carries its own "Show
  // thinking" control, so a substring match on placeholder words rejected a
  // finished answer forever and the request sat until its 600s timeout.
  // Only SHORT text can be a placeholder.
  const answer = 'Show thinking. ' + 'The pooled estimate favours the intervention. '.repeat(6)
  const short = (t) => t.trim().length <= 64 && /thinking|searching/i.test(t)
  const v = await waitStable(async () => answer, {
    checks: 2,
    timeout: 2000,
    poll: 5,
    accept: (t) => !!t && !short(t),
  })
  assert.equal(v, answer)
})

test('retry: retries only what a second attempt can fix', async () => {
  // The policy matters as much as the mechanism. A turn that never left the
  // composer is worth one more go; a timeout is not - the model was working,
  // and repeating a ten-minute wait costs more than it recovers. A
  // "something went wrong" reply is not in the set either: it is a message
  // the UI produced, so it is delivered and flagged, never retried behind
  // the caller's back.
  const RETRYABLE = new Set(['compose_failed', 'submit_failed'])
  const isRetryable = (e) => RETRYABLE.has(e.code)

  let calls = 0
  const recovered = await retry(
    async () => {
      calls++
      if (calls === 1) throw Object.assign(new Error('never typed'), { code: 'compose_failed' })
      return 'second attempt'
    },
    { attempts: 2, isRetryable }
  )
  assert.equal(recovered, 'second attempt')
  assert.equal(calls, 2)

  let timeouts = 0
  await assert.rejects(() =>
    retry(
      async () => {
        timeouts++
        throw Object.assign(new Error('too slow'), { code: 'timeout' })
      },
      { attempts: 2, isRetryable }
    )
  )
  assert.equal(timeouts, 1, 'a timeout must not be retried')
})

test('flattenMessages: labels non-user roles instead of dropping them', () => {
  const out = flattenMessages([
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Define I-squared.' },
  ])
  assert.match(out, /\[system\]/)
  assert.match(out, /Define I-squared/)
})

test('flattenMessages: array content parts', () => {
  const out = flattenMessages([
    { role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] },
  ])
  assert.match(out, /part one/)
  assert.match(out, /part two/)
})

test('flattenMessages: rejects empty input', () => {
  assert.throws(() => flattenMessages([]), RequestError)
  assert.throws(() => flattenMessages([{ role: 'user', content: '  ' }]), RequestError)
})

test('readAttachments / readModes validate shape', () => {
  assert.deepEqual(readAttachments({ attachments: ['a.csv'] }), ['a.csv'])
  assert.deepEqual(readAttachments({}), [])
  assert.throws(() => readAttachments({ attachments: 'a.csv' }), RequestError)
  assert.throws(() => readAttachments({ attachments: [1] }), RequestError)
  assert.deepEqual(readModes({ modes: { thinking: 1 } }), { thinking: true })
  assert.throws(() => readModes({ modes: [] }), RequestError)
})

test('registry: only calibrated providers are advertised', () => {
  // /v1/models is a promise that an id works. A provider still on
  // placeholder selectors must not appear: a caller would pick it, get a
  // 501, and conclude the bridge is broken rather than unfinished.
  const ids = modelCatalogue().map((m) => m.id)
  for (const p of providerIds) {
    const calibrated = providerClass(p).selectors?.calibrated !== false
    assert.equal(ids.includes(p), calibrated, `${p} listed but calibrated=${calibrated}`)
  }
  assert.ok(ids.includes('gemini-flash'))
})

test('resolveModel: known id maps to its provider', () => {
  assert.deepEqual(resolveModel('gemini-flash', 'gemini'), {
    provider: 'gemini',
    model: 'gemini-flash',
    matched: true,
  })
})

test('resolveModel: unknown id falls back instead of failing', () => {
  // OpenAI-shaped clients send "gpt-4" whether or not we have it; refusing
  // is unhelpful, but the caller must be able to see it was not matched.
  const r = resolveModel('gpt-4-turbo', 'gemini')
  assert.equal(r.matched, false)
  assert.equal(r.provider, 'gemini')
})

test('errors carry actionable status codes', () => {
  assert.equal(new SignedOutError('gemini').status, 401)
  assert.equal(new RequestError('bad').status, 400)
  assert.equal(new ContractError('gemini', 'sendButton', 'button.x').status, 502)
  assert.match(new SignedOutError('gemini').message, /uibridge login gemini/)
  // A UI-drift error must name the key AND the selector, so the fix is
  // obvious rather than a hunt.
  const c = new ContractError('gemini', 'sendButton', 'button.send')
  assert.match(c.message, /sendButton/)
  assert.match(c.message, /button\.send/)
})

// --- session detection -----------------------------------------------------
// These pin the failure that motivated the whole module: chatgpt.com answers
// while SIGNED OUT, from a different app and a weaker model, so a wrong
// verdict here does not throw - it quietly poisons a batch.

test('session: the session endpoint of the app is authoritative', () => {
  const v = decideSession({ account: 'someone@example.com', accountField: 'user.email', endpoint: { url: '/api/auth/session', status: 200 } })
  assert.equal(v.state, 'in')
  assert.match(v.authority, /session endpoint/)
})

test('session: a session cookie proves a session', () => {
  const v = decideSession({ authCookies: ['__Secure-next-auth.session-token'], cookies: [] })
  assert.equal(v.state, 'in')
})

test('session: the anonymous bundle is proof of NO session', () => {
  // Measured on chatgpt.com: the signed-out visitor is served a completely
  // different application from /unauth-mweb/. That is a fact about the
  // server's response, not about page wording.
  const v = decideSession({ anonAsset: '/unauth-mweb/assets/client-DLhqMDEN.js', authCookies: [] })
  assert.equal(v.state, 'anonymous')
  assert.match(v.because[0], /ANONYMOUS bundle/)
})

test('session: the anonymous bundle outranks a weak account marker', () => {
  // A loose accountMarker selector matching something on the logged-out page
  // must not be able to claim a session.
  const v = decideSession({ anonAsset: '/unauth-mweb/x.js', accountMarker: 3, authCookies: [] })
  assert.equal(v.state, 'anonymous')
})

test('session: nothing conclusive is UNKNOWN, never signed in', () => {
  // The bug this replaces: `if (!signedOutMarker) return true`. An unknown
  // page, a slow page, or a page in an unexpected language all read as
  // "signed in", and every request then ran against no account.
  const v = decideSession({ authCookies: [], cookies: [], endpoint: null, accountMarker: 0 })
  assert.equal(v.state, 'unknown')
  assert.notEqual(v.state, 'in')
})

test('session: an endpoint error is not a negative', () => {
  // A network failure says nothing either way; only an endpoint that ANSWERED
  // without an account is real evidence of anonymity.
  const v = decideSession({ endpoint: { url: '/api/auth/session', error: 'Failed to fetch' }, authCookies: [], accountMarker: 0 })
  assert.equal(v.state, 'unknown')
})

test('session: a challenge outranks everything', () => {
  const v = decideSession({ challengeText: 'unusual traffic', account: 'a@b.c', authCookies: ['x'] })
  assert.equal(v.state, 'challenge')
})

test('session: the message names the evidence AND the command', () => {
  const msg = signedOutMessage('chatgpt', decideSession({ anonAsset: '/unauth-mweb/x.js', authCookies: [] }))
  assert.match(msg, /login chatgpt/)
  assert.match(msg, /ANONYMOUS bundle/)
  // The password promise is not decoration: it is the thing a user is right
  // to worry about when a tool tells them to log in.
  assert.match(msg, /never sees or types your password/)
  // And it must say WHY refusing beats proceeding.
  assert.match(msg, /weaker model/)
})

// --- the ChatGPT wire format -----------------------------------------------
// Shapes taken from a real recorded exchange (testdata/recon), rebuilt here
// without the JWT and the account's custom instructions that the live stream
// also carries.

const LF = String.fromCharCode(10)
const PUA200 = String.fromCharCode(0xe200)
const PUA201 = String.fromCharCode(0xe201)
const PUA202 = String.fromCharCode(0xe202)
const sse = (frames) =>
  frames.map((f) => (f.event ? `event: ${f.event}${LF}` : '') + `data: ${f.data}${LF}${LF}`).join('')

const msg = (role, content_type, parts, extra = {}) =>
  JSON.stringify({ message: { id: `m-${role}-${parts[0]?.slice(0, 4) ?? 0}`, author: { role }, content: { content_type, parts }, metadata: extra } })

test('wire: a delta with no o/p inherits both from the one before', () => {
  // The entire compression scheme. Treating each frame as self-describing
  // recovered 29 characters of a real 2KB answer and looked like it worked.
  const raw = sse([
    { event: 'delta_encoding', data: JSON.stringify('v1') },
    { event: 'delta', data: JSON.stringify({ p: '', o: 'add', c: 0, v: JSON.parse(msg('user', 'text', ['hi'])) }) },
    { event: 'delta', data: JSON.stringify({ c: 1, v: JSON.parse(msg('assistant', 'text', [''], { model_slug: 'gpt-5-6-thinking' })) }) },
    { event: 'delta', data: JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: '| PMID |' }) },
    { event: 'delta', data: JSON.stringify({ v: ' Drug |' }) },
    { event: 'delta', data: JSON.stringify({ v: ' n |' }) },
    { data: '[DONE]' },
  ])
  const r = decodeDeltaStream(raw)
  assert.equal(r.text, '| PMID | Drug | n |')
  assert.equal(r.model, 'gpt-5-6-thinking')
  assert.equal(r.finished, true)
})

test('wire: a patch batch applies every op, and patch mode persists', () => {
  // Taken from the recorded stream: once a turn starts sending patches it
  // keeps sending them, and the following frames inherit o:"patch" and carry
  // further op ARRAYS rather than a bare string. Assuming a string here
  // (which is what intuition suggests) silently drops the rest of the answer.
  const part = '/message/content/parts/0'
  const raw = sse([
    { data: JSON.stringify({ p: '', o: 'add', c: 0, v: JSON.parse(msg('assistant', 'text', [''])) }) },
    { data: JSON.stringify({ o: 'append', p: part, v: 'a' }) },
    { data: JSON.stringify({ o: 'patch', p: '', v: [{ p: part, o: 'append', v: 'b' }] }) },
    { data: JSON.stringify({ v: [{ p: part, o: 'append', v: 'c' }] }) },
    { data: JSON.stringify({ v: [{ p: part, o: 'append', v: 'd' }, { p: '/message/metadata/finished', o: 'replace', v: true }] }) },
  ])
  assert.equal(decodeDeltaStream(raw).text, 'abcd')
})

test('wire: the answer is assistant TEXT, not a thought or a tool call', () => {
  // One turn carries user, several system, tool and assistant-reasoning
  // channels. "The last assistant message" returns reasoning, not the answer.
  const raw = sse([
    { data: JSON.stringify({ p: '', o: 'add', c: 0, v: JSON.parse(msg('assistant', 'text', ['the answer'])) }) },
    { data: JSON.stringify({ c: 1, v: JSON.parse(msg('assistant', 'thoughts', ['let me think'])) }) },
    { data: JSON.stringify({ c: 2, v: JSON.parse(msg('tool', 'text', ['search results'])) }) },
    { data: JSON.stringify({ c: 3, v: JSON.parse(msg('system', 'text', ['policy'])) }) },
  ])
  assert.equal(decodeDeltaStream(raw).text, 'the answer')
})

test('wire: citation markers are removed whole, not just their sentinels', () => {
  // Stripping only the sentinel characters leaves "citeturn0search1"
  // sitting inside a table cell, which then travels into a CSV as if the
  // model had written it.
  const marker = PUA200 + 'cite' + PUA202 + 'turn0search1' + PUA201
  const { text, marks } = stripMarkers('60 ' + marker + ' patients')
  assert.equal(text, '60  patients')
  assert.equal(marks.length, 1)
  assert.equal(marks[0].index, 3)
})

test('wire: a cited source keeps its position in the CLEAN text', () => {
  // The shape taken from the recording. Sources are NOT on the answer
  // message - they arrive on the tool/reasoning channels as
  // search_result_groups, and the inline marker names one by ref_id.
  // Reading only the answer's own content_references reported "the server
  // withheld the sources" while the UI was showing them under
  // "Visualizar fontes".
  const marker = PUA200 + 'cite' + PUA202 + 'turn638403search2' + PUA201
  const group = {
    search_result_groups: [
      {
        type: 'search_result_group',
        domain: 'pubmed.ncbi.nlm.nih.gov',
        entries: [
          {
            type: 'search_result',
            url: 'https://pubmed.ncbi.nlm.nih.gov/41420428/',
            title: 'Effect of Dexmedetomidine',
            attribution: 'pubmed.ncbi.nlm.nih.gov',
            ref_id: { turn_index: 638403, ref_type: 'search', ref_index: 2 },
          },
        ],
      },
    ],
  }
  const raw = sse([
    { data: JSON.stringify({ p: '', o: 'add', c: 0, v: JSON.parse(msg('tool', 'text', ['results'], group)) }) },
    { data: JSON.stringify({ c: 1, v: JSON.parse(msg('assistant', 'text', ['n = 60 ' + marker])) }) },
  ])
  const r = decodeDeltaStream(raw)
  assert.equal(r.text, 'n = 60 ')
  assert.equal(r.citations.length, 1)
  // Offsets into the raw text would point past the end once stripped.
  assert.equal(r.citations[0].at, 7)
  assert.equal(r.citations[0].url, 'https://pubmed.ncbi.nlm.nih.gov/41420428/')
  assert.equal(r.unresolved_markers, 0)
  // Everything the turn looked at is reported too, cited or not.
  assert.equal(r.sources.length, 1)
})

test('wire: a marker whose source was withheld is counted, not forgotten', () => {
  // Observed live: the model cited three sources and the server marked every
  // reference invalid with no URL. The answer claimed support it did not
  // deliver, and a caller weighing the text deserves to know.
  const marker = PUA200 + 'cite' + PUA202 + 'turn638403search2' + PUA201
  const raw = sse([
    {
      data: JSON.stringify({
        p: '', o: 'add', c: 0,
        v: JSON.parse(msg('assistant', 'text', ['60 ' + marker], {
          content_references: [{ matched_text: marker, invalid: true, safe_urls: [], refs: [] }],
        })),
      }),
    },
  ])
  const r = decodeDeltaStream(raw)
  assert.equal(r.citations.length, 0)
  assert.equal(r.unresolved_markers, 1)
})

test('wire: a half-written final frame does not throw', () => {
  // The same decoder runs against a stream that is still open, so the last
  // line is routinely half a JSON object.
  const raw =
    sse([{ data: JSON.stringify({ p: '', o: 'add', c: 0, v: JSON.parse(msg('assistant', 'text', ['partial'])) }) }]) +
    'data: {"o":"append","p":"/message/con'
  const r = decodeDeltaStream(raw)
  assert.equal(r.text, 'partial')
  assert.equal(r.malformed, 1)
  assert.equal(r.finished, false)
})

test('wire: SSE framing survives CRLF', () => {
  const CR = String.fromCharCode(13)
  const raw = `event: delta${CR}${LF}data: {"v":1}${CR}${LF}${CR}${LF}`
  assert.equal(parseSSE(raw).length, 1)
  assert.equal(parseSSE(raw)[0].event, 'delta')
})

// --- the wire tap ------------------------------------------------------------
// Driven with a fake CDP client, event by event, in the order Chrome emits
// them. What is being tested is the bookkeeping: arming, matching, chunk
// assembly, completion - not Chrome.

function fakeCDP() {
  const handlers = new Map()
  const sent = []
  const client = {
    on(ev, fn) { handlers.set(ev, fn) },
    async send(method, params) {
      sent.push({ method, params })
      if (method === 'Network.streamResourceContent') return { bufferedData: '' }
      if (method === 'Network.getRequestPostData') return { postData: '{"model":"gpt-5-6-thinking"}' }
      if (method === 'Network.getResponseBody') {
        if (client.bodyFor) return client.bodyFor
        throw new Error('no body retained')
      }
      return {}
    },
    emit: (ev, e) => handlers.get(ev)?.(e),
    sent,
  }
  return client
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

test('wire tap: a capture armed before the request sees it, one armed after does not', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const early = tap.expect(/conversation$/)
  cdp.emit('Network.requestWillBeSent', { requestId: '1', request: { url: 'https://x/backend-api/f/conversation', method: 'POST' } })
  const late = tap.expect(/conversation$/)
  cdp.emit('Network.responseReceived', { requestId: '1', response: { status: 200, mimeType: 'text/event-stream' } })
  await new Promise((r) => setImmediate(r))
  cdp.emit('Network.dataReceived', { requestId: '1', data: b64('data: "v1"\n\n') })
  cdp.emit('Network.loadingFinished', { requestId: '1' })
  const res = await early.finished(1000)
  assert.equal(res.ok, true)
  assert.equal(res.body, 'data: "v1"\n\n')
  await assert.rejects(late.request(50))
})

test('wire tap: subscribes to the stream at responseReceived, not later', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  tap.expect(/answer/)
  cdp.emit('Network.requestWillBeSent', { requestId: '7', request: { url: 'https://x/answer', method: 'POST' } })
  cdp.emit('Network.responseReceived', { requestId: '7', response: { status: 200, mimeType: 'text/event-stream' } })
  await new Promise((r) => setImmediate(r))
  const call = cdp.sent.find((s) => s.method === 'Network.streamResourceContent')
  assert.ok(call, 'streamResourceContent must be requested')
  assert.equal(call.params.requestId, '7')
})

test('wire tap: a multibyte character split across chunks survives', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const cap = tap.expect(/answer/)
  cdp.emit('Network.requestWillBeSent', { requestId: '2', request: { url: 'https://x/answer', method: 'POST' } })
  cdp.emit('Network.responseReceived', { requestId: '2', response: { status: 200, mimeType: 'text/plain' } })
  await new Promise((r) => setImmediate(r))
  const bytes = Buffer.from('coração ' + String.fromCharCode(0xe200), 'utf8')
  // Cut inside the "ç" and inside the sentinel.
  const cuts = [3, 4, bytes.length - 1]
  let prev = 0
  for (const c of [...cuts, bytes.length]) {
    cdp.emit('Network.dataReceived', { requestId: '2', data: bytes.subarray(prev, c).toString('base64') })
    prev = c
  }
  cdp.emit('Network.loadingFinished', { requestId: '2' })
  const res = await cap.finished(1000)
  assert.equal(res.body, 'coração ' + String.fromCharCode(0xe200))
})

test('wire tap: collect() counts one completed request per upload, and reads its body', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const ups = tap.collect(/process_upload_stream$/)
  for (const id of ['a', 'b']) {
    cdp.emit('Network.requestWillBeSent', { requestId: id, request: { url: 'https://x/backend-api/files/process_upload_stream', method: 'POST' } })
    cdp.emit('Network.responseReceived', { requestId: id, response: { status: 200, mimeType: 'text/event-stream' } })
  }
  await new Promise((r) => setImmediate(r))
  cdp.emit('Network.dataReceived', { requestId: 'a', data: b64('{"event":"file.processing.file_ready"}') })
  cdp.emit('Network.loadingFinished', { requestId: 'a' })
  assert.equal(ups.completed().length, 1)
  await assert.rejects(ups.atLeast(2, 50), /2 .*request/)
  cdp.emit('Network.dataReceived', { requestId: 'b', data: b64('{"event":"file.processing.file_ready"}') })
  cdp.emit('Network.loadingFinished', { requestId: 'b' })
  const done = await ups.atLeast(2, 1000)
  assert.equal(done.length, 2)
  assert.ok(done.every((u) => /file_ready/.test(u.body)))
})

test('wire tap: a failed load completes with ok=false and the error named', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const cap = tap.expect(/answer/)
  cdp.emit('Network.requestWillBeSent', { requestId: '3', request: { url: 'https://x/answer', method: 'POST' } })
  cdp.emit('Network.responseReceived', { requestId: '3', response: { status: 200, mimeType: 'text/event-stream' } })
  await new Promise((r) => setImmediate(r))
  cdp.emit('Network.dataReceived', { requestId: '3', data: b64('data: {"v":"half') })
  cdp.emit('Network.loadingFailed', { requestId: '3', errorText: 'net::ERR_CONNECTION_RESET' })
  const res = await cap.finished(1000)
  assert.equal(res.ok, false)
  assert.equal(res.error, 'net::ERR_CONNECTION_RESET')
  assert.equal(res.body, 'data: {"v":"half')
})

test('wire tap: the body the page sent is readable, fetched on demand', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const cap = tap.expect(/answer/)
  cdp.emit('Network.requestWillBeSent', { requestId: '4', request: { url: 'https://x/answer', method: 'POST', hasPostData: true } })
  assert.equal(JSON.parse(await cap.sentBody()).model, 'gpt-5-6-thinking')
})

// --- pacing --------------------------------------------------------------------
test('pacer: starts are spaced by the interval, across concurrent callers', async () => {
  const p = new Pacer(120)
  const t0 = Date.now()
  const stamps = await Promise.all([1, 2, 3].map(() => p.wait().then(() => Date.now() - t0)))
  stamps.sort((a, b) => a - b)
  assert.ok(stamps[0] < 60, `first should not wait (${stamps[0]}ms)`)
  assert.ok(stamps[1] >= 100, `second spaced (${stamps[1]}ms)`)
  assert.ok(stamps[2] >= 220, `third spaced (${stamps[2]}ms)`)
})

test('pacer: an interval of 0 never waits', async () => {
  const p = new Pacer(0)
  const waited = await Promise.all([p.wait(), p.wait(), p.wait()])
  assert.deepEqual(waited, [0, 0, 0])
})

// --- generated files off the wire ---------------------------------------------
// The download path is: the answer names a sandbox link, the page fetches it
// with its own credentials, we keep the bytes. These cover the parts that
// are ours: parsing, naming, and not corrupting the payload.

test('files: sandbox links come from the answer text, de-duplicated', () => {
  const text = 'Done: [download trials.csv](sandbox:/mnt/data/trials.csv) and ' +
    '[the workbook](sandbox:/mnt/data/out.xlsx). Again: [x](sandbox:/mnt/data/trials.csv)'
  const links = parseSchemeLinks(text, 'sandbox')
  assert.deepEqual(links.map((l) => l.path), ['/mnt/data/trials.csv', '/mnt/data/out.xlsx'])
  assert.equal(links[0].label, 'download trials.csv')
  assert.deepEqual(parseSchemeLinks('no files here'), [])
})

test('files: the UTF-8 filename form wins over the plain one', () => {
  assert.equal(
    filenameFromDisposition(`attachment; filename="analise.csv"; filename*=UTF-8''an%C3%A1lise.csv`),
    'análise.csv'
  )
  assert.equal(filenameFromDisposition(`attachment; filename="trials.csv"`), 'trials.csv')
  assert.equal(filenameFromDisposition(null), null)
})

test('files: a model-chosen name cannot escape the download directory', () => {
  // The FILENAME IS UNTRUSTED INPUT: the model writes it, and it lands on a
  // write path. This is the check that keeps a generated file from being
  // written over a profile's cookie jar.
  assert.equal(safeFileName('../../.profiles/gemini/Cookies'), 'Cookies')
  assert.equal(safeFileName('/etc/passwd'), 'passwd')
  assert.equal(safeFileName('..'), 'download.bin')
  // and it must not mangle ordinary names
  assert.equal(safeFileName('trials_demo1.csv'), 'trials_demo1.csv')
  assert.equal(safeFileName('análise 2026.xlsx'), 'análise 2026.xlsx')
  // reserved device names and control characters
  assert.equal(safeFileName('NUL.csv'), '_NUL.csv')
  assert.equal(safeFileName('a' + String.fromCharCode(0) + 'b.csv'), 'ab.csv')
  assert.ok(safeFileName('x'.repeat(300) + '.csv').length <= 180)
})

test('files: a downloaded file keeps its exact bytes and is named by the server', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const dir = mkdtempSync(join(tmpdir(), 'uibridge-files-'))
  // A payload with NUL and high bytes: a utf8 round-trip would destroy it,
  // which is exactly what an .xlsx or a .png is.
  const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x0a, 0x00, 0x41])

  const done = captureDownload(tap, async () => {
    cdp.emit('Network.requestWillBeSent', { requestId: 'm', request: { url: 'https://x/backend-api/conversation/c/interpreter/download?message_id=1', method: 'GET' } })
    cdp.emit('Network.requestWillBeSent', { requestId: 'c', request: { url: 'https://x/backend-api/estuary/content?id=file_1', method: 'GET' } })
    cdp.emit('Network.responseReceived', { requestId: 'm', response: { status: 200, mimeType: 'application/json', headers: {} } })
    cdp.emit('Network.responseReceived', { requestId: 'c', response: { status: 200, mimeType: 'application/zip', headers: { 'content-disposition': 'attachment; filename="ignored.bin"', 'set-cookie': 'session=SECRET' } } })
    await new Promise((r) => setImmediate(r))
    cdp.emit('Network.dataReceived', { requestId: 'm', data: Buffer.from(JSON.stringify({ file_name: 'out.xlsx', mime_type: 'application/vnd.ms-excel' })).toString('base64') })
    cdp.emit('Network.loadingFinished', { requestId: 'm' })
    cdp.emit('Network.dataReceived', { requestId: 'c', data: payload.toString('base64') })
    cdp.emit('Network.loadingFinished', { requestId: 'c' })
  }, { contentPattern: /estuary\/content/, metaPattern: /interpreter\/download/, dir, timeoutMs: 2000 })

  const got = await done
  assert.equal(got.name, 'out.xlsx', 'the metadata JSON names the file')
  assert.equal(got.mime, 'application/vnd.ms-excel')
  assert.deepEqual(readFileSync(got.path), payload, 'bytes must survive exactly')
  rmSync(dir, { recursive: true, force: true })
})

test('files: response headers are kept to a payload allowlist, never credentials', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const cap = tap.expect(/estuary/)
  cdp.emit('Network.requestWillBeSent', { requestId: 'h', request: { url: 'https://x/estuary/content', method: 'GET' } })
  cdp.emit('Network.responseReceived', {
    requestId: 'h',
    response: { status: 200, mimeType: 'text/csv', headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="a.csv"', 'set-cookie': 'session=SECRET', authorization: 'Bearer SECRET' } },
  })
  await new Promise((r) => setImmediate(r))
  cdp.emit('Network.loadingFinished', { requestId: 'h' })
  const res = await cap.finished(1000)
  assert.deepEqual(Object.keys(res.headers).sort(), ['content-disposition', 'content-type'])
  assert.ok(!JSON.stringify(res.headers).includes('SECRET'))
})

test('files: a refused download reports the status instead of writing a stub', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const dir = mkdtempSync(join(tmpdir(), 'uibridge-files-'))
  const done = captureDownload(tap, async () => {
    cdp.emit('Network.requestWillBeSent', { requestId: 'e', request: { url: 'https://x/backend-api/estuary/content', method: 'GET' } })
    cdp.emit('Network.responseReceived', { requestId: 'e', response: { status: 403, mimeType: 'application/json', headers: {} } })
    await new Promise((r) => setImmediate(r))
    cdp.emit('Network.loadingFinished', { requestId: 'e' })
  }, { contentPattern: /estuary\/content/, dir, timeoutMs: 2000 })
  await assert.rejects(done, /HTTP 403/)
  assert.equal(readdirSync(dir).length, 0, 'nothing may be written for a failed download')
  rmSync(dir, { recursive: true, force: true })
})

test('wire tap: an empty stream falls back to asking for the body', async () => {
  // Measured on the file endpoints: the subscription succeeds and then
  // delivers no data events, so the bytes have to be requested explicitly.
  // Without this the download wrote a 0-byte "CSV".
  const cdp = fakeCDP()
  cdp.bodyFor = { body: Buffer.from('pmid,drug,n').toString('base64'), base64Encoded: true }
  const tap = await WireTap.fromClient(cdp)
  const cap = tap.expect(/estuary/)
  cdp.emit('Network.requestWillBeSent', { requestId: 'z', request: { url: 'https://x/estuary/content', method: 'GET' } })
  cdp.emit('Network.responseReceived', { requestId: 'z', response: { status: 200, mimeType: 'text/csv', headers: {} } })
  await new Promise((r) => setImmediate(r))
  cdp.emit('Network.loadingFinished', { requestId: 'z' })
  const res = await cap.finished(1000)
  assert.equal(res.body, 'pmid,drug,n')
  assert.equal(res.bytes, 11)
})

test('wire tap: a redirected request still completes for its capture', async () => {
  // A redirect REUSES the request id. Treating the second requestWillBeSent
  // as a new request orphans the capture, which then waits out its whole
  // timeout for a response that already arrived.
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const cap = tap.expect(/estuary\/content/)
  cdp.emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x/backend-api/estuary/content?id=1', method: 'GET' } })
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'r1',
    request: { url: 'https://cdn.example/signed/blob', method: 'GET' },
    redirectResponse: { status: 302, url: 'https://x/backend-api/estuary/content?id=1' },
  })
  cdp.emit('Network.responseReceived', { requestId: 'r1', response: { status: 200, mimeType: 'text/csv', headers: { 'content-type': 'text/csv' } } })
  await new Promise((r) => setImmediate(r))
  cdp.emit('Network.dataReceived', { requestId: 'r1', data: Buffer.from('a,b').toString('base64') })
  cdp.emit('Network.loadingFinished', { requestId: 'r1' })
  const res = await cap.finished(1000)
  assert.equal(res.body, 'a,b')
  assert.equal(res.url, 'https://cdn.example/signed/blob', 'the record follows the redirect target')
})

test('wire tap: recent paths are reported without their signed query strings', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  tap.expect(/nothing/)
  cdp.emit('Network.requestWillBeSent', { requestId: 's', request: { url: 'https://x/backend-api/estuary/content?sig=SECRETSIGNATURE', method: 'GET' } })
  const seen = tap.seen()
  assert.deepEqual(seen, ['/backend-api/estuary/content'])
  assert.ok(!seen.join(' ').includes('SECRET'))
})

test('files: a swallowed click is retried until the page actually fetches', async () => {
  // A click Playwright calls successful can still be ignored by the app.
  // What counts is the request going out, so the trigger is repeated until
  // it does - otherwise a generated file is reported missing when the only
  // problem was one lost click.
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const dir = mkdtempSync(join(tmpdir(), 'uibridge-retry-'))
  let clicks = 0
  const got = await captureDownload(tap, async () => {
    clicks++
    if (clicks < 2) return // the first click does nothing at all
    cdp.emit('Network.requestWillBeSent', { requestId: 'k', request: { url: 'https://x/backend-api/estuary/content', method: 'GET' } })
    cdp.emit('Network.responseReceived', { requestId: 'k', response: { status: 200, mimeType: 'text/csv', headers: { 'content-disposition': 'attachment; filename="late.csv"' } } })
    await new Promise((r) => setImmediate(r))
    cdp.emit('Network.dataReceived', { requestId: 'k', data: Buffer.from('pmid,n').toString('base64') })
    cdp.emit('Network.loadingFinished', { requestId: 'k' })
  }, { contentPattern: /estuary\/content/, dir, timeoutMs: 2000, ackMs: 300 })
  assert.equal(clicks, 2, 'the trigger must be repeated when no request appears')
  assert.equal(got.name, 'late.csv')
  assert.equal(readFileSync(got.path, 'utf8'), 'pmid,n')
  rmSync(dir, { recursive: true, force: true })
})

test('files: clicks that never produce a request fail with that as the reason', async () => {
  const cdp = fakeCDP()
  const tap = await WireTap.fromClient(cdp)
  const dir = mkdtempSync(join(tmpdir(), 'uibridge-noreq-'))
  await assert.rejects(
    captureDownload(tap, async () => {}, { contentPattern: /estuary/, dir, timeoutMs: 500, ackMs: 150, attempts: 2 }),
    /produced no request/
  )
  rmSync(dir, { recursive: true, force: true })
})
