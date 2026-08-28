# Doctor Agent Product Grill Extension

Use this extension only for the Doctor Agent repository.

## Purpose

Interrogate product requirements deeply enough that the product implementation, Agent
integration Mock, Agent-role Mock, and later harness engineering all derive from the same
decisions. Ask only questions that require product, clinical, governance, or business
judgment. Inspect existing documents and code before asking anything the repository can
answer.

## Interview priority

Work through the highest-risk unresolved branch first. Do not mechanically ask every
question. One focused question at a time remains the default.

### 1. User and workflow

- Which user role performs the action?
- At what stage of the outpatient visit does it occur?
- What triggers the function: user action, data event, schedule, or Agent result?
- What must be true before the action is available?
- What happens immediately afterward?

### 2. Data semantics

- Which entities and fields are in scope?
- Which fields use exact, prefix, fuzzy, pinyin, synonym, or code-based matching?
- How are null, unknown, conflicting, stale, duplicated, or late-arriving values handled?
- What is the authoritative source and data cutoff time?
- Which fields are displayed, returned, logged, cached, or prohibited?

For search requirements, explicitly resolve:

- searchable fields;
- exact versus fuzzy behavior per field;
- tokenization, case, punctuation, pinyin, synonyms, abbreviations, and medical terminology;
- filters, default sort, tie-breaking, pagination, highlighting, empty state, and result limits;
- department, role, patient, encounter, and organization visibility boundaries;
- latency target and dataset size;
- audit and protected-health-information logging rules.

### 3. Permissions and isolation

- Which roles may see, invoke, edit, accept, reject, or write back?
- What organization, department, patient, and encounter scope applies?
- What happens when permissions change while a task is running?
- Which administrative roles are explicitly forbidden from confirming clinical content?

### 4. State and concurrency

- What are the valid states and transitions?
- Can the user cancel, retry, regenerate, undo, or resume?
- How are duplicate submissions, concurrent edits, stale results, and patient switching handled?
- What is the idempotency key and version-conflict behavior?

### 5. Clinical safety and write-back

- Is the result informational, advisory, draft, or blocking?
- Which risks require interruption, acknowledgement, or a recorded reason?
- What evidence, source, time, uncertainty, and version must be visible?
- Which result can enter a draft, and which can enter a formal record?
- Who performs the final confirmation?
- What happens when the Agent, rule engine, data source, or write-back fails?

### 6. Product, integration, and Agent boundaries

- Is the behavior owned by the product line, Agent integration line, or Agent role/tuning line?
- Is the current implementation real product behavior or Mock Agent behavior?
- Which request, event, semantic-result, card-view-model, and audit contracts change?
- Must Mock and AgentScope exhibit identical product-visible behavior?
- Does the change require a Skill, MCP capability, data source, Agent-role change, or only a
  product feature?

Worker and Sub-agent designs remain **待讨论** unless the user explicitly confirms them.

### 7. Failure and non-functional constraints

- What are the empty, missing-data, conflict, timeout, invalid-schema, unavailable-tool,
  degraded, and unauthorized paths?
- Which failures block the workflow and which permit manual completion?
- What are the performance, availability, observability, privacy, and retention targets?
- Which failure must never expose partial or unsafe clinical content?

### 8. Acceptance and harness translation

Every resolved requirement should be expressible as one or more of:

- deterministic acceptance criterion;
- state-transition test;
- permission or isolation test;
- API/JSON Schema contract test;
- safety invariant;
- Mock fixture;
- failure-injection case;
- clinical evaluation sample or hard gate.

## Required exit artifact

In Spec or Ticket mode, add a `Harness Constraints` section after the Ambiguity Report.
Use this structure for each material decision:

```markdown
### HC-<number> — <short name>

- Decision:
- Applies to:
- Owner line:
- Enforcement layer:
- Verification:
- Mock fixture:
- Failure behavior:
- Open dependency:
```

`Owner line` must be one of:

- Product Function Development;
- Agent Integration;
- Agent Role Definition and Tuning;
- Clinical and Safety Governance.

Do not invent an answer merely to lower the ambiguity score. If the user deliberately defers
a decision, record it as an open dependency, name the temporary Mock behavior, and define what
must be revisited before real AgentScope integration or production release.
