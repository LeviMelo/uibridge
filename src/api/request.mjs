// The HTTP contract: reject controls the UI cannot honour instead of
// silently producing a different experiment from the one requested.
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import { existsSync, statSync } from 'node:fs'
import { BridgeError, RequestError } from '../core/errors.mjs'
import { flattenMessages, readAttachments, readModes, readThreadId } from './openai.mjs'
import { modelCatalogue, providerClass, resolveModel } from '../providers/registry.mjs'

export const apiCapabilities = {
  endpoint: '/v1/chat/completions',
  input: ['text', 'local_attachments'],
  roles: ['system', 'developer', 'user', 'assistant'],
  role_semantics: 'labels_in_one_ui_prompt',
  response_formats: ['text', 'json_object', 'json_schema'],
  structured_output: 'prompted_then_validated; buffered_when_streaming',
  token_usage: 'unavailable; zero_placeholders',
  sampling_controls: false,
  tool_calls: false,
  cancellation: 'disconnect_cancels_unkeyed; explicit_cancel_for_durable_keys; provider_compute_may_continue',
  idempotency: 'Idempotency-Key; persistent_results; uncertain_crash_outcomes_never_resubmitted',
  durable_streaming: 'buffered_until_result_is_persisted',
  context_window: 'provider_UI_limit; not_measured',
}

const allowed = new Set(['model', 'messages', 'stream', 'stream_options', 'response_format', 'n',
  'attachments', 'files', 'modes', 'thread_id', '_uibridge'])
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function parseCompletionRequest(body, cfg) {
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key) && value !== null) throw new RequestError(`Unsupported parameter: ${key}. The browser UI cannot honour this API control.`)
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new RequestError('stream must be a boolean')
  if (body.n != null && body.n !== 1) throw new RequestError('Only n=1 is supported')
  if (body.stream_options != null) {
    if (!body.stream || !object(body.stream_options)) throw new RequestError('stream_options requires stream=true and an object')
    for (const [k, v] of Object.entries(body.stream_options)) {
      if (k !== 'include_usage' || typeof v !== 'boolean') throw new RequestError('Only boolean stream_options.include_usage is supported')
    }
  }
  let prompt = flattenMessages(body.messages)
  const files = readAttachments(body)
  for (const file of files) {
    if (!existsSync(file)) throw new RequestError(`attachment not found: ${file}`)
    if (!statSync(file).isFile()) throw new RequestError(`attachment is not a file: ${file}`)
  }
  const modes = readModes(body)
  const threadId = readThreadId(body)
  const requested = body.model ?? cfg.defaultProvider
  const { provider, model, matched } = resolveModel(requested, cfg.defaultProvider)
  if (!matched) throw new RequestError(`Unknown model "${requested}". Available: ${modelCatalogue().map((m) => m.id).join(', ')}`)
  for (const mode of Object.keys(modes)) {
    if (!Object.hasOwn(providerClass(provider).selectors.modes ?? {}, mode)) throw new RequestError(`Unsupported mode: ${mode}`)
  }
  const format = responseFormat(body.response_format)
  if (format.instruction) prompt += `\n\n[output format]\n${format.instruction}`
  return { prompt, files, modes, threadId, requested, provider, model, format,
    includeUsage: body.stream_options?.include_usage === true }
}

function responseFormat(format) {
  if (format == null) return { structured: false }
  if (!object(format)) throw new RequestError('response_format must be an object')
  if (format.type === 'text') return { structured: false }
  if (format.type === 'json_object') return {
    structured: true,
    instruction: 'Return exactly one JSON object. No markdown fences or surrounding prose.',
    validate: object,
  }
  if (format.type !== 'json_schema') throw new RequestError('Unsupported response_format.type')
  const spec = format.json_schema
  if (!object(spec) || typeof spec.name !== 'string' || !spec.name.trim() || !object(spec.schema)) {
    throw new RequestError('json_schema requires a name and a schema object')
  }
  if (spec.strict != null && typeof spec.strict !== 'boolean') throw new RequestError('json_schema.strict must be a boolean')
  let validate
  try {
    const Class = spec.schema.$schema?.includes('2020-12') ? Ajv2020 : Ajv
    // One validator per request: schemas cannot accumulate in a daemon-wide cache.
    validate = new Class({ strict: true, allErrors: false, strictTypes: false }).compile(spec.schema)
    if (validate.$async) throw new Error('asynchronous schemas are unsupported')
  } catch (err) { throw new RequestError(`Invalid or unsupported JSON schema: ${err.message}`) }
  return { structured: true, validate,
    instruction: `Return exactly one JSON value conforming to this JSON schema. No markdown fences or surrounding prose.\n${JSON.stringify(spec.schema)}` }
}

export function validateResult(result, format) {
  const fail = (message, code) => { throw new BridgeError(message, { status: 502, code, retryable: false }) }
  if (result.provider_error) fail('The provider returned an error notice instead of an answer', 'provider_error')
  if (typeof result.text !== 'string' || !result.text.trim()) fail('The provider returned no answer text', 'empty_response')
  if (!format.structured) return result
  if (result.truncated) fail('Structured output was truncated', 'invalid_response_format')
  let value
  try { value = JSON.parse(result.text) } catch { fail('The provider did not return valid JSON', 'invalid_response_format') }
  if (!format.validate(value)) fail('The provider response does not match the requested JSON format/schema', 'invalid_response_format')
  return result
}
