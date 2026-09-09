// Own the download directory instead of relying on a CDP client's temporary
// Playwright artifact directory, which another short-lived client can remove.
import { mkdirSync, existsSync, copyFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { Mutex, waitFor } from '../core/async.mjs'
import { BridgeError } from '../core/errors.mjs'
import { reserveOutputFile } from '../core/output-file.mjs'
import { safeFileName } from './files-wire.mjs'

const downloads = new Mutex()
export async function captureDownload(page, click, { dir, timeout = 30000 } = {}) {
  return downloads.run(async () => {
    const incoming = resolve(dir, '.incoming')
    mkdirSync(incoming, { recursive: true })
    const browser = await page.context().browser().newBrowserCDPSession()
    const target = await page.context().newCDPSession(page).catch(async (err) => {
      await browser.detach().catch(() => {})
      throw err
    })
    let item = null, state = null
    const progress = new Map()
    const [{ frameTree }, { targetInfo }] = await Promise.all([
      target.send('Page.getFrameTree'), target.send('Target.getTargetInfo'),
    ]).catch(async (err) => { await Promise.allSettled([target.detach(), browser.detach()]); throw err })
    const frameIds = new Set()
    const collect = (tree) => { frameIds.add(tree.frame.id); for (const child of tree.childFrames ?? []) collect(child) }
    collect(frameTree)
    const targets = new Set([targetInfo.targetId])
    // Drive-style viewers start downloads in a short-lived popup. Its frame
    // is not in the page's original frame tree, but CDP identifies its opener.
    const opened = ({ targetInfo: info }) => {
      if (targets.has(info.openerId) || frameIds.has(info.openerFrameId)) {
        targets.add(info.targetId)
        frameIds.add(info.targetId)
      }
    }
    const began = (e) => { if (frameIds.has(e.frameId) && !item) item = e }
    const changed = (e) => { progress.set(e.guid, e.state) }
    browser.on('Browser.downloadWillBegin', began)
    browser.on('Browser.downloadProgress', changed)
    browser.on('Target.targetCreated', opened)
    try {
      await browser.send('Target.setDiscoverTargets', { discover: true })
      await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: incoming, eventsEnabled: true })
      await click()
      await waitFor(() => {
        if (!item) return null
        state = progress.get(item.guid)
        if (state === 'canceled') return true
        return state === 'completed'
      }, { timeout, poll: 100, what: 'the browser download to complete' })
      if (state === 'canceled') throw new BridgeError('Browser cancelled the download', { code: 'download_cancelled', status: 502 })
      if (!/^[a-zA-Z0-9-]+$/.test(item.guid)) throw new BridgeError('Invalid browser download identifier', { code: 'download_identifier', status: 502 })
      const source = resolve(incoming, item.guid)
      if (!existsSync(source)) throw new BridgeError('Browser reported completion but the download artifact is missing', {
        code: 'download_artifact_missing', status: 502, detail: { source_exists: false, artifact_id: item.guid },
      })
      const name = safeFileName(item.suggestedFilename || 'download.bin')
      const path = reserveOutputFile(dir, name)
      try { copyFileSync(source, path) } catch (err) {
        try { unlinkSync(path) } catch {}
        throw new BridgeError('Could not save the completed browser download', {
          status: 502, code: err.code ?? 'download_save_failed', detail: { source_exists: existsSync(source), artifact_id: item.guid },
        })
      }
      unlinkSync(source)
      return { name, path }
    } finally {
      if (item && state !== 'completed') await browser.send('Browser.cancelDownload', { guid: item.guid }).catch(() => {})
      browser.off('Browser.downloadWillBegin', began)
      browser.off('Browser.downloadProgress', changed)
      browser.off('Target.targetCreated', opened)
      await Promise.allSettled([browser.detach(), target.detach()])
    }
  })
}
