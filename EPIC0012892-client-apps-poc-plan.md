# EPIC0012892 "Client Apps POC" — build plan for dev343967

> **Status:** planning document only. Nothing here has been executed — dev343967 and ahead.service-now.com have only been read.

## Context

An architect handed over EPIC0012892 (**Client Apps POC**, product = Customer Service Management, state = Work in progress) on ahead.service-now.com. The goal is a POC for the Client Apps support teams: a dedicated **Support Case** type on the CSM case table, with its own groups, left-nav, workspace lists, form/list views, assignment behavior, and an internal-employee-as-consumer model.

The epic has 21 stories; **12 are non-draft** and in scope here. The 9 drafts (submitter/fulfiller notifications, SLAs, record producer, inbound email → interaction, auto-close, action status, needs-attention on reply, case-from-interaction) are out of scope — most have `description = "x"` and empty acceptance criteria.

Story states on ahead (Peer Review / Work in Progress) do **not** reflect reality: nothing has been built in dev343967. Everything below is green-field, confirmed by recon — no custom scope, group type, field, or artifact related to this epic exists there.

**Target instance:** dev343967 — ServiceNow **Zurich** (`glide-zurich-07-01-2025__patch10-05-22-2026`), Customer Service `sn_customerservice` **28.0.29**.

### Stories in scope

| Story | Title | Pts | State on ahead |
| --- | --- | --- | --- |
| STRY0098976 | Enable Customer Service with Plugins | 1 | Peer Review |
| STRY0098972 | Support Case Type | 2 | Peer Review |
| STRY0098979 | Create Customer Service Groups | 1 | Peer Review |
| STRY0098981 | Set Up Support Case Left Nav | 1 | Ready |
| STRY0098991 | Add Support Case to CSM/FSM Workspace list | 1 | Peer Review |
| STRY0098982 | Update Support Case form views | 2 | Peer Review |
| STRY0098983 | Update Case list views | 1 | Peer Review |
| STRY0098980 | Only customer service groups selectable on support cases | 1 | Peer Review |
| STRY0098984 | Clear assigned to when assignment group changes | 1 | Peer Review |
| STRY0098987 | Add resolution notes to comments always true | 1 | Peer Review |
| STRY0098990 | Internal Aheadians are consumers | 4 | Work in Progress |
| STRY0098989 | User record updates sync to consumer profile | 2 | Ready |

---

## Environment truth (verified in dev343967)

What's already there:

| Present | Detail |
| --- | --- |
| Customer Service | `sn_customerservice` 28.0.29 — `sn_customerservice_case` extends `task` |
| CSM Configurable Workspace | `sn_csm_wrkspc` 25.2.6 + `sn_cwf_wrkspc` 25.2.19; app config `f224e5a3530210102c30ddeeff7b128d` |
| All required roles | `sn_customerservice.consumer_agent`, `sn_customerservice_manager`, `sn_customerservice.unified_consumer`, `snc_internal` |
| Consumer model | `csm_consumer` with a **`user` → `sys_user`** reference, and all 8 sync fields (`first_name`, `middle_name`, `last_name`, `email`, `mobile_phone`, `business_phone`, `home_phone`, `active`) |
| Native left nav | Customer Service menu `99e97177c342310015519f2974d3aebd` — "Cases" separator at order 100 (modules 120–170), "Escalations" separator at order 300 |
| Escalations | `sn_customerservice_escalation`, and `sn_customerservice_case.active_escalation` |

**Gaps that block stories** — the critical path:

| Missing | Blocks |
| --- | --- |
| `sn_csm_case_types` (Case Types) | STRY0098972 and, transitively, every Support Case UI/behavior story |
| `com.snc.csm_action_status` | `action_status` field on the form (0098982) and list (0098983) |
| `com.sn_cs_sm` (CS with Service Management) | Related Records: Incident / Problem / Change / Caused by change (0098982); `add_resolution_notes_to_comments` (0098987) |
| `com.sn_cs_sm_request` (CS with Request Management) | plugin-list AC only (0098976) |
| `sn_csm_gen_ai` (Now Assist for CSM) | plugin-list AC only — **may be licence-gated on this PDI** |
| **No "Customer Service" group type** — `sys_user_group_type` contains only `itil` | 0098979 (groups must have Type = Customer Service) and 0098980 (qualifier filters on that type) |
| Fields `action_status`, `needs_attention`, `add_resolution_notes_to_comments`, `other_category` don't exist on `task` or `sn_customerservice_case` | 0098982, 0098983, 0098987 |

---

## Prerequisite (manual — cannot be done via MCP)

Plugin activation is not a Table API write, and `sys_plugins` / `sys_store_app` are ACL-blocked for the integration user. **Activate these in the UI** (All → System Applications → All Available Applications, or System Definition → Plugins) before Wave 1:

`sn_csm_case_types` · `com.snc.csm_action_status` · `com.sn_cs_sm` · `com.sn_cs_sm_request` · `sn_csm_gen_ai`

Then re-run discovery to map what the Case Types plugin actually installs in Zurich — its definition table, and whether the Case Type Builder mints a child table of `sn_customerservice_case` or a filtered configuration of it. **That answer changes where roughly half the remaining work lands**, so treat it as a checkpoint, not a formality. If Now Assist is licence-blocked, record it as an environment limitation against 0098976 rather than chasing it.

## Scope and update-set strategy

Build in the **Customer Service scope** — `sn_customerservice`, sys_scope `51d811fad7223100b7490ee60e61034f`. `can_edit_in_studio = false` only means the app can't be edited in Studio or published through the app repo; configuration and new artifacts can still be created in that scope, are tracked as customizations, and **migrate by update set export/import**.

1. `switch_dev_context` → scope `sn_customerservice`. Current context is the **DEPRECATED** scope on the **Default** update set and must be corrected before the first write.
2. `create_update_set` with `scope: sn_customerservice` → base **"Client Apps POC – EPIC0012892"**, so the set's application matches the current scope.
3. One child set per story, `EPIC0012892 – STRY00989xx – <short description>`, batched under the base with `batch_update_sets` — batching beats merging, since the platform orders and conflict-checks by ancestry.
4. `get_dev_context` before each wave's first write; `get_update_set_contents` at each wave's end.

Three things to keep an eye on:

- **Upgrade exposure.** Records created in a store app's scope are customizations. On a CSM upgrade, review skipped/conflicting records — this is the cost of building in-scope rather than in a separate app, and it's the right trade for a POC.
- **The Support Case table's scope** may be forced by the Case Type Builder rather than chosen. Settled at the Wave 0 checkpoint.
- **Workspace records.** `sys_ux_*` artifacts reference the `sn_cwf_wrkspc` config. Verify they can be created from the `sn_customerservice` scope; if application access blocks it, those specific records go in Global and are noted in the update set.
- **Data vs. metadata.** `sys_user_group_type`, `sys_user_group`, `sys_group_has_role`, and `csm_consumer` records are data, not scope-stamped metadata — they will **not** travel in the update set. Plan a separate path (manual re-creation or XML export) for the next environment.

---

## Build sequence

### Wave 1 — Foundation

**STRY0098976 · Enable Customer Service with Plugins** (1 pt) — verification-only once the prerequisite is done. Re-query `sys_scope` per scope and confirm the new fields exist on the case table. Record any licence-blocked plugin.

**STRY0098972 · Support Case Type** (2 pts) — create the **Support Case** case type through Customer Service → Case Types → Manage Case Types. The builder is UI-driven; drive the resulting records via MCP where possible and hand back UI steps where not. Deliverable: a Support Case type usable from the case-type selector, plus its table. The AC's "defined within the Customer Service scope" is satisfied directly by the scope strategy above.

**STRY0098979 · Create Customer Service Groups** (1 pt) — order matters:

1. Insert the **`Customer Service` group type** into `sys_user_group_type` — check first whether a Wave 0 plugin added it.
2. Insert four `sys_user_group` records with `type` set to that group type:
   - Client Apps Order Management, Associate Account Coordinator, Client Apps Troubleshooting → role `sn_customerservice.consumer_agent`
   - Client Apps Managers → role `sn_customerservice_manager`
3. Grant roles via `sys_group_has_role`.

*Note:* the AC spells these "Assocaite Account Coordinator" and "Client Apps Troubbleshooting." Use the corrected spellings and flag it — group names are referenced by 0098980's qualifier and by demo scripts, so a typo baked in now is expensive later.

### Wave 2 — UI configuration

**STRY0098981 · Support Case Left Nav** (1 pt) — insert into `sys_app_module` against menu `99e97177c342310015519f2974d3aebd`: a `SEPARATOR` "Support Cases" at **order 200** (between Cases@100 and Escalations@300), then modules 210–260. Reuse the filters already proven on the OOB Cases modules:

| Module | order | link_type | filter |
| --- | --- | --- | --- |
| Create New | 210 | DIRECT (new record) | — |
| My Cases | 220 | LIST | `active=true^assigned_to=javascript:getMyAssignments()^EQ` |
| All | 230 | LIST | *(none)* |
| Open | 240 | LIST | `active=true^state=10^EQ` |
| Unassigned | 250 | LIST | `active=true^assigned_toISEMPTY^ORassignment_groupISEMPTY^EQ` |
| Escalated | 260 | LIST | `active=true^active_escalationISNOTEMPTY^EQ` |

`name` = the Support Case table from Wave 1. "Unassigned" here is *assigned_to OR assignment_group empty* per its AC — broader than the OOB Cases version.

**STRY0098991 · Support Case in CSM/FSM Workspace Lists** (1 pt) — first query `sys_ux_list_category` (fields `title`, `order`, `configuration`) against the CSM/FSM app config to read the Cases and Case Tasks category orders, then insert a "Support Cases" `sys_ux_list_category` between them plus five `sys_ux_list` records: My Cases, Open, **Unassigned from my groups** (`assigned_toISEMPTY` + group membership), Escalated, All.

**STRY0098982 · Support Case form views** (2 pts) — build `sys_ui_section` / `sys_ui_element` for both the **Default view** (native) and the **Workspace view**, following the existing CSM pattern (Default view already has Notes / Related Records / Closure Information; Workspace view sections are owned by `sn_csm_workspace`). Sections: Main (two columns plus full-width short_description/description), Notes, Related Records, Closure Information. Related lists via `sys_ui_related_list`: Task SLAs, Case Tasks, Escalations, Child Cases, Blocked By, Attached Knowledge, Knowledge Gaps, Emails, Attachments, Interactions.

Two fields need resolution before this closes: `needs_attention` and `other_category`. Confirm they arrive with the Wave 0 plugins; if not, they're new custom fields — raise it rather than inventing them.

**STRY0098983 · Case list views** (1 pt) — `sys_ui_list` / `sys_ui_list_element` default view on the Support Case table: Number, State, Action Status, Priority, Short Description, Consumer, Assigned to. Mirror the same column set on the Wave-2 workspace lists so native and workspace match, which is the story's actual point.

### Wave 3 — Behavior

**STRY0098980 · Only Customer Service groups selectable** (1 pt) — `sys_dictionary_override` on the **Support Case table** for `assignment_group`, `reference_qual_override = true`, qualifier `type=<Customer Service group type sys_id>`. Put it on the child table, not the parent: CSM already ships an override on `sn_customerservice_case.assignment_group` that deliberately clears the inherited `task` qualifier (`type=null^ORtype=1cb8ab9bff500200158bffffffffff62^EQ`), and regular cases must keep that behavior.

**STRY0098984 · Clear Assigned to when Assignment group changes** (1 pt) — a **before-update business rule** on the Support Case table: `if (current.assignment_group.changes()) current.assigned_to = '';`. Server-side deliberately, so it holds in native, workspace, and any future record producer — an onChange client script alone would only cover the form. Optionally add the client script too for immediate feedback; the BR is the source of truth.

**STRY0098987 · Add resolution notes to comments always true** (1 pt) — dictionary override setting the field's default to `true`, plus a **UI policy** making it read-only (and true) when `active = true` and `resolved_at` is empty, applied to Default and Workspace views. Depends on `com.sn_cs_sm` having added the field.

### Wave 4 — Internal consumers

The riskiest pair; they share logic, so build the shared piece once.

**Shared:** one script include `ClientAppsConsumerSync` holding the sys_user → csm_consumer field map (`first_name`, `middle_name`, `last_name`, `email`, `mobile_phone`, `phone` → `business_phone`, `home_phone`, `active`) and both `createConsumerForUser(userGR)` and `syncConsumerFromUser(userGR)`. Both business rules call it. Reuse the OOB `CSManagementUtils().getConsumerId()` and `UserProfileUtil` rather than re-deriving consumer lookup.

**STRY0098990 · Internal Aheadians are consumers** (4 pts):

1. Create group **Internal Consumers** with role `sn_customerservice.unified_consumer`.
2. After-insert business rule on `sys_user_grmember` for that group → `createConsumerForUser`, guarded on the member having `snc_internal` and not already having a consumer profile.
3. Make user records selectable on the Consumer form. `csm_consumer.user` currently carries `javascript:new Consumer().getConsumerUserReferenceQualifier()`. **Read that script include first** — if it keys off the unified-consumer model, configure it; fall back to a dictionary override of the qualifier only if there's no supported hook. No `sn_customerservice.*unified_consumer*` property exists on this instance, so a code-level override is the likely outcome, but confirm before writing.

**STRY0098989 · User updates sync to consumer profile** (2 pts) — after-update business rule on `sys_user`, condition on the 8 mapped fields changing, calling `syncConsumerFromUser`. Query `csm_consumer` by `user = current.sys_id`; no-op when no profile exists. Use `setWorkflow(false)` on the consumer update to avoid rule ping-pong, and scope the rule to `snc_internal` users so it can't fire across the whole user table.

---

## Verification

Per wave, then end to end:

1. **Context hygiene** — `get_dev_context` before writes; `get_update_set_contents` on the base at each wave's end. Every artifact in a named child set, none in Default, none in the DEPRECATED scope.
2. **Wave 1** — query `sys_user_group_type` for Customer Service; `sys_user_group` + `sys_group_has_role` for the four groups and their roles; confirm the Support Case type appears under Manage Case Types.
3. **Wave 2** — query `sys_app_module` ordered by `order`, confirm the Support Cases block sits between 100 and 300 with all six entries; load each module in the UI and confirm the row set matches its filter; open the Support Case form in native and in CSM/FSM workspace and walk the AC's section/field list; confirm the Lists page shows the new category between Cases and Case Tasks.
4. **Wave 3** — create a Support Case: the assignment_group picker shows only Customer Service groups; set assigned_to, change the group, save, confirm assigned_to cleared (repeat in workspace); confirm "Add resolution notes to comments" is checked and read-only on an active unresolved case.
5. **Wave 4** — add an `snc_internal` user to Internal Consumers, confirm a `csm_consumer` appears with all 8 fields populated and `user` set; edit that user's mobile phone and last name and confirm the consumer updates; confirm a user record is selectable on Consumer → Create New.
6. **Regression guard** — confirm a *regular* case (not Support Case) still allows non-CSM assignment groups and does not clear assigned_to. This catches a misplaced dictionary override or an over-broad business rule.

## Open items for the architect

- **0098982** — are `needs_attention` and `other_category` OOB in this CSM version, or new custom fields?
- **0098979** — confirm the corrected group spellings (Associate Account Coordinator, Client Apps Troubleshooting).
- **0098981 vs 0098991** — the two "Unassigned" definitions differ (any-empty in native vs. assigned_to-empty-plus-my-groups in workspace). Intentional, or should they match?
- **0098976** — acceptable to close with Now Assist for CSM unavailable if it's licence-gated on this PDI?
