import { execFileSync } from 'node:child_process'

const forbidden = /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|\/|$)|sessions?(?:\/|$)|(?:Hermes)?会话归档(?:\/|$)|.*\.sqlite(?:$|\.)|.*\.db(?:$|\.)|.*\.bak(?:$|[-.])|.*\.log(?:$|\.)|.*\.tmp(?:$|\.)|\.unified-memory(?:\/|$))/iu
const npmArgs = ['pack', '--dry-run', '--json']
const npmExecPath = process.env.npm_execpath
const command = process.platform === 'win32' && npmExecPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
const args = process.platform === 'win32' && npmExecPath ? [npmExecPath, ...npmArgs] : npmArgs
const raw = execFileSync(command, args, {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'],
})
const reports = JSON.parse(raw)
const files = reports.flatMap((report) => report.files ?? []).map((file) => file.path)
const violations = files.filter((file) => forbidden.test(file))
if (violations.length > 0) {
  console.error(`forbidden npm package entries:\n${violations.join('\n')}`)
  process.exit(1)
}
console.log(`npm package audit ok: ${files.length} entries`)
