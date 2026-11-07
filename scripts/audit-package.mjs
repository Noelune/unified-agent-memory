import { execFileSync } from 'node:child_process'

const forbidden = /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|\/|$)|sessions?(?:\/|$)|(?:Hermes)?会话归档(?:\/|$)|.*\.sqlite(?:$|\.)|.*\.db(?:$|\.)|.*\.bak(?:$|[-.])|.*\.log(?:$|\.)|.*\.tmp(?:$|\.)|\.unified-memory(?:\/|$))/iu

/**
 * Vault-template ships the archive folder structure with README placeholder
 * docs only (e.g. 会话归档/README.md) so a freshly initialized vault has the
 * layout in place. Those are documentation, not archived session data, and
 * must not trip the forbidden-paths audit.
 */
function isTemplatePlaceholder(file) {
  return /^vault-template\//i.test(file) && /(^|\/)README\.md$/i.test(file)
}

const npmArgs = ['pack', '--dry-run', '--json']
// Prefer npm's JS CLI through our own process (no shell, no interpolation).
// Under `npm run` (and therefore CI) process.env.npm_execpath points at
// npm-cli.js; a bare `node scripts/audit-package.mjs` on Windows falls back
// to npm.cmd via the shell (args are constant literals — safe).
const npmCli = process.env.npm_execpath
const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
const args = npmCli ? [npmCli, ...npmArgs] : npmArgs
const raw = execFileSync(command, args, {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'],
  // Only the bare-Windows fallback needs the shell (.cmd cannot spawn directly).
  shell: process.platform === 'win32' && !npmCli,
})
const reports = (() => {
  // `npm pack --json` prints one JSON document, but `prepack` runs the build
  // first, and anything the build writes to stdout would be concatenated in
  // front of it. That failure mode is nasty — it surfaces as
  // "Unexpected token 'b', "[build] man"... is not valid JSON" and points at
  // this line rather than at the real culprit. Build progress now goes to
  // stderr, and this guards the remaining case: skip any leading non-JSON noise
  // and, if there is still no parseable document, say so plainly.
  const text = String(raw).trim()
  const start = text.search(/[[{]/)
  if (start === -1) {
    throw new Error(
      `npm pack --json produced no JSON document (${text.length} bytes of output). ` +
        `Output began with: ${JSON.stringify(text.slice(0, 120))}`,
    )
  }
  try {
    return JSON.parse(text.slice(start))
  } catch (err) {
    throw new Error(
      `could not parse npm pack --json output: ${err.message}. ` +
        `Output began with: ${JSON.stringify(text.slice(0, 120))}`,
    )
  }
})()
const files = reports.flatMap((report) => report.files ?? []).map((file) => file.path)
// The 0.9.1 failure mode was MISSING entries, not forbidden ones: the files
// whitelist shipped a stale tree and the tarball silently lost the whole
// layered core - this audit reported the broken artifact as ok. The gate
// therefore also asserts the artifacts every runtime path needs.
const REQUIRED = [
  'core/unified_memory/memory.py',
  'core/unified_memory/promoter.py',
  'core/unified_memory/forgetter.py',
  'core/unified_memory/catchup.py',
  'core/unified_memory/sessiondb.py',
  'core/unified_memory/__init__.py',
  'core/unified_memory/app/maintain/health.py',
  'core/unified_memory/app/ingest/digest.py',
  'core/unified_memory/app/retrieve/pipeline.py',
  'core/unified_memory/infra/store/schema.py',
  'core/unified_memory/infra/sessiondb.py',
  'core/unified_memory/surface/cli.py',
  'core/unified_memory/domain/conflict.py',
  'core/tests/test_common.py',
  'lib/index.js',
  'lib/types/index.d.ts',
  'dsh.plugin.json',
  'vault-template/50-Agent-Context/上下文索引.md',
  'integrations/hooks/memory_hook.py',
  'integrations/claude/CLAUDE.md',
  'setup/deploy.py',
  'setup/setup.py',
  'docs/JSON-CONTRACT.md',
]

const violations = files.filter((file) => !isTemplatePlaceholder(file) && forbidden.test(file))
if (violations.length > 0) {
  console.error(`forbidden npm package entries:`)
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}

const present = new Set(files)
const missing = REQUIRED.filter((entry) => !present.has(entry))
if (missing.length > 0) {
  console.error(`required npm package entries missing:`)
  for (const entry of missing) console.error(`  ${entry}`)
  process.exit(1)
}
console.log(`npm package audit ok: ${files.length} entries (${REQUIRED.length} required verified)`)
