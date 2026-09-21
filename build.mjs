/**
 * Build script for dsh-unified-agent-memory.
 *
 * Compiles the host-side plugin (Node ESM) and the browser client module
 * (AMD via DSH ModuleLoader wrapper) using esbuild.
 *
 * The client output must use the ModuleLoader pattern so the DSH client
 * runtime can discover and load the plugin's browser contribution.
 *
 * Two rules this script exists to honour:
 *
 *   1. Outputs are written atomically (temp file + rename). This package is
 *      commonly installed with `link:` into a running DSH profile whose patch
 *      reload re-imports `lib/index.js` the moment it changes. A partial write
 *      exposes a module with no exports, and the loader reports
 *      `invalid plugin, expect function or object with an "apply" method`.
 *   2. The build never claims success it did not earn. Type declarations are
 *      optional, but skipping them is reported as a skip — not as
 *      "All checks passed".
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const REQUIRE = createRequire(import.meta.url)

/** `--strict` (or CI) turns a declaration skip into a build failure. */
const STRICT = process.argv.includes('--strict') || process.env.CI === 'true'

mkdirSync('lib', { recursive: true })

// ── Manifest backfill: keep dsh.plugin.json version/description in sync ──
// package.json is the single source of truth; the plugin manifest is derived.
{
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
  const manifestPath = 'dsh.plugin.json'
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  manifest.version = pkg.version
  if (!manifest.description && pkg.description) {
    manifest.description = pkg.description.split(' · ')[0].trim()
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  console.log(`[build] manifest version backfilled to ${manifest.version}`)
}

const DSH_EXTERNAL = ['@deepseek-ai/*']

/**
 * Write bytes so readers never observe a half-written file.
 *
 * Retries once on Windows sharing violations (a running DSH may still hold the
 * previous entry point open), then fails loudly rather than falling back to an
 * in-place rewrite that a concurrent import could observe mid-flight.
 */
function atomicWrite(target, text) {
  const abs = resolve(target)
  const tmp = `${abs}.tmp`
  writeFileSync(tmp, text)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      renameSync(tmp, abs)
      return
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'EACCES') break
      // Let the holder finish its read, then retry the rename.
      const until = Date.now() + 500
      while (Date.now() < until) { /* brief spin */ }
    }
  }
  rmSync(tmp, { force: true })
  throw new Error(
    `cannot publish ${abs} atomically — a running DSH is holding it open. ` +
    `Stop the harness (or the profile's live reload), rebuild, then restart.`,
  )
}

/** Run one esbuild config and flush every emitted file atomically. */
async function emit(config) {
  const result = await build({ ...config, write: false })
  for (const file of result.outputFiles ?? []) atomicWrite(file.path, file.text)
}

// ── Host entry (Node ESM) ───────────────────────────────────────────

const hostConfig = {
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: DSH_EXTERNAL,
  logLevel: 'info',
}

// ── Tools entry (Node ESM, separate for clean resolution) ──────────

const utilsConfig = {
  entryPoints: ['src/utils.ts'],
  outfile: 'lib/utils.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: DSH_EXTERNAL,
  logLevel: 'info',
}

// ── Client entry (Browser AMD via ModuleLoader) ────────────────────

const clientConfig = {
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client-ui.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  jsx: 'automatic',
  external: [
    ...DSH_EXTERNAL,
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'scheduler',
  ],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-unified-agent-memory', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
}

// ── Execute builds ─────────────────────────────────────────────────

console.log('[build] Building host entry…')
await emit(hostConfig)

console.log('[build] Building utils…')
await emit(utilsConfig)

console.log('[build] Building client UI…')
await emit(clientConfig)

// ── Guard: the client bundle must expose a Cordis plugin shape ─────
//
// The DSH client runtime registers this module with registry.plugin(), which
// rejects anything that is not a function or an object carrying `apply`.
// A side-effect-only client entry builds fine and fails at load time with a
// message that points at the harness rather than at this file, so assert it
// here instead.

const clientSource = readFileSync('lib/client-ui.js', 'utf8')
if (!/\bapply\s*\(/.test(clientSource) || !/apply:\s*\(\)\s*=>\s*apply/.test(clientSource)) {
  throw new Error(
    'lib/client-ui.js does not export `apply`. A DSH client module must be a ' +
    'Cordis plugin ({ name, inject, apply }); exporting side effects alone ' +
    'makes the harness fail the entry with "invalid plugin … received object".',
  )
}

// ── Type declarations (via tsc) ────────────────────────────────────

let declarations = false
let tscBin = null
try {
  tscBin = REQUIRE.resolve('typescript/bin/tsc')
} catch {
  console.warn('[build] typescript is not installed — skipping .d.ts emit.')
}

if (tscBin) {
  console.log('[build] Generating type declarations…')
  try {
    execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], { stdio: 'inherit' })
    declarations = existsSync(resolve('lib/types/index.d.ts'))
    if (!declarations) {
      console.warn('[build] tsc ran but lib/types/index.d.ts is missing — declarations NOT emitted.')
    }
  } catch (err) {
    console.warn(`[build] tsc declaration emit failed: ${err.message}`)
  }
}

// ── Summary ────────────────────────────────────────────────────────

if (declarations) {
  console.log('[build] Done — bundles and type declarations are up to date.')
} else {
  console.log('[build] Done — bundles only. TYPE DECLARATIONS SKIPPED.')
  console.log('[build]   Install devDependencies (`npm install`) to emit lib/types/**.')
  if (STRICT) {
    console.error('[build] Failing under --strict/CI: a published package must carry declarations.')
    process.exit(1)
  }
}
