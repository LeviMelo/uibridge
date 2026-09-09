import { openSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'

/** Reserve a destination atomically across requests and daemon restarts.
 * Callers sanitize the basename and create the directory before reserving.
 */
export function reserveOutputFile(dir, name, taken = new Set()) {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`
    if (taken.has(candidate.toLowerCase())) continue
    const path = resolve(dir, candidate)
    try {
      closeSync(openSync(path, 'wx'))
      taken.add(candidate.toLowerCase())
      return path
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
}
