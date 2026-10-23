import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/**
 * The shipped `files` list and `.npmignore` are two places that decide what a
 * user gets, and they disagree silently: `files` used to omit `core/tests`
 * while `.npmignore` also excluded it, so an installed package could not run
 * its own suite (`unittest discover` found nothing) even though the suite is
 * stdlib-only and ~700 KB. These assertions pin the intent, not the byte
 * counts: the tests ship, and nothing that is obviously not source does.
 */
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
const npmignore = readFileSync(resolve(ROOT, '.npmignore'), 'utf-8')
const effective = npmignore
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))

test('the shipped package carries the core test suite', () => {
  const shipped = pkg.files.includes('core/tests/*.py')
  const excluded = effective.some((rule) => rule.replace(/\/$/, '') === 'core/tests')
  assert.ok(shipped, 'package.json files must list core/tests/*.py')
  assert.ok(
    !excluded,
    '.npmignore must not exclude core/tests — that is what made an installed ' +
      'package unverifiable (`unittest discover -s core/tests` found nothing)',
  )
})

test('the shipped package still excludes things that are not source', () => {
  // A `files` allow-list already keeps these out; the assertion exists so that
  // adding `core/tests` cannot be done by loosening the list into something
  // that also drags in caches or secrets.
  for (const forbidden of ['src', 'scripts', 'test', 'node_modules']) {
    assert.ok(
      !pkg.files.includes(forbidden),
      `package.json files must not ship ${forbidden}`,
    )
  }
  assert.ok(
    !pkg.files.some((entry) => entry.includes('__pycache__') || entry.endsWith('.pyc')),
    'package.json files must not ship bytecode caches',
  )
})

test('every core/tests entry is a python module, not a fixture blob', () => {
  const declared = pkg.files.find((entry) => entry.startsWith('core/tests'))
  assert.equal(declared, 'core/tests/*.py',
    'core/tests must be shipped as a *.py glob so fixtures cannot leak in')
})
