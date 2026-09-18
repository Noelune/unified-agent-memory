#!/usr/bin/env node
/**
 * drift-python.mjs — run the Python core's drift check without a pip install.
 *
 * `python -m unified_memory.drift` only resolves when the core package is
 * installed into the active interpreter. This repo is routinely checked out
 * next to interpreters that have no `unified_memory` installed, and mutating a
 * shared interpreter (e.g. an agent's venv) just to run a check is not
 * acceptable. Put `core/` on PYTHONPATH for the child process instead, which is
 * exactly what the dsh plugin does at runtime when it shells out to the core.
 *
 * Usage: node scripts/drift-python.mjs [extra args passed through]
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path, { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CORE = resolve(ROOT, 'core')

if (!existsSync(resolve(CORE, 'unified_memory'))) {
  console.error(`❌ [drift] core/unified_memory not found under ${CORE}`)
  process.exit(1)
}

const python = process.env.UNIFIED_MEMORY_PYTHON || process.env.PYTHON || 'python'

const result = spawnSync(
  python,
  ['-m', 'unified_memory.drift', '--template', ...process.argv.slice(2)],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Prepend rather than replace: the core may import from site-packages.
      // path.delimiter is ';' on Windows and ':' elsewhere.
      PYTHONPATH: process.env.PYTHONPATH
        ? `${CORE}${path.delimiter}${process.env.PYTHONPATH}`
        : CORE,
    },
  },
)

if (result.error) {
  console.error(`❌ [drift] could not run "${python}": ${result.error.message}`)
  console.error('   Set UNIFIED_MEMORY_PYTHON to an interpreter that exists.')
  process.exit(1)
}

process.exit(result.status ?? 1)
