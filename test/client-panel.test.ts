/**
 * Task 7 — client panel rebuild guards.
 *
 * These are source-level (static) assertions, not render tests: the browser half
 * is bundled against the DSH client runtime, so there is no DOM to mount in the
 * Node test environment. Each assertion pins one binding constraint of the
 * rebuild brief:
 *
 *  1. theming goes through DSH alias tokens only, so the panel tracks the host
 *     theme instead of hard-coding colours;
 *  2. the raw status-JSON dump is gone (that was the whole point of the rebuild);
 *  3. React APIs come from `../deps.ts`, which the bundler marks external —
 *     a direct `from 'react'` import would pull a second React copy into the
 *     plugin bundle.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8')

describe('client panel rebuild', () => {
  it('uses only DSH alias tokens for custom properties', () => {
    const css = read('src/client/styles.ts')
    const customProps = [...css.matchAll(/--[a-z0-9-]+/g)].map((m) => m[0])
    const nonDsh = customProps.filter((p) => !p.startsWith('--dsw-'))
    expect(nonDsh).toEqual([])
  })

  it('no longer dumps raw JSON into the panel body', () => {
    const tsx = read('src/client/Panel.tsx')
    expect(/JSON\.stringify\(d,\s*null,\s*2\)/.test(tsx)).toBe(false)
  })

  it('imports react APIs from deps.ts and never from react directly', () => {
    const tsx = read('src/client/Panel.tsx')
    expect(tsx).toContain("from '../deps.ts'")
    expect(/from 'react'/.test(tsx)).toBe(false)
  })

  // Regression: the sheet is a frame-wide overlay mounted inside the small
  // `sidebar.footer.action` seat. With `position: fixed` but NO offset property
  // it stays at its static position (just above Settings) and grows downward
  // out of the viewport, so the panel body was clipped off-screen.
  it('anchors the sheet to the viewport so it cannot overflow off-screen', () => {
    const css = read('src/client/styles.ts')
    const sheet = /\.dsh-memory-sheet\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(sheet, '.dsh-memory-sheet rule must exist').not.toBe('')
    expect(sheet).toMatch(/position:\s*fixed/)
    // A fixed overlay is only anchored when at least one vertical and one
    // horizontal offset is declared.
    expect(sheet, 'sheet needs a vertical anchor').toMatch(/(top|bottom)\s*:/)
    expect(sheet, 'sheet needs a horizontal anchor').toMatch(/(left|right)\s*:/)
  })
})
