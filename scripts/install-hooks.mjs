#!/usr/bin/env node
/**
 * install-hooks.mjs — Install git hooks for drift prevention.
 *
 * Copies scripts from .githooks/ to .git/hooks/ and makes them executable.
 * This ensures every checkout has drift prevention enabled.
 *
 * Run: node scripts/install-hooks.mjs
 * Or:  npm run setup-hooks
 */
import { copyFileSync, chmodSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const HOOK_SRC = resolve(ROOT, '.githooks')
const HOOK_DST = resolve(ROOT, '.git', 'hooks')

if (!existsSync(HOOK_SRC)) {
  console.error(`❌ Hook source directory not found: ${HOOK_SRC}`)
  process.exit(1)
}

if (!existsSync(HOOK_DST)) {
  console.error(`❌ Git hooks directory not found: ${HOOK_DST}`)
  console.error('   Are you in a git repository? (run from repo root)')
  process.exit(1)
}

let installed = 0
for (const hook of readdirSync(HOOK_SRC)) {
  const src = resolve(HOOK_SRC, hook)
  const dst = resolve(HOOK_DST, hook)
  try {
    copyFileSync(src, dst)
    chmodSync(dst, 0o755)
    console.log(`✅ Installed hook: ${hook}`)
    installed++
  } catch (err) {
    console.error(`❌ Failed to install hook ${hook}: ${err.message}`)
  }
}

console.log(`\n📋 ${installed} hook(s) installed.`)
console.log('   Drift prevention is now active on git commit.')
console.log('   To change strictness: git config hooks.drift-mode strict|normal|off')