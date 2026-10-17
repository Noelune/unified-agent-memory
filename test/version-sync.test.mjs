import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

test('package.json and dsh.plugin.json versions are identical', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'dsh.plugin.json'), 'utf-8'))
  assert.equal(manifest.version, pkg.version,
    'dsh.plugin.json.version must equal package.json.version (build backfills it)')
})

test('compatibility declarations name the DSH version this build pins', () => {
  // The host validates `@deepseek-ai/dsh*` peer ranges before importing a
  // bundle, so a stale declared support matrix is how a working plugin starts
  // being skipped wholesale after a DSH bump. The devDependency pin is the
  // version the suite actually runs against — it must be declared compatible.
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'dsh.plugin.json'), 'utf-8'))
  const pinned = pkg.devDependencies['@deepseek-ai/dsh-tools']
  for (const [label, declared] of [
    ['package.json dsh.compatibility', pkg.dsh.compatibility],
    ['dsh.plugin.json compatibility', manifest.compatibility],
  ]) {
    assert.equal(declared.dshReleases[pinned], 'compatible',
      `${label} must list ${pinned} as "compatible" (devDependencies pin)`)
  }
})

test('dsh.plugin.json description is non-empty and aligned with package description', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'dsh.plugin.json'), 'utf-8'))
  assert.ok(manifest.description && manifest.description.length > 0,
    'dsh.plugin.json.description must be non-empty')
  assert.ok(pkg.description.includes(manifest.description.split(' — ')[0].trim()) ||
            manifest.description.includes(pkg.description.split(' — ')[0].trim()),
    'manifest description should share the lead phrase with package.json')
})