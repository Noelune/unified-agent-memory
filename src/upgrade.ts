/**
 * upgrade — reconcile an installed layout with the one this build expects.
 *
 * A plugin upgrade is not one event, it is four, and they fail independently:
 * npm replaces `lib/` and `core/`; the **vault** on disk keeps whatever the old
 * build left there; the **managed sections** in `~/.dsh/AGENTS.md` and friends
 * still carry the old rules; and `~/.unified-memory/` keeps a shim whose
 * absolute `PYTHONPATH` points at a path that may no longer exist. A user who
 * runs `dsh plugin update` gets a new bundle and none of the other three.
 *
 * The failure modes that matter, in order of how much they hurt:
 *
 *  1. **The shim points at a deleted core.** It hardcodes the absolute path of
 *     the package directory it was generated in. An upgrade that moves or
 *     removes that directory leaves every non-DSH agent calling a dead binary,
 *     and the error is `No module named unified_memory` — which reads like a
 *     broken install, not like a stale shim.
 *  2. **The managed section is stale.** Rules change between versions (this
 *     one added the prefix-provenance rule). Nothing rewrites them, so an
 *     agent keeps following last version's instructions while the tools
 *     enforce this version's behaviour.
 *  3. **The derived index is from an older schema.** The core already handles
 *     this — `_migrate_schema` wipes and rebuilds on a version bump — but the
 *     wipe is silent and only happens when something else opens the database.
 *  4. **The vault is missing template files added since.** A new canonical
 *     note ships; existing vaults never get it, and search starts returning
 *     "unknown document" for a doc the release notes say exists.
 *
 * This module only *plans*. Every side effect happens in `upgrade-run.ts`, so
 * the decision logic is testable without a filesystem, and the plan can be
 * shown to the user before anything is written — the same shape `memory_setup`
 * uses, for the same reason: an upgrade touches files the user owns.
 *
 * Nothing here deletes. Vault files are added, never removed or rewritten;
 * instruction sections are replaced inside their markers, with a backup; a
 * broken shim is regenerated. The index is the one thing that gets rebuilt,
 * and it is derived data by definition.
 *
 * @module src/upgrade
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ── What the installed layout looks like ────────────────────────────

/** One artifact whose content this build owns. */
export interface OwnedArtifact {
  /** Stable id, used in the plan and in the recorded state. */
  key: 'shim' | 'instructions' | 'vault' | 'index' | 'registry'
  /** What it is, in one line the user can act on. */
  label: string
  /**
   * `drift` means the on-disk copy no longer matches what this build would
   * write. `missing` means it was never written (or was deleted).
   */
  state: 'ok' | 'drift' | 'missing'
  /** One sentence on what will change, or why it is fine. */
  detail: string
}

/** What an upgrade would do. */
export interface UpgradePlan {
  /** Version recorded by the last completed upgrade, or null on first run. */
  fromVersion: string | null
  /** Version of the running build. */
  toVersion: string
  /** True when nothing needs doing. The UI still shows the version. */
  clean: boolean
  artifacts: OwnedArtifact[]
  /**
   * Whether the build's install layout moved since the last run — the one
   * condition that makes a stale shim likely rather than theoretical.
   */
  installMoved: boolean
}

/** What the upgrade records after a run, so the next one can compare. */
export type UpgradeState = {
  version: string
  /** Absolute path of `core/` at the time of the run. */
  corePath: string
  /** Absolute path of the package root. */
  installPath: string
  /** ISO timestamp. */
  appliedAt: string
  /** Artifact keys that were actually rewritten. */
  changed: string[]
}

// ── Reading the installed state ─────────────────────────────────────

/** Where the upgrade record lives. Sibling of `onboarding.json`, same reason. */
export function upgradeStatePath(home: string): string {
  return join(home, '.unified-memory', 'upgrade.json')
}

/**
 * The recorded state, or null.
 *
 * Anything unreadable means "treat this as a first run": the worst outcome of
 * a wrong read is one extra, harmless reconcile pass — the same pass a fresh
 * install runs. Refusing to start because a JSON file is truncated would be
 * far worse than doing the work twice.
 */
export function readUpgradeState(file: string): UpgradeState | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpgradeState>
    if (typeof raw.version !== 'string' || !raw.version) return null
    if (typeof raw.corePath !== 'string' || !raw.corePath) return null
    return {
      version: raw.version,
      corePath: raw.corePath,
      installPath: typeof raw.installPath === 'string' ? raw.installPath : '',
      appliedAt: typeof raw.appliedAt === 'string' ? raw.appliedAt : '',
      changed: Array.isArray(raw.changed) ? raw.changed.filter((v) => typeof v === 'string') : [],
    }
  } catch {
    return null
  }
}

// ── Inspecting artifacts ────────────────────────────────────────────

/** Everything the planner needs from the outside world. */
export interface UpgradeProbe {
  home: string
  /** Absolute path of this build's `core/`. */
  corePath: string
  /** Absolute path of the package root (parent of `lib/` and `core/`). */
  installPath: string
  /** The vault, or null when unconfigured. */
  vaultPath: string | null
  /** Directory holding this build's vault template. */
  templateDir: string
  /** Instruction files the host actually has; mirrors `detectTargets()`. */
  instructionFiles: readonly string[]
  /** Version of the running build. */
  version: string
  /** Version recorded by the last run, or null. */
  previous: UpgradeState | null
}

/**
 * Whether a generated shim still points at a core that exists.
 *
 * The shim is a two-line script whose whole job is to set `PYTHONPATH` and
 * exec python. Rather than re-derive the expected content (which differs per
 * platform and per python path the user configured), this reads the
 * `PYTHONPATH=` line back out and checks the directory. A shim that sets a
 * path which no longer exists is the exact failure this is looking for, and it
 * is visible without running anything.
 */
export function shimTarget(shimPath: string): string | null {
  try {
    const text = readFileSync(shimPath, 'utf8')
    // Three dialects, one line each, and the quotes are in different places:
    //
    //   cmd : set "PYTHONPATH=C:\path with spaces\core"   ← assignment is quoted
    //   sh  : PYTHONPATH='/path/core' exec python         ← value is quoted
    //
    // The first alternative has to come first and has to run to the closing
    // quote: matching only a quoted *value* after `=` reads the cmd form as
    // `C:\path` (truncated at the space) or, more often, as nothing at all —
    // which would report every Windows shim as unrecognisable on every boot.
    const match = /"PYTHONPATH=([^"]*)"|PYTHONPATH='([^']*)'|PYTHONPATH="([^"]*)"/.exec(text)
    if (!match) return null
    return match[1] ?? match[2] ?? match[3] ?? null
  } catch {
    return null
  }
}

/** Vault template files that the vault on disk does not have. */
export function missingTemplateFiles(templateDir: string, vaultPath: string): string[] {
  const missing: string[] = []
  const walk = function (relative: string): void {
    let entries: string[]
    try {
      entries = readdirSync(join(templateDir, relative))
    } catch {
      return
    }
    for (const name of entries) {
      if (name === '.gitkeep') continue
      const rel = relative ? join(relative, name) : name
      let stat
      try {
        stat = statSync(join(templateDir, rel))
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(rel)
        continue
      }
      if (!existsSync(join(vaultPath, rel))) missing.push(rel)
    }
  }
  walk('')
  return missing.sort()
}

/**
 * Build the plan.
 *
 * Pure with respect to its probe: every filesystem read is a question, no
 * answer is cached, and nothing is written. The caller decides whether to act.
 */
export function planUpgrade(probe: UpgradeProbe): UpgradePlan {
  const artifacts: OwnedArtifact[] = []

  // 1. CLI shim — the artifact most likely to be silently broken.
  const shimName = process.platform === 'win32' ? 'memory.cmd' : 'memory'
  const shimPath = join(probe.home, '.unified-memory', 'bin', shimName)
  if (!existsSync(shimPath)) {
    artifacts.push({
      key: 'shim',
      label: 'CLI shim `~/.unified-memory/bin/memory`',
      state: 'missing',
      detail: '不存在，其它 Agent 无法通过 `memory` 命令接入；将重新生成。',
    })
  } else {
    const target = shimTarget(shimPath)
    if (target === null) {
      artifacts.push({
        key: 'shim',
        label: 'CLI shim `~/.unified-memory/bin/memory`',
        state: 'drift',
        detail: '内容无法识别（没有 PYTHONPATH 行）；将重新生成。',
      })
    } else if (!existsSync(target)) {
      artifacts.push({
        key: 'shim',
        label: 'CLI shim `~/.unified-memory/bin/memory`',
        state: 'drift',
        detail: `指向的核心已不存在（${target}）；将改指当前安装位置。`,
      })
    } else if (probe.previous !== null && probe.previous.corePath !== probe.corePath) {
      // The target exists but is a *different* install than the one recorded —
      // the usual case after an upgrade that changed the package directory.
      artifacts.push({
        key: 'shim',
        label: 'CLI shim `~/.unified-memory/bin/memory`',
        state: 'drift',
        detail: '指向上一版的核心目录；将改指当前安装位置。',
      })
    } else {
      artifacts.push({
        key: 'shim',
        label: 'CLI shim `~/.unified-memory/bin/memory`',
        state: 'ok',
        detail: '指向当前核心。',
      })
    }
  }

  // 2. Managed sections. Existence is checked here; whether the *content*
  //    differs is decided by deploy.py, which owns the marker semantics. The
  //    planner only has to know that the files exist and carry a section.
  if (probe.instructionFiles.length === 0) {
    artifacts.push({
      key: 'instructions',
      label: '各 Agent 指令文件的托管段',
      state: 'missing',
      detail: '没有检测到已存在的指令文件（`~/.dsh/AGENTS.md` 等），跳过。',
    })
  } else {
    artifacts.push({
      key: 'instructions',
      label: '各 Agent 指令文件的托管段',
      state: 'ok',
      detail: `${probe.instructionFiles.length} 个文件将在升级时按当前版本重写托管段（段外内容不动，改前备份）。`,
    })
  }

  // 3. Vault template files added since the vault was created.
  if (probe.vaultPath === null) {
    artifacts.push({
      key: 'vault',
      label: 'Vault 模版文件',
      state: 'missing',
      detail: '尚未配置 vault，跳过。',
    })
  } else {
    const missing = missingTemplateFiles(probe.templateDir, probe.vaultPath)
    artifacts.push({
      key: 'vault',
      label: 'Vault 模版文件',
      state: missing.length === 0 ? 'ok' : 'drift',
      detail: missing.length === 0
        ? '模版文件齐全。'
        : `缺少 ${missing.length} 个新版本引入的文件（${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' 等' : ''}）；只补不覆盖。`,
    })
  }

  // 4. The derived index. Its schema migration is the core's job and it does
  //    it on open; the planner reports it so the version bump is not silent.
  if (probe.vaultPath === null) {
    artifacts.push({
      key: 'index',
      label: '派生索引',
      state: 'missing',
      detail: '尚未配置 vault，跳过。',
    })
  } else {
    artifacts.push({
      key: 'index',
      label: '派生索引',
      state: 'ok',
      detail: '打开时按 schema 版本自动重建（派生数据，可随时重算）。',
    })
  }

  // 5. The prefix registry. Content is merged by setup-run, never rewritten.
  const registryPath = probe.vaultPath === null
    ? null
    : join(probe.vaultPath, '50-Agent-Context', 'Agent提交区', '前缀登记.md')
  if (registryPath === null) {
    artifacts.push({
      key: 'registry',
      label: '提交前缀登记',
      state: 'missing',
      detail: '尚未配置 vault，跳过。',
    })
  } else {
    artifacts.push({
      key: 'registry',
      label: '提交前缀登记',
      state: existsSync(registryPath) ? 'ok' : 'missing',
      detail: existsSync(registryPath)
        ? '已存在，只补本端一行，不改他人行。'
        : '不存在；将新建并登记本端前缀。',
    })
  }

  const installMoved = probe.previous !== null && probe.previous.corePath !== probe.corePath
  const clean = artifacts.every((a) => a.state === 'ok')
    && probe.previous !== null
    && probe.previous.version === probe.version

  return {
    fromVersion: probe.previous?.version ?? null,
    toVersion: probe.version,
    clean,
    artifacts,
    installMoved,
  }
}

/**
 * Whether a plan needs the user's attention before it runs.
 *
 * Not "every plan": a reconcile with nothing broken and no version change is
 * noise. What deserves a prompt is a version change (rules may differ) or any
 * artifact that is actually broken.
 */
export function planNeedsAttention(plan: UpgradePlan): boolean {
  if (plan.fromVersion !== plan.toVersion) return true
  return plan.artifacts.some((a) => a.state !== 'ok')
}

/** One-line summary for a tool result, a log line, or the panel. */
export function summarizePlan(plan: UpgradePlan): string {
  if (plan.clean) return `已是 ${plan.toVersion}，无需变更。`
  const broken = plan.artifacts.filter((a) => a.state !== 'ok')
  const names = broken.map((a) => a.label).join('、')
  // An `X → X` arrow is noise: it reads as a transition when the only thing
  // happening is a repair. Version changes get the arrow; repairs get the
  // version they belong to.
  const sameVersion = plan.fromVersion === plan.toVersion
  const scope = sameVersion ? plan.toVersion : `${plan.fromVersion === null ? '首次运行' : plan.fromVersion} → ${plan.toVersion}`
  if (broken.length === 0) return `${scope}：重写托管段并登记版本。`
  return `${scope}：${broken.length} 项需要修复（${names}）。`
}
