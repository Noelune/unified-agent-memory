/**
 * route-doctor — the findings behind the health pane's verdict.
 *
 * The pane could say "2 项需要处理" and nothing else, which is a diagnosis with
 * no treatment: the user is told something is wrong and left to guess which
 * command fixes it. The core has always known — `doctor --json` emits
 * `{severity, code, message, hint}` per issue — the panel simply never asked.
 * This route asks.
 *
 * Read-only by construction: `doctor` measures a vault and writes nothing.
 *
 * @module src/route-doctor
 */

import { runCore } from './utils.ts'
import type { PluginConfig } from './types.ts'

export const DOCTOR_PATH = '/api/dsh-unified-agent-memory/doctor'

export type DoctorSeverity = 'error' | 'warn' | 'info'

/** One finding, normalized for the pane. */
export interface DoctorIssue {
  severity: DoctorSeverity
  /** The core's stable identifier (`conflicts-pending`, `index-bloat`, …). */
  code: string
  /** The core's own sentence — English, and only ever a fallback on screen. */
  message: string
  /** The core's own remedy — same caveat. `view.ts` owns the localized copy. */
  hint: string
}

/**
 * Counts the pane can quote without a second read.
 *
 * Absent queues are 0 rather than null: this payload only exists when the core
 * answered, and "the inbox is empty" is then a fact, not a missing reading.
 */
export interface DoctorCounts {
  memories: number
  vectors: number
  conflicts: number
  inbox: number
  duplicates: number
  orphans: number
}

export interface DoctorPayload {
  ok: boolean
  status: 'ok' | 'unavailable'
  issues: DoctorIssue[]
  counts: DoctorCounts | null
}

export function buildDoctorArgs(): string[] {
  return ['doctor', '--json']
}

function unavailable(): DoctorPayload {
  return { ok: false, status: 'unavailable', issues: [], counts: null }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}

/**
 * A severity the core did not spell out is `warn`, never `info`.
 *
 * An unrecognized severity means a newer core said something this build does
 * not understand. Filing that under "informational" would let a real problem
 * fall out of the count, and the count is the pane's whole claim.
 */
function severityOf(v: unknown): DoctorSeverity {
  return v === 'error' || v === 'info' ? v : 'warn'
}

function shapeIssue(raw: unknown): DoctorIssue | null {
  const o = obj(raw)
  if (!o) return null
  const message = str(o.message)
  const code = str(o.code)
  // With neither a sentence nor a code there is nothing to render and nothing
  // to key on; one of the two is the minimum.
  if (!message && !code) return null
  return { severity: severityOf(o.severity), code, message, hint: str(o.hint) }
}

/**
 * Unwrap a `doctor --json` envelope: `{ok:true, command:"doctor", data:{…}}`.
 *
 * `data.ok:false` is NOT "unavailable". That is the core reporting a broken
 * vault (`vault-missing`, `doctor-failed`) with an issue attached, and those
 * are the findings the user needs most. Only a body that fails to parse, or
 * arrives without a `data` object, is unavailable — because "the doctor found
 * nothing" and "the doctor never ran" must not look alike when the pane prints
 * one of them as reassurance.
 */
export function shapeDoctorResult(raw: string): DoctorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return unavailable()
  }
  const data = obj(obj(parsed)?.data)
  if (!data) return unavailable()

  const issues: DoctorIssue[] = []
  if (Array.isArray(data.issues)) {
    for (const item of data.issues) {
      const issue = shapeIssue(item)
      if (issue) issues.push(issue)
    }
  }

  const index = obj(data.index) ?? {}
  const canonical = obj(data.canonical) ?? {}
  const inbox = obj(data.inbox) ?? {}
  // `duplicateLines` is a list of offending lines; its LENGTH is the count. The
  // list itself is deliberately not forwarded — it carries vault text, and the
  // pane has no business rendering corpus content it did not ask for.
  const duplicates = Array.isArray(canonical.duplicateLines) ? canonical.duplicateLines.length : 0

  return {
    ok: true,
    status: 'ok',
    issues,
    counts: {
      memories: num(index.memories),
      vectors: num(index.vectors),
      conflicts: num(obj(data.conflicts)?.count),
      inbox: num(inbox.count),
      duplicates,
      orphans: num(obj(data.orphanIndexes)?.count),
    },
  }
}

/**
 * Read the doctor report.
 *
 * `keepOutputOnFailure` is the load-bearing detail. A finding of severity
 * `error` makes the core exit **1** *after* printing the report, and without
 * that flag `runCore` hands back an empty string — so the one case that most
 * needs explaining would look like a dead core. A transport failure (python
 * missing, timeout, crash) produces no JSON at all and correctly lands on
 * `unavailable`.
 */
export async function handleDoctor(cfg: PluginConfig): Promise<DoctorPayload> {
  try {
    const r = await runCore(cfg, buildDoctorArgs(), { keepOutputOnFailure: true })
    if (!r.output) return unavailable()
    return shapeDoctorResult(r.output)
  } catch {
    return unavailable()
  }
}
