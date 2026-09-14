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

try {
  const npmVer = execFileSync('npm', ['view', PKG.name, 'version'], {
    cwd: ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 10000,
  }).trim()

  if (npmVer === LOCAL_VER) {
    ok(`npm published version (${npmVer}) matches local (${LOCAL_VER})`)
  } else {
    // Only error if local has a git tag — otherwise it's WIP
    const tag = run(['tag', '-l', `v${LOCAL_VER}`])
    if (tag) {
      error(`npm has ${npmVer} but local is tagged v${LOCAL_VER} — run 'npm publish'`)
    } else {
      ok(`Local v${LOCAL_VER} not yet tagged/published (WIP)`)
    }
  }
} catch {
  // npm view failed (no network, package not published yet)
}

// ── Summary ───────────────────────────────────────────────────────────

if (exitCode === 0) {
  console.log('\n✅ [sync] All in sync — local, remote, and npm are aligned.')
} else {
  console.error(`\n❌ [sync] ${exitCode} issue(s) found — run the suggested fixes.`)
}

process.exit(exitCode)