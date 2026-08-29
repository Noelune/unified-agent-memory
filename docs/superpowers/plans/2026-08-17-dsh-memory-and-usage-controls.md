# DSH Memory And Usage Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the DSH memory settings page, prevent the memory footer popup from clipping, and add a persistent OpenCodeGo monitor visibility switch.

**Architecture:** The active `dsh-unified-agent-memory` client gains a read-only settings section backed by an expanded local-only status route, while its footer panel receives explicit viewport anchoring and overflow constraints. `dsh-opencodego-usage` gains a settings section whose namespaced browser preference conditionally mounts the existing input-right monitor, so disabled state makes neither the quota request nor its timer.

**Tech Stack:** DSH Cordis client slots, React runtime, Node.js built-in test runner, Python standard-library unittest, browser localStorage, existing web profile build.

## Global Constraints

- Do not re-enable or install the retired `dsh-hermes-memory` plugin.
- Obsidian canonical content remains read-only; memory writes remain `memory_submit` to `Agent提交区` only.
- Do not expose memory content or credentials in the new settings page.
- OpenCodeGo API-key resolution and host API route remain unchanged.
- Disabled OpenCodeGo monitor must mount neither its initial request nor its refresh interval.
- Target the existing 3081 GUI; do not start a replacement server.

---

### Task 1: Unified-memory status and bounded footer panel

**Files:**
- Modify: `C:\Users\zhaowei\review_repos\unified-agent-memory\lib\index.js:24-209`
- Modify: `C:\Users\zhaowei\review_repos\unified-agent-memory\lib\client-ui.js:19-109`
- Create: `C:\Users\zhaowei\review_repos\unified-agent-memory\test\web-ui-contract.test.mjs`

**Interfaces:**
- Consumes: `resolveConfig(config)` and the existing `GET /api/dsh-unified-agent-memory/status` route.
- Produces: status JSON fields `{ ok, configured, vaultPath, contextPath, contextExists, inboxPending, indexPath, indexExists, remoteEnabled }` and a `settings.section` labelled `记忆系统`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const client = await readFile(new URL('../lib/client-ui.js', import.meta.url), 'utf8')
const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

test('registers the memory settings section and a bounded footer panel', () => {
  assert.match(client, /name: 'settings\.section', id: 'dsh-unified-agent-memory-settings'/)
  assert.match(client, /label: '记忆系统'/)
  assert.match(client, /left:8px;bottom:60px/)
  assert.match(client, /max-height:calc\(100dvh - 72px\);overflow-y:auto/)
})

test('reports local context, inbox, and index health without remote access', () => {
  assert.match(host, /contextPath/)
  assert.match(host, /inboxPending/)
  assert.match(host, /indexExists/)
  assert.doesNotMatch(host, /https?:\/\//)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web-ui-contract.test.mjs`
Expected: FAIL because the active client has no `settings.section` registration and no bounded panel CSS.

- [ ] **Step 3: Write minimal implementation**

```js
// index.js: local-only status additions
const contextPath = join(cfg.vaultPath, '50-Agent-Context')
const inboxPath = join(contextPath, 'Agent提交区')
const indexPath = join(homedir(), '.unified-memory', `index-${vaultHash(cfg.vaultPath)}.db`)

// client-ui.js: exact Cordis registration
slots.inject('settings.section', function () {
  return slots.register(
    { name: 'settings.section', id: 'dsh-unified-agent-memory-settings', order: 35, label: '记忆系统' },
    MemorySettingsPage,
  )
})
```

Implement a local `readStatus` helper used by the route, plus a read-only page with status rows and retry. Use `left:8px;bottom:60px;max-height:calc(100dvh - 72px);overflow-y:auto` for the fixed footer panel and a <=640px width override.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/web-ui-contract.test.mjs`
Expected: PASS with 2 tests and 0 failures.

- [ ] **Step 5: Run the unified-memory core suite**

Run: `python -m unittest discover -s core/tests`
Expected: PASS without modifying canonical notes or the real local index.

- [ ] **Step 6: Commit**

```bash
git add lib/index.js lib/client-ui.js test/web-ui-contract.test.mjs
git commit -m "feat: restore memory settings status"
```

### Task 2: OpenCodeGo persistent visibility switch

**Files:**
- Modify: `D:\DeepSeek Harness\dsh-opencodego-usage\client.js:15-283`
- Create: `D:\DeepSeek Harness\dsh-opencodego-usage\test\client-contract.test.mjs`

**Interfaces:**
- Consumes: `window.localStorage`, existing `conversation.input.right` slot, and `GET /opencodego-usage`.
- Produces: `settings.section` labelled `OpenCodeGo 用量`, preference key `dsh.opencodego-usage.enabled`, and a conditional monitor mount.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

test('provides a persistent settings switch that gates the quota monitor', () => {
  assert.match(source, /dsh\.opencodego-usage\.enabled/)
  assert.match(source, /name: 'settings\.section'/)
  assert.match(source, /label: 'OpenCodeGo 用量'/)
  assert.match(source, /enabled \? \(\) => React\.createElement\(OcgUsage, null\) : null/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/client-contract.test.mjs`
Expected: FAIL because there is no setting, persistence key, or conditional slot render.

- [ ] **Step 3: Write minimal implementation**

```js
const ENABLED_KEY = 'dsh.opencodego-usage.enabled'

function readEnabled() {
  try { return window.localStorage.getItem(ENABLED_KEY) !== 'false' } catch (_) { return true }
}

function writeEnabled(enabled) {
  try { window.localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false') } catch (_) {}
  window.dispatchEvent(new Event('dsh-opencodego-usage:enabled-change'))
}
```

Add `OpenCodeGoSettingsPage`, subscribe its switch and the input-slot wrapper to `storage` plus `dsh-opencodego-usage:enabled-change`, and mount `OcgUsage` only while enabled. Existing monitor effects therefore cannot run while disabled.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/client-contract.test.mjs`
Expected: PASS with 1 test and 0 failures.

- [ ] **Step 5: Commit source and test when the directory becomes a Git repository**

If `D:\DeepSeek Harness\dsh-opencodego-usage` remains a linked non-repository directory, do not force a repository initialization; report its changed files and retain the source change for the active Web profile link.

### Task 3: Build and GUI verification

**Files:**
- Modify only generated Web profile artifacts created by the profile rebuild.

**Interfaces:**
- Consumes: `C:\Users\zhaowei\.dsh\profiles\web\package.json` and the existing DSH Web process at `http://127.0.0.1:3081`.
- Produces: rebuilt client plugin assets used by the current GUI.

- [ ] **Step 1: Determine the configured profile build command**

Run: `pnpm --dir C:\Users\zhaowei\.dsh\profiles\web run`
Expected: show available scripts, or report no profile script so the DSH CLI rebuild command must be used.

- [ ] **Step 2: Rebuild the active profile without starting another server**

Run the discovered DSH/profile build command against the existing web profile.
Expected: exit 0 and updated plugin client artifacts.

- [ ] **Step 3: Refresh and validate the existing GUI**

Refresh `http://127.0.0.1:3081` and verify:

```text
设置 contains "记忆系统" and "OpenCodeGo 用量".
The memory footer popup opens above the bottom rail, stays inside the viewport, and scrolls when needed.
Turning off "显示输入框额度提示" removes the input pill and stops new quota requests.
Turning it on restores the existing pill and one initial request.
```

- [ ] **Step 4: Commit unified-memory plan and source changes separately from existing unrelated changes**

```bash
git add docs/superpowers/plans/2026-08-17-dsh-memory-and-usage-controls.md
git commit -m "docs: plan memory and usage controls"
```
