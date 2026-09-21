#!/usr/bin/env node
/**
 * drift-check.mjs — JS-side drift detection for the build pipeline.
 *
 * Verifies that the plugin's code-level definitions (tools, config, exports)
 * match what's expected by the drift configuration and vault template.
 *
 * This is the JS counterpart of `python -m unified_memory.drift`.
 * It's lighter and captures JS-specific drifts like:
 *   - Missing tool exports
 *   - Config key mismatches
 *   - Module export consistency
 *
 * Called by: npm run drift:check (part of npm run check)
 *
 * Exit code: 0 = no errors, 1 = drift detected
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let exitCode = 0

// ── Helpers ─────────────────────────────────────────────────────────

function error(msg) {
  console.error(`❌ [drift] ${msg}`)
  exitCode = 1
}

function warn(msg) {
  console.warn(`⚠️  [drift] ${msg}`)
}

function ok(msg) {
  console.log(`✅ [drift] ${msg}`)
}

// ── 1. Check driftrc.yaml exists ────────────────────────────────────

const driftrcPath = resolve(ROOT, 'driftrc.yaml')
if (!existsSync(driftrcPath)) {
  error('driftrc.yaml not found — run from repo root')
  process.exit(1)
}
ok('driftrc.yaml found')

// ── 2. Check tool exports match src/tools.ts ────────────────────────

const toolsPath = resolve(ROOT, 'src/tools.ts')
if (!existsSync(toolsPath)) {
  error('src/tools.ts not found — is this a dev checkout?')
} else {
  const toolsContent = readFileSync(toolsPath, 'utf-8')

  // Expected tool names
  const expectedTools = ['memory_search', 'memory_show', 'memory_submit', 'memory_status']
  for (const tool of expectedTools) {
    if (toolsContent.includes(`name: '${tool}'`) || toolsContent.includes(`name: "${tool}"`)) {
      ok(`Tool '${tool}' found in src/tools.ts`)
    } else if (toolsContent.includes(tool)) {
      warn(`Tool '${tool}' mentioned in src/tools.ts but pattern may have changed`)
    } else {
      error(`Tool '${tool}' NOT found in src/tools.ts — was it removed?`)
    }
  }
}

// ── 3. Check config keys match src/utils.ts ─────────────────────────

const utilsPath = resolve(ROOT, 'src/utils.ts')
if (existsSync(utilsPath)) {
  const utilsContent = readFileSync(utilsPath, 'utf-8')

  const expectedKeys = ['vaultPath', 'pythonPath', 'corePath', 'remoteEnabled']
  for (const key of expectedKeys) {
    if (utilsContent.includes(key)) {
      ok(`Config key '${key}' found in src/utils.ts`)
    } else {
      error(`Config key '${key}' NOT found in src/utils.ts`)
    }
  }

  const expectedEnvs = ['UNIFIED_MEMORY_VAULT', 'UNIFIED_MEMORY_PYTHON', 'UNIFIED_MEMORY_COREPATH']
  for (const env of expectedEnvs) {
    if (utilsContent.includes(env)) {
      ok(`Env var '${env}' found in src/utils.ts`)
    } else {
      warn(`Env var '${env}' not found in src/utils.ts — may have been renamed`)
    }
  }
}

// ── 4. Check vault-template consistency ─────────────────────────────

const templateDir = resolve(ROOT, 'vault-template', '50-Agent-Context')
const expectedTemplateDocs = [
  '上下文索引.md',
  '我的偏好摘要.md',
  '常用路径与环境.md',
  '工程执行规则.md',
  '工具可用性检查.md',
  'UI审美准则.md',
  'Codex-Claude-Hermes协作规则.md',
  'README.md',
]

if (existsSync(templateDir)) {
  for (const doc of expectedTemplateDocs) {
    const docPath = resolve(templateDir, doc)
    if (existsSync(docPath)) {
      ok(`Template doc '${doc}' exists`)
    } else {
      error(`Template doc '${doc}' MISSING from vault-template/`)
    }
  }

  // Check for orphaned template files
  const { readdirSync } = await import('node:fs')
  for (const entry of readdirSync(templateDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md') && !expectedTemplateDocs.includes(entry.name)) {
      warn(`Orphaned template doc '${entry.name}' — not in expected list, may need driftrc.yaml update`)
    }
  }
} else {
  error(`vault-template/50-Agent-Context/ not found at ${templateDir}`)
}

// ── 5. Check dsh.plugin.json ────────────────────────────────────────

const pluginManifest = resolve(ROOT, 'dsh.plugin.json')
if (existsSync(pluginManifest)) {
  const manifest = JSON.parse(readFileSync(pluginManifest, 'utf-8'))
  if (manifest.name === 'dsh-unified-agent-memory') {
    ok('dsh.plugin.json name matches')
  } else {
    error(`dsh.plugin.json name mismatch: "${manifest.name}"`)
  }

  // Version single-source-of-truth: package.json is the source, the build
  // backfills dsh.plugin.json. A mismatch here is a release-blocking drift.
  const pkgPath = resolve(ROOT, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    if (manifest.version === pkg.version) {
      ok(`dsh.plugin.json version (${manifest.version}) matches package.json`)
    } else {
      error(`dsh.plugin.json version ${manifest.version} != package.json ${pkg.version} — run build (backfills) or fix manually`)
    }
  }
}

// ── Summary ─────────────────────────────────────────────────────────

if (exitCode === 0) {
  console.log('\n✅ [drift] All JS-side drift checks passed — code and template are in sync.')
} else {
  console.error(`\n❌ [drift] ${exitCode} drift error(s) found — update docs or fix code.`)
}

process.exit(exitCode)