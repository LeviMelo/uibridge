// THE PROVIDER CONTRACT
//
// This is the seam that makes the goal outlive any particular UI. The goal is
// fixed - "send a prompt and optional files to a chat UI I already pay for,
// and get faithful text, tables, citations and generated files back" - while
// Gemini, ChatGPT and their DOMs are all moving targets.
//
// So everything provider-specific lives behind these methods, and NOTHING
// above this layer (the pool, the session orchestrator, the HTTP API) may
// import a selector, a provider name, or a vendor quirk.
//
// Two axes vary independently, and conflating them is what made the prototype
// rigid:
//
//   ACTUATION  - how you drive the UI: type, submit, pick a model, attach a
//                file. Necessarily DOM work.
//   EXTRACTION - how you read the answer back. A "transport": today the DOM
//                (plus the copy button); potentially the network payload the
//                page already receives. See transports/.
//
// A provider declares which transports it supports and in what order to try
// them, so a wire transport can be added for one provider without touching
// the other, or the shared code.

import { BridgeError } from '../core/errors.mjs'

/** What a provider can do, so the API can advertise it honestly. */
export class Capabilities {
  constructor({
    models = {},
    modes = {},
    attachments = false,
    generatedFiles = false,
    citations = false,
    // Declared by both real providers and by echo, and silently dropped
    // here until 2026-09-09 - so /v1/capabilities said nothing about
    // thread export while dom-provider's comment claimed it was honest.
    threadExport = false,
    transports = ['dom'],
  } = {}) {
    Object.assign(this, { models, modes, attachments, generatedFiles, citations, threadExport, transports })
  }
}

/**
 * Base class. Subclasses implement the abstract half; the shared half is here
 * so providers do not each reinvent it.
 */
export class Provider {
  /** Stable id used in config, model names and the CLI: "gemini". */
  static id = 'abstract'

  constructor({ selectors, settings, log }) {
    this.selectors = selectors
    this.settings = settings
    this.log = log
  }

  get id() {
    return this.constructor.id
  }

  /** Origin for clipboard grants and cookie scoping. */
  get origin() {
    return new URL(this.settings.url).origin
  }

  capabilities() {
    throw new BridgeError(`${this.id}: capabilities() not implemented`)
  }

  // --- lifecycle -----------------------------------------------------------

  /** Navigate far enough to inspect authentication; must not require signed-in UI. */
  async prepareAuth(_page) {
    this.#todo('prepareAuth')
  }

  /** Navigate to a usable, signed-in composer. Throws SignedOutError. */
  async open(_page) {
    this.#todo('open')
  }

  /** True when a real account is present - not merely a rendered composer. */
  async isSignedIn(_page) {
    this.#todo('isSignedIn')
  }

  /** Start a fresh conversation, so requests never share context. */
  async newConversation(_page) {
    this.#todo('newConversation')
  }

  async resumeThread(_page, _url) {
    this.#todo('resumeThread')
  }

  async currentThread(_page, _ctx) {
    return null
  }

  async threadIds(_page) {
    return []
  }

  async lastResponseText(_page) {
    return null
  }

  async responseTexts(_page) {
    return []
  }

  async exportThread(_page, _threadId) {
    this.#todo('exportThread')
  }

  // --- controls ------------------------------------------------------------

  /**
   * Select a model. MUST return provenance:
   *   { requested, applied, verified, note }
   * "Requested" is not "applied": a picker can silently ignore a click, and a
   * research pipeline needs to record which model actually answered.
   */
  async selectModel(_page, _modelId) {
    this.#todo('selectModel')
  }

  /** Toggle a named mode (e.g. extended thinking). Same provenance rule. */
  async setMode(_page, _mode, _on) {
    this.#todo('setMode')
  }

  /**
   * The UI's own description of its current settings, read AFTER everything
   * has been applied.
   *
   * This is the authoritative provenance record. Per-step results are stale
   * by the end of setup: on a combined picker, the label captured while
   * choosing the model does not yet know about a mode toggled afterwards, so
   * reporting it makes modes look inverted. Optional - a provider with no
   * readable state returns null.
   */
  async readState(_page) {
    return null
  }

  // --- input ---------------------------------------------------------------

  /** Attach local files and wait until the UI has really registered them. */
  async attach(_page, _files) {
    this.#todo('attach')
  }

  /** Put the prompt in the composer and submit it. */
  async submit(_page, _prompt) {
    this.#todo('submit')
  }

  /** Resolve when the answer is complete. */
  async awaitCompletion(_page, _ctx) {
    this.#todo('awaitCompletion')
  }

  // --- output --------------------------------------------------------------

  /**
   * Return the answer as:
   *   { text, markdown, tables, code_blocks, files, sources, browsed }
   * `markdown` states whether `text` is the provider's own markdown or a
   * lossy fallback - callers doing anything with tables or maths need to know.
   */
  async extract(_page, _ctx) {
    this.#todo('extract')
  }

  #todo(name) {
    throw new BridgeError(`${this.id}: ${name}() not implemented`, { code: 'not_implemented' })
  }
}
