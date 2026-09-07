// CHATGPT
//
// Actuation through the DOM, extraction off the wire. The request flow is
// the generic one in ../dom-provider.mjs; what makes this provider different
// is declared in selectors.json under `wire`: the page's own conversation
// request is tapped and its response - the model's markdown, its citations
// and the slug of the model that answered - is decoded directly.
//
// Nothing here composes a request or forges the site's anti-bot tokens. The
// composer is typed into and the send button clicked, as a person would; the
// only difference from the DOM path is where the answer is read from.
//
// THE MODEL PICKER IS TWO CONTROLS IN ONE POPOVER, measured live 2026-09-06:
//
//   a slider  role=slider, aria-valuenow 0..3 - the reasoning EFFORT:
//             0 Instantânea, 1 Média, 2 Alta, 3 Pro (locked: "Upgrade
//             necessário" on this plan). Driven with the arrow keys, which
//             is what its own help text says to do.
//   radios    role=menuitemradio "GPT-5.6 Sol" / "GPT-5.5" - the FAMILY.
//
// So a model id here is family × effort, and neither dimension is a label
// to be matched off a button: the slider's aria-valuenow and the radio's
// aria-checked are read back, and the wire then reports which slug actually
// answered. The UI is pt-BR on this account; nothing below matches on text
// except the family names, which are product names and not translations.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DomProvider } from '../dom-provider.mjs'
import { BridgeError } from '../../core/errors.mjs'
import { waitFor } from '../../core/async.mjs'
import { WireTap } from '../../transports/wire.mjs'
import { captureDownload, parseSchemeLinks } from '../../transports/files-wire.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export default class ChatGPTProvider extends DomProvider {
  static id = 'chatgpt'
  static selectors = JSON.parse(readFileSync(resolve(HERE, 'selectors.json'), 'utf8'))
  // minIntervalMs: a burst of fresh conversations tripped this site's
  // throttling during calibration (about a dozen in fifteen minutes). Twenty
  // seconds between request starts, provider-wide, is the floor; raise it in
  // config.json for long batches.
  static defaults = {
    settleChecks: 4,
    concurrency: 1,
    minIntervalMs: 20000,
    // MEASURED 2026-09-06: with --headless=new, chatgpt.com serves an
    // ANONYMOUS session even though the profile's __Secure-next-auth
    // .session-token cookies are present and were sent. So this provider
    // runs a real browser parked off the visible desktop instead: nothing
    // pops up, and the site sees what it sees for a person.
    headless: 'offscreen',
  }

  capabilities() {
    return { ...super.capabilities(), calibrated: !!this.sel.calibrated }
  }

  async open(page) {
    if (!this.sel.calibrated) {
      throw new BridgeError(
        'The chatgpt provider is not calibrated: its selectors have not been read from the ' +
          'live page. Run "uibridge recon exchange https://chatgpt.com/ --profile chatgpt", ' +
          'fill in src/providers/chatgpt/selectors.json, and set calibrated:true.',
        { status: 501, code: 'not_calibrated' }
      )
    }
    return super.open(page)
  }

  // --- generated files -----------------------------------------------------

  /**
   * Files the code interpreter produced, saved from the wire.
   *
   * WHAT WAS MEASURED (2026-09-06, one real exchange):
   *   the answer says     "[download trials_demo.csv](sandbox:/mnt/data/trials_demo.csv)"
   *   clicking that       GET /backend-api/conversation/<id>/interpreter/download
   *                           ?message_id=..&sandbox_path=/mnt/data/trials_demo.csv
   *                       -> {"download_url": ".../estuary/content?..", "file_name",
   *                           "mime_type", "metadata":{"file_id"}}
   *   then                GET /backend-api/estuary/content?..  -> the bytes,
   *                       content-disposition: attachment; filename="trials_demo.csv"
   *
   * The bytes are read from the response THE PAGE receives. Calling those
   * endpoints ourselves is not an option and was not left as a guess: both
   * an in-page fetch with cookies and Playwright's request context return
   * 401 "Access token is missing", because the app signs them with a bearer
   * token in its own JavaScript. Lifting that token out of the session is
   * exactly what this project does not do.
   *
   * A file that cannot be retrieved is REPORTED, not dropped: the entry
   * carries an `error` instead of a path, because a pipeline silently one
   * CSV short is worse than one that fails loudly.
   */
  async generatedFiles(page, ctx, text) {
    const g = this.sel.generatedFile
    if (!g?.scheme) return []
    const links = parseSchemeLinks(text, g.scheme)
    if (!links.length) return []

    const tap = await WireTap.attach(page)
    const turn = page.locator(this.sel.responseBlocks).last()
    const controls = turn.locator(g.control)

    // WAIT FOR THE CONTROL BEFORE READING ANYTHING OFF IT. The answer text
    // arrives on the wire before the turn has finished rendering, so an
    // immediate read returns an empty list - which then looks exactly like
    // "this provider stopped rendering download links" and hides a real
    // file behind a made-up diagnosis.
    await controls.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    this.log?.debug(`${links.length} file link(s) in the answer, ${await controls.count().catch(() => 0)} download control(s) rendered`)
    // Match by label rather than building a CSS selector out of model-written
    // text: a filename containing a quote or a bracket would break the
    // selector, not the code.
    const labels = await controls
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? (e.textContent ?? '').trim()))
      .catch(() => [])

    const out = []
    const taken = new Set()
    for (let i = 0; i < links.length; i++) {
      const link = links[i]
      const fallbackName = link.path.split('/').pop() || 'download.bin'
      const at = labels.findIndex((l) => l && (l === link.label || l.includes(fallbackName)))
      const index = at >= 0 ? at : i
      if (index >= labels.length) {
        this.log?.warn(`${fallbackName}: the answer links it but no download control was rendered`)
        out.push({ name: fallbackName, error: 'no download control was rendered for this link', source: 'wire' })
        continue
      }
      const control = controls.nth(index)
      try {
        out.push(
          await captureDownload(tap, () => this.clickThrough(control, { attempts: 2, timeout: 4000, what: `the ${fallbackName} download link` }), {
            contentPattern: g.contentPattern,
            metaPattern: g.metadataPattern,
            dir: this.settings.downloadDir,
            timeoutMs: this.settings.fileWaitMs,
            fallbackName,
            taken,
            log: this.log,
          })
        )
      } catch (e) {
        // Name what the page DID request. "Nothing matched" is not a
        // diagnosis, and guessing from it is how two runs got blamed on the
        // wrong component.
        this.log?.warn(
          `${fallbackName}: could not retrieve the file - ${e.message.split('\n')[0]}` +
            `; the page's recent requests were: ${tap.seen().slice(-8).join(', ')}`
        )
        out.push({ name: fallbackName, error: e.message.split('\n')[0], source: 'wire' })
      }
    }
    return out
  }

  // --- the picker ----------------------------------------------------------

  #popover(page) {
    return page.locator(this.sel.picker.content).first()
  }

  async #openPicker(page) {
    const p = this.sel.picker
    const pop = this.#popover(page)
    if (await pop.isVisible().catch(() => false)) return pop
    await this.requireContract(page, 'picker.trigger', p.trigger)
    await page.locator(p.trigger).first().click({ timeout: 10000 })
    await pop.waitFor({ state: 'visible', timeout: 8000 })
    return pop
  }

  /** What the popover says right now: { effort, effortLabel, family }. */
  async #readPicker(page) {
    const p = this.sel.picker
    const pop = this.#popover(page)
    return pop.evaluate(
      (root, p) => {
        const slider = root.querySelector(p.slider)
        const checked = [...root.querySelectorAll(p.familyOption)].find((e) => e.getAttribute('aria-checked') === 'true')
        const label = root.querySelector(p.effortLabel)
        return {
          effort: slider ? Number(slider.getAttribute('aria-valuenow')) : null,
          effortLabel: label ? (label.innerText || '').trim() : null,
          family: checked ? (checked.innerText || '').trim() : null,
        }
      },
      p
    )
  }

  /** Provenance in the UI's own words, after everything is applied. */
  async readState(page) {
    try {
      await this.#openPicker(page)
      const s = await this.#readPicker(page)
      await page.keyboard.press('Escape')
      return `${s.family ?? '?'} / ${s.effortLabel ?? '?'} (effort ${s.effort})`
    } catch {
      return null
    }
  }

  async selectModel(page, modelId) {
    const spec = this.sel.models?.[modelId]
    if (!spec) return { requested: modelId, applied: null, verified: false, note: 'unknown model' }
    const p = this.sel.picker
    const familyRe = new RegExp(spec.family)

    await this.#openPicker(page)
    let state = await this.#readPicker(page)

    // FAMILY first: choosing it can reset the popover, so the effort is set
    // afterwards, against whatever the family's slider shows.
    //
    // The radios live on a SECOND PANEL of the same popover (measured: the
    // "simple view" holds the slider, the "advanced view" the family list,
    // and the row labelled "Selecionar modelo" flips between them). Clicking
    // a radio while the simple view is up is intercepted by that panel.
    if (!state.family || !familyRe.test(state.family)) {
      const pop = this.#popover(page)
      await pop.locator(p.familyPanelToggle).first().click({ timeout: 8000 })
      const radio = pop.locator(p.familyOption).filter({ hasText: familyRe }).first()
      if (!(await radio.count().catch(() => 0))) {
        await page.keyboard.press('Escape').catch(() => {})
        await page.keyboard.press('Escape').catch(() => {})
        return { requested: modelId, applied: null, verified: false, note: `family "${spec.family}" not offered` }
      }
      await radio.click({ timeout: 8000 })
      // Back to the slider panel: one Escape steps back a panel, and only a
      // second one closes the popover.
      await page.keyboard.press('Escape').catch(() => {})
      await this.#openPicker(page)
      state = await waitFor(
        async () => {
          const s = await this.#readPicker(page)
          return s.family && familyRe.test(s.family) ? s : null
        },
        { timeout: 8000, poll: this.settings.pollMs, what: `the family radio to read back as ${spec.family}` }
      ).catch(() => null)
      if (!state) {
        await page.keyboard.press('Escape').catch(() => {})
        return { requested: modelId, applied: null, verified: false, note: 'family switch not reflected in the UI' }
      }
    }

    // EFFORT: arrow keys on the slider, one step at a time, reading back
    // after each. A position that will not take (the locked "Pro" stop)
    // shows up as the value refusing to move, not as an exception.
    const slider = this.#popover(page).locator(p.slider).first()
    await slider.focus()
    for (let guard = 0; guard < 8 && state.effort !== spec.effort; guard++) {
      await page.keyboard.press(state.effort < spec.effort ? 'ArrowRight' : 'ArrowLeft')
      const before = state.effort
      state = await waitFor(
        async () => {
          const s = await this.#readPicker(page)
          return s.effort !== before ? s : null
        },
        { timeout: 2000, poll: this.settings.pollMs, what: 'the effort slider to move' }
      ).catch(() => state)
      if (state.effort === before) break
    }
    await page.keyboard.press('Escape').catch(() => {})

    const applied = `${state.family} / ${state.effortLabel} (effort ${state.effort})`
    const ok = state.effort === spec.effort
    if (!ok) this.log?.warn(`asked for ${modelId} but the picker holds "${applied}" - recorded as unverified`)
    return {
      requested: modelId,
      applied,
      verified: ok,
      note: ok ? 'picker reads back as requested' : 'effort did not take (a locked tier?)',
      // Checked again once the answer arrives: the wire says which slug
      // actually answered, and that outranks the picker.
      expected_slug: spec.slug,
      // null means "the request must carry no effort field" (Instantânea);
      // a string must match the request's thinking_effort exactly.
      expected_effort: spec.sentEffort === undefined ? undefined : spec.sentEffort,
    }
  }
}
