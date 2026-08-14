# 情境信息

Transient coordination state:

- 待晋升.md — pending promotion list (built by `promoter --review`)
- 事实冲突待裁决.md — conflicts awaiting human adjudication
- 事实冲突已裁决.md — adjudication log
- 未归类事实.md — facts that matched no category (promoted here)

Adjudicate conflicts interactively:

    python -m unified_memory.promoter adjudicate
