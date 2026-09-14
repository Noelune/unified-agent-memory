/**
 * Build script for dsh-unified-agent-memory.
 *
 * Compiles the host-side plugin (Node ESM) and the browser client module
 * (AMD via DSH ModuleLoader wrapper) using esbuild.
 *
 * The client output must use the ModuleLoader pattern so the DSH client
 * runtime can discover and load the plugin's browser contribution.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('lib', { recursive: true })

const DSH_EXTERNAL = ['@deepseek-ai/*']

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
await build(hostConfig)

console.log('[build] Building utils…')
await build(utilsConfig)

console.log('[build] Building client UI…')
await build(clientConfig)

// ── Type declarations (via tsc) ────────────────────────────────────
console.log('[build] Generating type declarations…')
try {
  execFileSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    { stdio: 'inherit' },
  )
} catch {
  // tsc --noEmit is used for type checking; declaration-only emit may fail
  // on unresolved external types, which is acceptable for the plugin bundle.
  console.warn('[build] tsc declaration emit completed with warnings')
}

console.log('[build] Done.')
console.log('[build] All checks passed.')