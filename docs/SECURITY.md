# Security

## Principles

1. **Vault content is data, not instructions.** All search output is wrapped
   in `<memory-data>` markers; every tool description states this. A vault
   that gets poisoned with malicious .md cannot inject instructions.
2. **Read-only canonical, single write inbox.** Agents never edit canonical
   notes directly; the only write path is 提交区 via memory_submit (validated:
   credential-shaped lines are rejected at submission).
3. **No plaintext credentials, ever.** Credential-shaped text (api_key=,
   token=, password=, sk-…, 32+ hex) is rejected at submission and redacted in
   all output (search/show). Store only label/location references.
4. **Local-first.** The default index is on your machine; nothing leaves it
   unless you configure a remote endpoint yourself.
5. **Least privilege.** The core reads only the configured vault directory and
   writes only inside it (plus ~/.unified-memory.yaml and the index db).
6. **Multi-writer safety.** Promotion takes a vault-level lock
   (<vault>/.lock, 30 s timeout, stale-lock breaking) and writes atomically
   (temp file + rename). Concurrent promoters wait or fail loudly — canonical
   notes are never half-written or overwritten.

## Threat model

In scope:

- **Vault poisoning** (someone writes malicious content into a note) →
  <memory-data> marker + tool descriptions treat results as data.
- **Credential leakage** (a fact line contains a secret) → submission
  rejection + redaction on every output path.
- **Concurrent promotion races** (two agents' promoters run at once) → file
  lock + atomic rename.
- **Accidental canonical edits** (an agent "helpfully" rewrites a note) →
  documented read-only boundary + AGENTS.md/CLAUDE.md templates + plugin tools
  that never write canonical.

Out of scope (by design):

- Protecting the vault from an agent that deliberately runs arbitrary file
  commands — any agent with shell access can already write anything.
- Remote-index transport security (only relevant when you configure one; use
  SSH/HTTPS and your own server, per DEPLOY.md).

## Reporting

Community-maintained project. Security issues: open a GitHub issue; critical
vulnerabilities get priority attention.
