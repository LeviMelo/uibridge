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
import { Mutex, waitFor, waitStable } from '../src/core/async.mjs'
import { flattenMessages, readAttachments, readModes } from '../src/api/openai.mjs'
import { resolveModel, modelCatalogue, providerIds } from '../src/providers/registry.mjs'
import { RequestError, SignedOutError, ContractError } from '../src/core/errors.mjs'

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

test('registry: providers expose themselves as models', () => {
  const ids = modelCatalogue().map((m) => m.id)
  for (const p of providerIds) assert.ok(ids.includes(p), `${p} should be a model id`)
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
