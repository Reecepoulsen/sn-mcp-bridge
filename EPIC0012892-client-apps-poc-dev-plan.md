# EPIC0012892 "Client Apps POC" — dev plan for dev343967

## Context

An architect handed over **EPIC0012892 (Client Apps POC)** on ahead.service-now.com: a POC giving the Client Apps support teams a dedicated **Support Case** type on the CSM case table, with its own groups, left nav, workspace lists, form/list views, assignment behavior, and an internal-employee-as-consumer model.

A prior planning pass (`EPIC0012892-client-apps-poc-plan.md`) identified missing plugins as the blocker. Those are now activated in dev343967 — **except Now Assist for CSM (`sn_csm_gen_ai`), which is licence-gated on PDIs and is out of scope for this build.** This plan supersedes the earlier one: it re-runs discovery against the post-plugin instance, enumerates the concrete artifacts per story, and lays out the scope and update-set structure.

**Target:** dev343967 — Zurich, Customer Service `sn_customerservice` 28.0.29.
**Stories in scope:** 11 buildable + 1 verification-only. The 9 drafts (notifications, SLAs, record producer, inbound email, auto-close, action status, needs-attention on reply, case-from-interaction) remain out of scope.

---

## What discovery changed (verified 2026-08-24)

The plugin activation resolved most of the earlier unknowns. Six findings materially change the build:

| Finding | Impact |
| --- | --- |
| **A case type IS a child table.** `sn_case_type` (scope `sn_csm_case_types` 3.0.2) has a mandatory `case_type_table` field, and `CaseTypeHelper._isCaseTypeExtension()` resolves it via `GlideTableHierarchy('sn_customerservice_case').getAllExtensions()`. | Every UI/behavior story targets a **new child table**, not a filtered view of the parent. `sn_case_type` is currently **empty** — zero case types exist. |
| **The field is `notes_to_comments`,** not `add_resolution_notes_to_comments` — boolean on `sn_customerservice_case`, label "Add resolution notes to comments". | STRY0098987 unblocked; use the real column name. |
| **`needs_attention` and `action_status` are OOB on `task`** (global scope; boolean and integer). `sn_action_status_blocked_by` table arrived 2026-08-19. | STRY0098982/0098983 unblocked with no custom fields for these; "Blocked By" related list is real. |
| **`other_category` does not exist** anywhere on `task` or `sn_customerservice_case`. | Confirmed custom — we create it (decision below). |
| **No "Customer Service" group type exists.** `sys_user_group_type` holds only `itil`, `survey`, `Knowledge`, `catalog`, `schedule_visible_*`. No plugin added one. | STRY0098979 must create it, and STRY0098980's qualifier depends on its sys_id. |
| **`csm_consumer.user` is gated by a script include, not a property.** Qualifier is `javascript:new Consumer().getConsumerUserReferenceQualifier()`; `global.Consumer` extends `global.ConsumerImpl`, whose implementation returns `sys_class_nameINcsm_consumer_user`. | STRY0098990 has a clean, SNC-sanctioned override point: add the method to the `Consumer` wrapper. No dictionary hack needed (and `csm_consumer` is not extendable, so an override wasn't available anyway). |

Confirmed present and usable: `sn_customerservice_case.incident`, `.problem`, `.change` (Change Request), `.caused_by` (Caused by Change), `.product`, `.category`, `.subcategory`, `.resolution_code`, `.resolved_by`, `.active_escalation`; all 8 `csm_consumer` sync fields; roles `sn_customerservice.consumer_agent`, `sn_customerservice_manager`, `sn_customerservice.unified_consumer`, `snc_internal`.

### Decisions taken

- **Scope:** build in **`sn_customerservice`** (`51d811fad7223100b7490ee60e61034f`). Table will be `sn_customerservice_support_case`. This satisfies STRY0098972's AC literally. Accepted cost: our records are customizations of a ServiceNow store app, so CSM upgrades will report skipped/conflicting records, and `can_edit_in_studio = false` means update-set export is the only migration path.
- **`other_category`:** create as a **custom string field** (100 chars) on the Support Case table, placed after Sub category. Assumption flagged to the architect.
- **Group names:** use **corrected spellings** — *Associate Account Coordinator*, *Client Apps Troubleshooting*. Deviation from AC text flagged.
- **Update sets:** **batch base + one child per story.**

---

## Scope and update-set structure

**One update set belongs to exactly one application** — the platform forces a new set's application to the caller's current scope, and `switch_dev_context` refuses a set from a different scope. Three stories have artifacts that cannot live in `sn_customerservice`, so the per-story structure is delivered as **two batch bases**, not one. Everything else is unchanged from the approved shape.

### Base A — `EPIC0012892 – Client Apps POC (CS)` · scope `sn_customerservice`

| # | Child update set | Story |
| --- | --- | --- |
| 1 | `EPIC0012892 – STRY0098972 – Support Case Type` | Support Case Type |
| 2 | `EPIC0012892 – STRY0098981 – Left Nav` | Left nav |
| 3 | `EPIC0012892 – STRY0098982 – Form Views` | Form views |
| 4 | `EPIC0012892 – STRY0098983 – List Views` | Native list view |
| 5 | `EPIC0012892 – STRY0098980 – Group Qualifier` | Assignment-group restriction |
| 6 | `EPIC0012892 – STRY0098984 – Clear Assigned To` | Clear assigned_to |
| 7 | `EPIC0012892 – STRY0098987 – Notes to Comments` | Resolution notes always true |

### Base B — `EPIC0012892 – Client Apps POC (Global)` · scope `global`

| # | Child update set | Story | Why Global |
| --- | --- | --- | --- |
| 8 | `EPIC0012892 – STRY0098991 – Workspace Lists` | Workspace lists | `sys_ux_list*` is owned by `@servicenow/now-record-list-menu-connected` and its config by `sn_cwf_wrkspc`; existing rows are owned by many different app scopes. Global is the neutral, always-permitted home. |
| 9 | `EPIC0012892 – STRY0098990 – Internal Consumers` | Internal consumers | Requires modifying **`global.Consumer`**, plus business rules on the global `sys_user_grmember` table. |
| 10 | `EPIC0012892 – STRY0098989 – Consumer Sync` | User→consumer sync | Business rule on the global `sys_user` table; shares the Global script include with #9. |

### Bucket C — data, travels in **no** update set

`sys_user_group_type`, `sys_user_group`, `sys_group_has_role`, and `csm_consumer` rows are data, not scope-stamped metadata. **STRY0098979 produces no update-set content at all**, and STRY0098990's group is likewise data.

Deliverable instead: a single XML export pack, `EPIC0012892-data-pack.xml`, checked into this repo alongside the plan, plus a re-creation script. **Create the Customer Service group type with a hard-coded, fixed `sys_id`** so STRY0098980's reference qualifier stays portable across environments.

### Context hygiene

Current context is the **DEPRECATED** scope (`x_1849660_intellig`) on its **Default** set — wrong on both axes. `switch_dev_context` to `sn_customerservice` is the **first action and the first checkpoint**: if the tool cannot set a store-app scope, stop and re-decide the scope before any writes. `get_dev_context` before each wave's first write; `get_update_set_contents` on each base at each wave's end.

---

## Wave 0 — EXECUTED 2026-08-24

**Scope checkpoint passed.** `switch_dev_context` set the current scope to `sn_customerservice` (`sys_class_name = sys_store_app`), `ready_to_write: true`, no warnings. Building in the store-app scope is confirmed viable from MCP. All 12 sets verified `in progress`, correctly parented, with the right `application`.

| Update set | sys_id | application |
| --- | --- | --- |
| **Base A** — EPIC0012892 – Client Apps POC (CS) | `b5f9829b93f6cb501fee36befaba10e0` | sn_customerservice |
| ├ STRY0098972 – Support Case Type | `ed0a469b93f6cb501fee36befaba109f` | sn_customerservice |
| ├ STRY0098981 – Left Nav | `370a869b93f6cb501fee36befaba10f9` | sn_customerservice |
| ├ STRY0098982 – Form Views | `f11a0a9b93f6cb501fee36befaba100c` | sn_customerservice |
| ├ STRY0098983 – List Views | `231a4a9b93f6cb501fee36befaba1018` | sn_customerservice |
| ├ STRY0098980 – Group Qualifier | `212a8a9b93f6cb501fee36befaba1036` | sn_customerservice |
| ├ STRY0098984 – Clear Assigned To | `af2aca9b93f6cb501fee36befaba10b0` | sn_customerservice |
| └ STRY0098987 – Notes to Comments | `113a0e9b93f6cb501fee36befaba10b7` | sn_customerservice |
| **Base B** — EPIC0012892 – Client Apps POC (Global) | `fc4ace9b93f6cb501fee36befaba1009` | global |
| ├ STRY0098991 – Workspace Lists | `9f4a02db93f6cb501fee36befaba1082` | global |
| ├ STRY0098990 – Internal Consumers | `695a42db93f6cb501fee36befaba10f4` | global |
| └ STRY0098989 – Consumer Sync | `7f5ac2db93f6cb501fee36befaba101b` | global |

Current context is left on **Base A** in `sn_customerservice`. Before each story, `switch_dev_context` to that story's child set.

---

## Wave 1 (partial) — EXECUTED 2026-08-24 · STRY0098979 complete

Data records, verified present with correct type and roles. **In no update set** — these are the contents of `EPIC0012892-data-pack.xml`.

| Record | sys_id | Role granted |
| --- | --- | --- |
| Group type **Customer Service** | `c500128920000000000000000000ca01` *(hand-assigned, portable)* | — |
| Client Apps Order Management | `87aa4edb93f6cb501fee36befaba10ed` | `sn_customerservice.consumer_agent` |
| Associate Account Coordinator | `3cbacedb93f6cb501fee36befaba1024` | `sn_customerservice.consumer_agent` |
| Client Apps Troubleshooting | `9aba021f93f6cb501fee36befaba10b8` | `sn_customerservice.consumer_agent` |
| Client Apps Managers | `63ba02db93f6cb501fee36befaba10c3` | `sn_customerservice_manager` |
| **Internal Consumers** (STRY0098990 data half) | `1fda8edb93f6cb501fee36befaba10dc` | `sn_customerservice.unified_consumer` |

STRY0098980's reference qualifier is therefore `type=c500128920000000000000000000ca01`.

### STRY0098972 complete — built via Table API, wizard skipped

The wizard only creates the extended table, so it was bypassed entirely (architect direction). Six changes captured in set `ed0a469b93f6cb501fee36befaba109f`, all `application = sn_customerservice`.

| Artifact | sys_id / name |
| --- | --- |
| Table **Support Case** `sn_customerservice_support_case`, extends `sn_customerservice_case` | `e8cb869f93f6cb501fee36befaba1075` |
| Case type record, `internal_name = sn_customerservice.sn_customerservice_support_case` | `35fb06df93f6cb501fee36befaba100d` |
| Custom field **Other Category** | `feeb461f93f6cb501fee36befaba1007` |

**Two facts every downstream story depends on:**

1. **The custom field is `u_other_category`, not `other_category`.** ServiceNow auto-prefixes custom columns on a `task`-rooted hierarchy. Use `u_other_category` in the STRY0098982 form layout.
2. **Cross-scope access flags were set to match the parent** (`create_access` / `update_access` = true, `delete_access` = false). They defaulted to false on insert, which would have blocked writes from Global-scope artifacts.

**Numbering:** no `sys_number` record was created for the child table, so Support Cases inherit the parent's `CS` prefix. No AC requires a distinct prefix; add a `sys_number` row on `sn_customerservice_support_case` if the architect wants one.

---

## PLATFORM CONSTRAINT discovered 2026-08-24 — update-set capture

Two distinct Table-API limits were hit and verified. Both change how the remaining stories must be built.

### 1. `update_synch_custom` tables do not capture via the Table API

`sys_dictionary` attributes decide update-set tracking:

| Attribute | Tables | Captured via Table API? |
| --- | --- | --- |
| `update_synch=true` | `sys_app_module`, `sys_ui_policy`, `sys_script`, `sys_dictionary`, `sys_dictionary_override`, `sys_db_object`, `sn_case_type` | **Yes** — verified, 19 changes in Base A |
| `update_synch_custom=true` | `sys_ui_section`, `sys_ui_list`, `sys_ui_related_list` | **No** — verified twice |
| *(none)* | `sys_ui_element`, `sys_ui_list_element` | Never directly; they travel inside the parent's payload |

Verified empirically: a `sys_ui_list` insert **and** a subsequent update produced no `sys_update_xml` row; a `sys_ui_section` insert produced none either. Instance-wide there are **zero** "List" captures and exactly **one** "Form Layout" capture (2026‑07‑28, Default set) — that one was made through the Form Designer UI.

**Conclusion:** form layouts, list layouts, and related lists are *buildable* via MCP and work correctly in dev, but they **will not travel in an update set** unless saved through their designer UI. This affects **STRY0098982**, **STRY0098983 (native half)**, and the related lists.

### 2. `sys_ui_policy_action.ui_policy` is blocked outright

That field carries create *and* write ACLs with `admin_overrides = false` and no permissive counterpart. The Table API silently drops the reference — two attempts produced orphaned actions, since deleted. STRY0098987 therefore implements read-only + true in the UI policy's `script_true`/`script_false` instead of an action record. Functionally equivalent, and it captures correctly.

*(Note: the `admin_overrides = false` ACLs on `sys_ui_section` / `sys_ui_form` / `sys_ui_form_section` are only the "UserIsAuthenticated" attribute ACLs and each has a permissive `admin_overrides = true` counterpart — those tables are writable. Their problem is capture, per #1, not permission.)*

Two DELETE rows for the orphaned UI policy actions remain in the 0098987 set. Harmless on import (deleting a record that was never there is a no-op), but they can be removed from the set before migration if you want it clean.

**Decision (2026‑08‑24):** build all layouts via MCP, then open each in its designer and save once to force capture. See the touch-point list below.

---

## Waves 2–3 — EXECUTED 2026-08-24

### Captured in Base A (19 tracked changes, verified)

| Story | Artifacts |
| --- | --- |
| **0098981 Left Nav** | 7 `sys_app_module` rows. Verified ordered: Cases@100 → **Support Cases@200, modules 210–260** → Escalations@300. "Unassigned" uses `active=true^assigned_toISEMPTY^ORassignment_groupISEMPTY^EQ` per its AC — deliberately broader than the OOB Cases version. |
| **0098980 Group Qualifier** | `sys_dictionary_override` on the child table, `assignment_group`, `reference_qual_override=true`, `type=c500128920000000000000000000ca01`. Parent untouched. |
| **0098984 Clear Assigned To** | Before-update BR "Clear Assigned to on Group change", order 100, condition `current.assignment_group.changes()`. *(The `name` field is 40 chars — the original title truncated and was shortened.)* |
| **0098987 Notes to Comments** | `sys_dictionary_override` default true + UI policy (`active=true^resolved_atISEMPTY`, `ui_type=All`, `global=true`) whose `script_true` sets value **and** read-only; `script_false` releases it. |

### Built but NOT captured — needs a designer save

| Story | Artifacts built | Verified |
| --- | --- | --- |
| **0098983** native list | `sys_ui_list` (Default view) + 7 `sys_ui_list_element`: number, state, action_status, priority, short_description, consumer, assigned_to | ✅ |
| **0098982** forms | **8 `sys_ui_section`** (Main / Notes / Related Records / Closure Information × Default view + Workspace view `7ebcaa82…`) and **90 `sys_ui_element`** — 45 per view (20 / 7 / 7 / 11) | ✅ counts confirmed |
| **0098982** related lists | 2 `sys_ui_related_list` (Default + Workspace) × 10 entries: `task_sla.task`, `sn_customerservice_task.parent`, `REL:f1b41c4f…` (Escalations), `sn_customerservice_case.parent`, `sn_action_status_blocked_by.blocked_task`, `m2m_kb_task.task`, `kb_feedback_task.parent`, `REL:37815ea2…` (Emails), `sys_attachment.table_sys_id`, `REL:35e23f2a…` (Interactions) | ✅ 10 + 10 |

Column-split convention used throughout: `.begin_split` → left fields → `.split` → right fields → `.end_split` → full-width fields, matching the OOB CSM sections.

### DEFECT FOUND AND FIXED 2026-08-24 — orphaned form sections

The first build of 0098982 created only `sys_ui_section` + `sys_ui_element`. **A form layout needs four tables:**

```
sys_ui_form → sys_ui_form_section (position) → sys_ui_section → sys_ui_element
```

Without a `sys_ui_form_section` binding row, sections are orphaned and the form ignores them — the `position` value on the section itself does nothing.

Worse, these records are **lazily materialized**: `sys_ui_form` / `sys_ui_form_section` / default `sys_ui_section` rows do not exist for a new table until someone first opens that form in that view. When the form was opened at 19:33, ServiceNow generated its *own* complete set of sections (sys_ids `937acb50…`) copied down from the parent Case layout, created the `sys_ui_form` rows, and bound them to **its** sections — leaving the MCP-built sections (`933acb50…`) orphaned. The form rendered the inherited parent layout.

**Fix applied:** repointed all 8 `sys_ui_form_section.sys_ui_section` references at the MCP-built sections, then deleted the 8 orphaned auto-generated sections. Order matters — `sys_ui_form_section.sys_ui_section` cascades on delete, so deleting a still-bound section would take its binding row with it.

**Verified after fix** — both forms now bind to the correct sections in the intended order:

| Form | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| Default view `59f81edb…` | main `78dd0ad3` | Notes `c830da1b` | Related Records `fc309e1b` | Closure Info `2d309e1b` |
| Workspace `78f8dadb…` | main `7cb09e5b` | Notes `a5b0de5b` | Related Records `deb0de5b` | Closure Info `b6b0de5b` |

The **Case view** form (`85f81edb…`) still holds its four auto-generated sections. That view is not in any AC, so it was deliberately left alone — deleting its sections would break it.

Both behaviors are recorded in `Considerations-for-Development-via-MCP.md` and `.claude/skills/servicenow-mcp-development/SKILL.md`.

## Wave 4 + Workspace Lists — EXECUTED 2026-08-24 · Base B complete

All 10 Global-scope changes captured and verified.

| Story | Artifacts | sys_id |
| --- | --- | --- |
| **0098991** | `sys_ux_list_category` "Support Cases" @ order 12 (between Cases@10 and Case Task@14) | `815bd65393bacb501fee36befaba10bb` |
| | 5 × `sys_ux_list` — My Cases@10, Open@20, Unassigned from my groups@30, Escalated@40, All@50. Each carries `columns = number,state,action_status,priority,short_description,consumer,assigned_to`, satisfying the **workspace half of 0098983** | — |
| **0098990** | Script include `ClientAppsConsumerSync` — field map + `createConsumerForUser` / `syncConsumerFromUser`, `setWorkflow(false)` on the consumer update | `b79bde5393bacb501fee36befaba10de` |
| | **`global.Consumer` customised** — added `getConsumerUserReferenceQualifier()` overriding `ConsumerImpl`'s `sys_class_nameINcsm_consumer_user` so internal users are selectable | `624eb8675352030097a2ddeeff7b1260` |
| | BR "Create consumer for Internal Consumers" on `sys_user_grmember`, after insert, condition `current.group.name == 'Internal Consumers'` | `87cb569393bacb501fee36befaba109a` |
| **0098989** | BR "Sync user changes to consumer profile" on `sys_user`, after update, condition on all 8 mapped fields changing, guarded on `snc_internal` | `0ceb9a9393bacb501fee36befaba1056` |

**Portability note:** the membership rule matches the group by **name**, not sys_id, so it survives migration without depending on the data pack's generated sys_id. (The group *type* still needs its fixed sys_id because a reference qualifier can only filter on the value.)

**Upgrade note:** `global.Consumer` is an OOB script include. The wrapper/Impl split is the override point ServiceNow ships for this, but the record will still appear in upgrade review. It carries an inline comment saying so.

---

## Status summary

| Story | State |
| --- | --- |
| 0098976 Plugins | ✅ verified (Now Assist excluded — licence-gated) |
| 0098972 Support Case Type | ✅ captured |
| 0098979 CS Groups | ✅ built (data — no update set) |
| 0098981 Left Nav | ✅ captured |
| 0098991 Workspace Lists | ✅ captured |
| 0098982 Form Views | ⚠️ built + bindings fixed — **needs designer save to capture** |
| 0098983 List Views | ⚠️ native built — **needs designer save**; workspace half captured via `sys_ux_list.columns` |
| 0098980 Group Qualifier | ✅ captured |
| 0098984 Clear Assigned To | ✅ captured |
| 0098987 Notes to Comments | ✅ captured |
| 0098990 Internal Consumers | ✅ captured |
| 0098989 Consumer Sync | ✅ captured |

**29 tracked changes total** — 19 in Base A (`sn_customerservice`), 10 in Base B (`global`).

### Remaining: functional verification

Not yet run — needs a browser:

1. Create a Support Case; confirm the form matches the AC field-for-field in native **and** CSM/FSM workspace.
2. assignment_group picker offers only Customer Service groups; set assigned_to, change group, save → assigned_to clears. Repeat in workspace.
3. "Add resolution notes to comments" is checked and read-only on an active unresolved case.
4. Add an `snc_internal` user to Internal Consumers → `csm_consumer` appears with all 8 fields; edit their mobile phone and last name → consumer updates.
5. Consumer → Create New: a plain user record is selectable in the User field.
6. **Regression guard** — a regular Case still accepts non-CSM groups and does *not* clear assigned_to; a non-`snc_internal` user edit touches no consumer.

### Designer touch-points required (forces update-set capture)

With **EPIC0012892 – STRY0098982 – Form Views** as the current set:
1. Support Case form → right-click header → **Configure → Form Layout**, Default view → Save
2. Same, **Workspace** view → Save
3. **Configure → Related Lists**, Default view → Save
4. Same, **Workspace** view → Save

Then switch to **EPIC0012892 – STRY0098983 – List Views**:
5. Support Case list → **Configure → List Layout**, Default view → Save

Re-run `get_update_set_contents` on Base A afterwards; expect Form Layout / List / Related List rows to appear.

---

## Artifacts per story

### STRY0098976 · Enable Customer Service with Plugins (1 pt) — verification only

No artifacts, no update set. Record evidence per plugin: `com.sn_customerservice` → `sn_customerservice` 28.0.29; `com.snc.csm_action_status` → `task.action_status` + `sn_action_status_blocked_by`; `sn_csm_case_types` → scope 3.0.2 + `sn_case_type`; `com.sn_cs_sm` → `sn_customerservice_case.incident/problem/change/caused_by`; `sn_csm_wrkspc` → 25.2.6. Close with **`sn_csm_gen_ai` recorded as an environment limitation** (licence-gated on PDI), per the epic owner's direction.

### STRY0098972 · Support Case Type (2 pts) — set #1

The builder is a UI wizard (`Customer Service → Case Types → Create New Case Type`, `/wizard_view.do?...sysparm_parent=d35f613677b633002bc4914f581061a4`) and **cannot be driven through the Table API**.

- **Path A (primary):** in the UI, set the application picker to *Customer Service*, run the wizard, name the type **Support Case**, extend **Case**. Produces the `sn_case_type` record and the `sn_customerservice_support_case` table plus its dictionary/number/label metadata.
- **Path B (fallback, if the picker won't offer a store app):** create the child table directly via MCP — `switch_dev_context` to `sn_customerservice`, insert `sys_db_object` with `super_class = a076ee549396cf501fee36befaba10fc`, then insert the `sn_case_type` record with `case_type_table = sn_customerservice_support_case`.

Then via MCP: the custom **`other_category`** string field (100) on the new table. Every later story keys off this table name — **treat the table's actual name and scope as a checkpoint before proceeding.**

### STRY0098979 · Create Customer Service Groups (1 pt) — data pack, no update set

1. `sys_user_group_type` — **Customer Service**, with a chosen fixed sys_id.
2. Four `sys_user_group` rows, `type` = that group type:
   - Client Apps Order Management, Associate Account Coordinator, Client Apps Troubleshooting → role `sn_customerservice.consumer_agent`
   - Client Apps Managers → role `sn_customerservice_manager`
3. `sys_group_has_role` grants.

### STRY0098981 · Support Case Left Nav (1 pt) — set #2

`sys_app_module` rows against menu `99e97177c342310015519f2974d3aebd`. Verified layout: Cases separator @100 (modules 120–180), Escalations separator @300 → **Support Cases separator @200, modules 210–260**. `name` = the Support Case table.

| Module | order | link_type | filter |
| --- | --- | --- | --- |
| Create New | 210 | DIRECT | mirror OOB Create New (`...do?sys_id=-1&...&sysparm_view=<our view>`) |
| My Cases | 220 | LIST | `active=true^assigned_to=javascript:getMyAssignments()^EQ` |
| All | 230 | LIST | *(none)* |
| Open | 240 | LIST | `active=true^state=10^EQ` |
| Unassigned | 250 | LIST | `active=true^assigned_toISEMPTY^ORassignment_groupISEMPTY^EQ` |
| Escalated | 260 | LIST | `active=true^active_escalationISNOTEMPTY^EQ` |

"Unassigned" is deliberately broader than the OOB Cases version (`active=true^assigned_toISEMPTY^EQ`) — the AC says *assigned to **or** assignment group* empty.

### STRY0098991 · Support Case in CSM/FSM Workspace Lists (1 pt) — set #8

List menu config `0b62b8ba77d650102c30945caa106138`. Verified category orders: **Cases @10**, **Case Task @14** → insert `sys_ux_list_category` **"Support Cases" @12**.

Five `sys_ux_list` rows on that category (`table` = Support Case table, `configuration` = the config above). Reuse the OOB dynamic filters found on the Cases lists — Me `90d1921e5f510100a9ad2572f2b477fe`, One of my groups `d6435e965f510100a9ad2572f2b47744`:

| Title | order | condition |
| --- | --- | --- |
| My Cases | 10 | `active=true^assigned_toDYNAMIC<me>^EQ` |
| Open | 20 | `active=true^state=10^EQ` |
| Unassigned from my groups | 30 | `active=true^assigned_toISEMPTY^assignment_groupDYNAMIC<my groups>^EQ` |
| Escalated | 40 | `active=true^active_escalationISNOTEMPTY^EQ` |
| All | 50 | *(none)* |

`sys_ux_list.columns` is a mandatory field-list — set it here to STRY0098983's column set (see below). That is how the workspace half of 0098983 is satisfied.

### STRY0098982 · Support Case form views (2 pts) — set #3

`sys_ui_section` / `sys_ui_element` on the Support Case table for **both** the Default view and the **Workspace** view (`7ebcaa8218b232108bb255f46a373a4b`), mirroring the existing CSM pattern (Default sections owned by `sn_customerservice`; Workspace sections by `sn_csm_workspace`).

- **Main — left:** number, contact_type (Channel), consumer, product, category, subcategory, **other_category**
- **Main — right:** needs_attention, state, action_status, impact, urgency, priority, assignment_group, assigned_to
- **Main — full width:** short_description, description
- **Notes:** watch_list, work_notes_list, comments, activity stream
- **Related Records:** incident, problem, **change**, caused_by
- **Closure Information — left:** resolved_at, closed_at, resolution_code · **right:** resolved_by, closed_by, knowledge · **full width:** close_notes, **notes_to_comments**

Related lists via `sys_ui_related_list` (Default view): Task SLAs, Case Tasks, Escalations, Child Cases, Blocked By (`sn_action_status_blocked_by`), Attached Knowledge, Knowledge Gaps, Emails, Attachments, Interactions. In workspace, related lists are inherited from the parent's form configuration — **verify inheritance before authoring workspace-specific records**, and only add UX form-config overrides if the inherited set is wrong.

### STRY0098983 · Case list views (1 pt) — set #4 (+ columns set in #8)

Native: `sys_ui_list` + `sys_ui_list_element`, Default view on the Support Case table, in order: **Number, State, Action Status, Priority, Short Description, Consumer, Assigned to.** Identical list set on `sys_ux_list.columns` for all five workspace lists — matching native and workspace is the story's actual point, so verify both sides together even though they land in different update sets.

### STRY0098980 · Only Customer Service groups selectable (1 pt) — set #5

One `sys_dictionary_override` on **`sn_customerservice_support_case`** for `assignment_group`: `reference_qual_override = true`, qualifier `type=<Customer Service group type fixed sys_id>`.

Put it on the child table, never the parent. `sn_customerservice_case` already carries an override that sets `reference_qual_override = true` with an **empty** qualifier — deliberately discarding `task`'s inherited `type=null^ORtype=1cb8ab9bff500200158bffffffffff62^EQ` so regular cases accept any group. That behavior must survive.

### STRY0098984 · Clear Assigned to when Assignment group changes (1 pt) — set #6

Before-update business rule on the Support Case table, order 100:

```js
if (current.assignment_group.changes()) current.assigned_to = '';
```

Server-side deliberately, so it holds in native, workspace, and any future record producer — an onChange client script would only cover the form. An optional client script may be added for immediate feedback; the business rule remains the source of truth.

### STRY0098987 · Add resolution notes to comments always true (1 pt) — set #7

- `sys_dictionary_override` on the Support Case table for **`notes_to_comments`**: `default_value_override = true`, `default_value = true`.
- `sys_ui_policy` on the same table, condition `active = true ^ resolved_atISEMPTY`, action making the field **read-only and true**. Leave `view` empty and set `ui_type` to *All* so it applies in both Default and Workspace.

### STRY0098990 · Internal Aheadians are consumers (4 pts) — set #9 + data pack

Shared with 0098989 — build the shared piece once.

- **Script include `ClientAppsConsumerSync`** (Global): the `sys_user` → `csm_consumer` field map (`first_name`, `middle_name`, `last_name`, `email`, `mobile_phone`, `phone` → `business_phone`, `home_phone`, `active`) plus `createConsumerForUser(userGR)` and `syncConsumerFromUser(userGR)`. Reuse OOB `CSManagementUtils().getConsumerId()` for consumer lookup rather than re-deriving it.
- **Modify `global.Consumer`** — add `getConsumerUserReferenceQualifier()` overriding `ConsumerImpl`'s `sys_class_nameINcsm_consumer_user`, widening it to also admit internal `sys_user` records. This is the wrapper/Impl override point ServiceNow ships for exactly this purpose; it is still an OOB-script customization and will be flagged on upgrade — note it in the set description.
- **Business rule** on `sys_user_grmember`, after insert, on the *Internal Consumers* group → `createConsumerForUser`, guarded on the member holding `snc_internal` and not already having a consumer profile.
- **Data:** group **Internal Consumers** with role `sn_customerservice.unified_consumer`.

### STRY0098989 · User updates sync to consumer profile (2 pts) — set #10

After-update business rule on `sys_user`, filter condition on the 8 mapped fields changing **and** the user holding `snc_internal` (so it cannot fire across the whole user table), calling `syncConsumerFromUser`. Query `csm_consumer` by `user = current.sys_id`; no-op when no profile exists; `setWorkflow(false)` on the consumer update to prevent rule ping-pong.

---

## Build sequence

1. **Wave 0 — context.** `switch_dev_context` → `sn_customerservice`. Create Base A + its 7 children (`create_update_set` with `parent` set, or `batch_update_sets` after). Switch to `global`, create Base B + its 3 children. **Checkpoint: if the scope switch fails, stop.**
2. **Wave 1 — foundation.** STRY0098972 (table + case type + `other_category`), then STRY0098979 (data pack). **Checkpoint: confirm the real table name before Wave 2.**
3. **Wave 2 — UI.** 0098981 → 0098991 → 0098982 → 0098983.
4. **Wave 3 — behavior.** 0098980 → 0098984 → 0098987.
5. **Wave 4 — consumers.** Shared script include first, then 0098990, then 0098989.
6. **Wave 5 — 0098976 verification and evidence capture.**

---

## Verification

**Per wave:** `get_dev_context` before the first write; `get_update_set_contents` on both bases at the wave's end. Every artifact in a named child set, none in a Default set, none in the DEPRECATED scope, and each child set's application matching its bucket.

1. **Wave 1** — `sn_case_type` holds Support Case with `case_type_table` pointing at the new table, and the type appears under *Manage Case Types*; `sys_user_group_type` contains Customer Service at the fixed sys_id; all four groups exist with correct type and roles.
2. **Wave 2** — `sys_app_module` ordered by `order` shows the Support Cases block between 100 and 300 with all six entries; load each module and confirm the row set matches its filter; the workspace Lists page shows "Support Cases" between Cases and Case Task with all five lists; walk the AC's full field list on the form in **both** native and CSM/FSM workspace; confirm the seven columns in the stated order in both native and workspace lists.
3. **Wave 3** — on a Support Case: the assignment_group picker offers only Customer Service groups; set assigned_to, change the group, save, confirm assigned_to cleared (repeat in workspace); on an active unresolved case, "Add resolution notes to comments" is checked and read-only in both views.
4. **Wave 4** — add an `snc_internal` user to Internal Consumers → a `csm_consumer` appears with all 8 fields populated and `user` set; edit that user's mobile phone and last name → the consumer updates; on *Consumer → Create New*, a plain user record is selectable in the User field.
5. **Regression guard (required)** — a **regular** case (not a Support Case) still accepts non-CSM assignment groups and does **not** clear assigned_to; and a non-`snc_internal` user edit does not touch any consumer record. This is what catches a misplaced dictionary override or an over-broad business rule.
6. **Migration dry run** — export both bases plus `EPIC0012892-data-pack.xml` and confirm the data pack is genuinely required (the group type sys_id referenced by 0098980's qualifier must resolve in the target).

---

## Open items for the architect

- **0098982** — `other_category` is confirmed **not** OOB in CSM 28.0.29; we are creating it as a custom 100-char string. Confirm the intent (free text vs. a choice list, and the values).
- **0098979** — confirm the corrected spellings *Associate Account Coordinator* and *Client Apps Troubleshooting*.
- **0098981 vs 0098991** — the two "Unassigned" definitions differ by design in the ACs (any-empty in native vs. assigned_to-empty-plus-my-groups in workspace). Intentional, or should they match?
- **0098990** — modifying `global.Consumer` is the supported override point but is still an OOB-script customization carrying upgrade review. Confirm acceptable for the POC.
- **Scope** — building in `sn_customerservice` satisfies 0098972's AC but makes every artifact a store-app customization. Confirm this is the intended trade for a POC that may later be productionized.
