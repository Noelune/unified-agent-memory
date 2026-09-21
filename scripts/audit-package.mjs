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
const reports = JSON.parse(raw)
const files = reports.flatMap((report) => report.files ?? []).map((file) => file.path)
const violations = files.filter((file) => !isTemplatePlaceholder(file) && forbidden.test(file))
if (violations.length > 0) {
  console.error(`forbidden npm package entries:\n${violations.join('\n')}`)
  process.exit(1)
}
console.log(`npm package audit ok: ${files.length} entries`)
