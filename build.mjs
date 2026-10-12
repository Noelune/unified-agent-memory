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

// ── Manifest generation: dsh.plugin.json is DERIVED, never hand-edited ──
//
// package.json is the single source of truth. dsh.plugin.json used to be a
// hand-maintained twin of it, which is exactly how it drifted: its
// `compatibility.dshReleases` and `entry.inject` had gone stale against the
// real host contract, and nothing noticed because no gate compared them.
//
// On DSH 0.2.0 nothing reads this file at all — the host validates
// `peerDependencies` instead. It is still generated so that older harness
// builds and third-party marketplace readers that do look for it receive
// values that agree with package.json.
{
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
  const manifestPath = 'dsh.plugin.json'

  // `entry.inject` must match `export const inject` in src/index.ts. Read it
  // from the source rather than restating it here, so the two cannot diverge.
  const hostSource = readFileSync('src/index.ts', 'utf-8')
  const injectMatch = hostSource.match(
    /export const inject[^=]*=\s*\[([^\]]*)\]/,
  )
  if (!injectMatch) {
    throw new Error(
      'src/index.ts no longer declares `export const inject = [...]`; ' +
      'the dsh.plugin.json entry.inject derivation needs updating.',
    )
  }
  const hostInject = injectMatch[1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)

  const clientSource = readFileSync('src/client/index.ts', 'utf-8')
  const clientInjectMatch = clientSource.match(
    /export const inject[^=]*=\s*\[([^\]]*)\]/,
  )
  const clientInject = clientInjectMatch
    ? clientInjectMatch[1]
        .split(',')
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    : []

  const manifest = {
    name: pkg.name,
    description: pkg.description.split(' · ')[0].trim(),
    version: pkg.version,
    compatibility: pkg.dsh.compatibility,
    entry: {
      name: pkg.name,
      inject: hostInject,
    },
    client: {
      platform: pkg.dsh.client.platform,
      inject: clientInject,
    },
  }

  const serialised = JSON.stringify(manifest, null, 2) + '\n'
  let previous = null
  try {
    previous = readFileSync(manifestPath, 'utf-8')
  } catch {
    // First generation — nothing to compare against.
  }
  if (previous !== serialised) {
    atomicWrite(manifestPath, serialised)
    note(`[build] dsh.plugin.json regenerated from package.json (v${pkg.version})`)
  }
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

// ── Progress logging ───────────────────────────────────────────────
//
// Progress goes to stderr, not stdout. `npm pack --json` is consumed by
// scripts/audit-package.mjs, which parses this process's stdout as JSON — and
// since the build also runs automatically via the `prepack` script, anything
// this file prints to stdout lands in front of that JSON and breaks the parse.
// Warnings and the failure summary stay on stdout below, where a human (or CI)
// reads them and where a failure must be visible.

/** Progress note for humans; never part of a machine-readable contract. */
function note(message) {
  process.stderr.write(`${message}\n`)
}

// ── Execute builds ─────────────────────────────────────────────────

note('[build] Building host entry…')
await emit(hostConfig)

note('[build] Building utils…')
await emit(utilsConfig)

note('[build] Building client UI…')
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
  note('[build] Generating type declarations…')
  try {
    // tsc output is CAPTURED and forwarded to stderr rather than inherited.
    // With `stdio: 'inherit'`, a type error goes to this process's stdout — and
    // since the build also runs via `prepack`, that lands in front of the JSON
    // `npm pack --json` prints, breaking scripts/audit-package.mjs with a
    // confusing parse error instead of the real type error.
    execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    declarations = existsSync(resolve('lib/types/index.d.ts'))
    if (!declarations) {
      console.warn('[build] tsc ran but lib/types/index.d.ts is missing — declarations NOT emitted.')
    }
  } catch (err) {
    const stdout = String(err.stdout ?? '').trim()
    const stderr = String(err.stderr ?? '').trim()
    if (stdout) process.stderr.write(stdout + '\n')
    if (stderr) process.stderr.write(stderr + '\n')
    console.warn(`[build] tsc declaration emit failed: ${err.message}`)
  }
}

// ── Summary ────────────────────────────────────────────────────────

if (declarations) {
  note('[build] Done — bundles and type declarations are up to date.')
} else {
  note('[build] Done — bundles only. TYPE DECLARATIONS SKIPPED.')
  note('[build]   Install devDependencies (`npm install`) to emit lib/types/**.')
  if (STRICT) {
    process.stderr.write('[build] Failing under --strict/CI: a published package must carry declarations.\n')
    process.exit(1)
  }
}
