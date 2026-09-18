#!/usr/bin/env node
/**
 * sync-check.mjs — verify local/remote/npm version consistency.
 *
 * Checks that:
 *   1. Working tree is clean (no uncommitted changes)
 *   2. No unpushed commits (local = origin/main)
 *   3. npm published version matches local package.json version
 *      (only when local version is tagged)
 *
 * Exit code: 0 = all in sync, 1 = drift detected
 *
 * Usage: node scripts/sync-check.mjs
 *        npm run sync:check
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
const LOCAL_VER = PKG.version

let exitCode = 0

function error(msg) {
  console.error(`❌ [sync] ${msg}`)
  exitCode = 1
}

function ok(msg) {
  console.log(`✅ [sync] ${msg}`)
}

function run(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }).trim()
  } catch {
    return null
  }
}

// ── 1. Check working tree is clean ────────────────────────────────────

const status = run(['status', '--porcelain'])
if (status) {
  error(`Working tree has uncommitted changes:\n${status}`)
} else {
  ok('Working tree is clean')
}

// ── 2. Check no unpushed commits ──────────────────────────────────────

const unpushed = run(['log', '--oneline', 'origin/main..main', '--'])
if (unpushed) {
  error(`Unpushed commits found:\n${unpushed}`)
} else {
  ok('All commits pushed to origin/main')
}

// ── 3. Check npm published version matches local ──────────────────────

// This used to shell out to `npm view`, and it never ran: `npm` is npm.cmd,
// execFileSync cannot spawn it by bare name, and Node 20+ rejects a .cmd
// without a shell. Every failure landed in an empty catch, so the check
// reported success while doing nothing. Querying the registry over HTTPS keeps
// this deterministic — no child process, no PATH assumptions — and the package
// is public, so no credentials are involved.

const registry = (PKG.publishConfig && PKG.publishConfig.registry) || 'https://registry.npmjs.org/'
// A scoped name keeps its leading '@'; everything else is percent-encoded so a
// malformed name can never escape into a different registry path.
const encodedName = PKG.name
  .split('/')
  .map((part) => (part.startsWith('@') ? `@${encodeURIComponent(part.slice(1))}` : encodeURIComponent(part)))
  .join('/')
const lookup = new URL(encodedName, registry.endsWith('/') ? registry : `${registry}/`)

try {
  // An AbortSignal.timeout() timer stays armed after the response and keeps a
  // libuv handle alive past process.exit(), which aborts Node on Windows. Own
  // the controller so the timer is always cleared.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  let res
  try {
    res = await fetch(lookup.href, { signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`)

  const doc = await res.json()
  const npmVer = (doc['dist-tags'] && doc['dist-tags'].latest) || doc.version || ''

  if (npmVer === LOCAL_VER) {
    ok(`npm published version (${npmVer}) matches local (${LOCAL_VER})`)
  } else {
    // Only error if local has a git tag — otherwise it's WIP
    const tag = run(['tag', '-l', `v${LOCAL_VER}`])
    if (tag) {
      error(`npm has ${npmVer || '(none)'} but local is tagged v${LOCAL_VER} — run 'npm publish'`)
    } else {
      ok(`Local v${LOCAL_VER} not yet tagged/published (WIP)`)
    }
  }
} catch (err) {
  // An unreachable registry is not "in sync"; say so instead of passing.
  error(`could not read published version from ${lookup.origin} (${String(err.message).split('\n')[0].slice(0, 60)})`)
}

// ── Summary ───────────────────────────────────────────────────────────

if (exitCode === 0) {
  console.log('\n✅ [sync] All in sync — local, remote, and npm are aligned.')
} else {
  console.error(`\n❌ [sync] ${exitCode} issue(s) found — run the suggested fixes.`)
}

// The registry lookup above is awaited at module scope, so calling
// process.exit() here tears down libuv handles that are still closing and
// aborts the process on Windows. Set the code and let the loop drain instead.
process.exitCode = exitCode