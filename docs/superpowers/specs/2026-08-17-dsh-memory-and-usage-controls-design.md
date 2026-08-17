# DSH Memory And Usage Controls Design

## Goal

Restore a usable `设置 -> 记忆系统` page in the DSH Web GUI, keep the lower-left unified-memory status popover fully visible on every supported viewport, and let users hide and stop the OpenCodeGo quota monitor when it is not relevant.

## Context And Root Cause

The active Web profile bundles `dsh-unified-agent-memory`, not the legacy `dsh-hermes-memory` package. The legacy client registered `settings.section`; the active unified client only registers `sidebar.footer.action`, so the memory settings page disappeared during the migration.

The active unified-memory popover uses `position: fixed` but does not set a viewport anchor, maximum height, or scroll behavior. Its browser placement is therefore under-specified and can be clipped by the bottom rail or small viewports.

The OpenCodeGo client unconditionally registers `conversation.input.right`, starts a request on mount, and polls every two minutes. It has no user-controlled enabled state, so an unused configuration remains visible and continues requesting its endpoint.

## Scope

### Unified Memory

- Add a `settings.section` registration labelled `记忆系统` alongside the existing footer action.
- Provide a compact operational page showing the local vault path, configured status, index health, pending inbox count, and the current write boundary. The page remains read-only and does not expose memory content or credentials.
- Expand the same-origin status route so it returns derived local status fields required by the UI. It must not make network or SSH calls.
- Anchor the footer popover above the left rail at a stable bottom offset.
- Give the popover a viewport-derived maximum height and `overflow-y: auto`; on narrow viewports, use left/right margins and an automatic width.

### OpenCodeGo Usage

- Add a `设置 -> OpenCodeGo 用量` section with a switch labelled `显示输入框额度提示`.
- Persist the switch in browser `localStorage` under a namespaced key. Its default is enabled to preserve existing behavior for configured users.
- When disabled, render no input-right slot content, make no initial request, and start no polling interval.
- When switched off while open, immediately remove the pill and panel. When switched on, mount the existing monitor and resume its normal initial fetch and polling behavior.
- Keep the host route and API-key resolution unchanged. No key is stored or displayed by the new UI.

## Data Flow

1. The unified-memory settings page fetches `/api/dsh-unified-agent-memory/status`.
2. The host computes all status values locally from the configured vault and its local index.
3. The page renders status metadata only; querying and writing stay with `memory_*` model tools, preserving the canonical read-only and submit-inbox rules.
4. The OpenCodeGo settings page reads/writes `localStorage` and shares the state with the input monitor through a browser `storage` event plus local same-tab notification.
5. A disabled monitor is not mounted, therefore it cannot fetch `/opencodego-usage` or create its refresh timer.

## Error Handling

- An unavailable unified-memory status endpoint presents a short retryable status error without hiding the settings section.
- A missing or inaccessible vault remains a normal unconfigured/error state; it never displays note contents.
- `localStorage` read/write failures fall back to the enabled default for the current session, avoiding a broken input UI.
- Existing OpenCodeGo API errors remain in the monitor panel only when the user has explicitly enabled it.

## Tests

- Add client-module source-contract tests that assert the unified-memory plugin registers `settings.section` and includes a fixed, bounded, scrollable footer panel style.
- Add tests for status payload helper behavior: no configured vault reports an unconfigured state; an existing vault reports presence; missing index/inbox safely produce zero/false fields.
- Add OpenCodeGo client source-contract tests asserting a settings section, namespaced persistence key, storage state gate, and conditional monitor registration/fetch behavior.
- Run the unified-memory Python suite, the new focused Node tests, and the Web profile rebuild. Refresh the existing `http://127.0.0.1:3081` GUI and verify both settings entries plus a non-clipped left-footer popup.

## Non-Goals

- Do not reinstall the retired `dsh-hermes-memory` plugin or run both memory UI plugins concurrently.
- Do not change canonical memory, promoter behavior, retrieval behavior, credentials, or OpenCodeGo API handling.
- Do not start a replacement Web server; deployment targets the existing 3081 instance after rebuilding its profile artifacts.
