# Considerations for Development via MCP

Running log of ServiceNow platform behaviors that make Table-API-driven development differ from clicking through the UI. Each entry records what was observed, how it was verified, the workaround used, and whether it is worth raising with ServiceNow.

**Instance where these were observed:** dev343967 — Zurich (`glide-zurich-07-01-2025__patch10-05-22-2026`), Customer Service `sn_customerservice` 28.0.29.

> Append new findings to the end. Keep the "verified by" line — the value of this file is that every claim is reproducible.

---

## 1. `sys_ui_policy_action.ui_policy` is blocked by a Deny-Unless ACL that admin cannot override

**Observed 2026-08-24 · EPIC0012892 STRY0098987**

Inserting a `sys_ui_policy_action` with `ui_policy` set returns HTTP 200 and a complete record — but `ui_policy` comes back **empty**. A follow-up `update_record` setting only that field is a silent no-op: `sys_mod_count` stays at 0 and `sys_updated_on` does not move. The result is an orphaned action record that does nothing.

**Root cause.** `sys_security_acl` holds field-level ACLs on `sys_ui_policy_action.ui_policy` for both `create` and `write`, each with `admin_overrides = false`, and there is no permissive sibling granting the admin role. So the field is denied even for a full admin over the Table API.

```
query_data sys_security_acl
  encodedQuery: name=sys_ui_policy_action.ui_policy
  fields: name,operation,admin_overrides
→ create / admin_overrides=false
→ write  / admin_overrides=false
```

The same pattern exists on `sys_ui_policy_rl_action.ui_policy`.

**Why this is odd.** These are not the generic "UserIsAuthenticated" attribute ACLs that appear across `sys_ui_*` (those always ship a permissive `admin_overrides=true` counterpart and are harmless). These two are genuine denials with no counterpart, and they block a completely ordinary parent-child insert. Nothing in the UI is protected by this — the Form Designer sets the field happily. It reads like the field is meant to be populated only from the UI policy form's parent context, and the Table API path was never considered.

**Workaround adopted.** Put the behavior in the UI policy itself rather than an action record. `sys_ui_policy` has `run_scripts`, `script_true`, and `script_false`, all writable, all captured in update sets:

```js
// script_true
function onCondition() {
    g_form.setValue('notes_to_comments', true);
    g_form.setReadOnly('notes_to_comments', true);
}
// script_false
function onCondition() {
    g_form.setReadOnly('notes_to_comments', false);
}
```

Functionally equivalent to a read-only action plus a default, and it works in both the classic UI and Configurable Workspace when `ui_type = All` and `global = true`.

**Cost of the workaround.** Behavior lives in script rather than a declarative action, so it is less visible to someone reading the UI Policy Actions related list. Worth a comment on the policy record.

**Open with ServiceNow?** Yes — worth asking whether the Deny-Unless on this field is intentional or vestigial. If intentional, the Table API should reject the write rather than silently discarding the field.

---

## 2. Form and list layouts are lazily materialized — and the platform will overwrite your work

**Observed 2026-08-24 · EPIC0012892 STRY0098982 / STRY0098983**

For a newly created table, `sys_ui_form`, `sys_ui_form_section`, and the default `sys_ui_section` rows **do not exist** until a human opens that form in that view for the first time. Same for `sys_ui_list` on the list view. ServiceNow generates them on first view by copying the layout down from the parent table.

This produces a genuine race when building via MCP:

| Time | Event |
| --- | --- |
| 18:44–18:57 | Sections + elements created via MCP (sys_ids `933acb50…`) |
| 19:33 | A user opens the Support Case form |
| 19:33 | ServiceNow generates its **own** complete set of sections (`937acb50…`) **plus** the `sys_ui_form` and `sys_ui_form_section` rows, and binds the form to *its* sections |

Net effect: the MCP-built sections were correct but orphaned — no `sys_ui_form_section` row referenced them — so the form rendered the inherited parent layout instead. Nothing errored; the layout was simply wrong.

**The structural point that caused it.** A form layout is four tables, not two:

```
sys_ui_form  →  sys_ui_form_section (position)  →  sys_ui_section  →  sys_ui_element
```

Creating `sys_ui_section` + `sys_ui_element` without a `sys_ui_form_section` binding row renders nothing, regardless of the `position` value on the section itself.

**Recovery used.** Repointed each `sys_ui_form_section.sys_ui_section` at the MCP-built section, **then** deleted the orphaned auto-generated sections. Order matters: `sys_ui_form_section.sys_ui_section` carries a delete cascade, so deleting a still-bound section destroys its binding row too.

**Going forward.** Either open the form once in each target view before building (so the skeleton exists and you edit in place), or create all four record types yourself in dependency order. Documented in `.claude/skills/servicenow-mcp-development/SKILL.md`.

---

## 3. `update_synch_custom` tables are not captured by Table API writes

**Observed 2026-08-24 · EPIC0012892 STRY0098982 / STRY0098983**

Update-set capture is governed by the `attributes` field on a table's `sys_dictionary` collection row (`name=<table>^elementISEMPTY`):

| Attribute | Captured via Table API? | Examples |
| --- | --- | --- |
| `update_synch=true` | **Yes** | `sys_app_module`, `sys_ui_policy`, `sys_script`, `sys_dictionary`, `sys_dictionary_override`, `sys_db_object`, `sn_case_type` |
| `update_synch_custom=true` | **No** | `sys_ui_section`, `sys_ui_list`, `sys_ui_related_list` |
| *(neither)* | Never directly — travel inside the parent payload | `sys_ui_element`, `sys_ui_list_element`, `sys_ui_related_list_entry` |

**Verified by:** a `sys_ui_list` insert produced no `sys_update_xml` row; a subsequent `update_record` on the same record also produced none; a `sys_ui_section` insert produced none. Instance-wide there were **zero** "List" captures and exactly **one** "Form Layout" capture — and that one was made through the Form Designer UI, not the API.

**Consequence.** Layout work is buildable via MCP and functions correctly in the instance, but will not migrate. Either have someone open the relevant designer (Form Layout / List Layout / Related Lists) and hit Save once to force capture, or ship those records as a separate XML export.

**Check before building:**
```
query_data sys_dictionary  encodedQuery: name=<table>^elementISEMPTY  fields: name,attributes
```
**Confirm capture after building:**
```
query_data sys_update_xml  encodedQuery: nameLIKE<record_or_table>
```

---

## 4. An update set belongs to exactly one application scope

**Observed 2026-08-24 · EPIC0012892 update-set design**

ServiceNow forces a new update set's `application` to the caller's **current scope** and ignores any value sent for it. `switch_dev_context` correspondingly refuses an update set belonging to a different scope.

**Consequence for planning.** A "one child update set per story" structure is not achievable as a single batch when stories span scopes. EPIC0012892 needed two batch bases — one for `sn_customerservice`, one for `global` — because three stories touch `global.Consumer`, `sys_user`, `sys_user_grmember`, and `sys_ux_list*`.

Batching itself works cleanly: `create_update_set` with a `parent` sets `base_update_set` automatically, and it is derived rather than written.

---

## 5. Assorted smaller behaviors worth knowing

**Observed 2026-08-24**

- **New tables default to closed cross-scope access.** A `sys_db_object` insert lands with `create_access` / `update_access` / `delete_access` = `false`. If anything outside the scope needs to write, set them explicitly after insert (match the parent table). Easy to miss because reads still work.
- **Custom columns are silently renamed with a `u_` prefix** when added to a table rooted in a global hierarchy. `other_category` became `u_other_category`. Always read the `element` value back from the insert response rather than assuming the name you sent.
- **`sys_script.name` truncates at 40 characters** with no warning.
- **The `view` field on `sys_ui_section` / `sys_ui_list` / `sys_ui_related_list` is not a normal reference.** It holds the literal string `Default view` for the default view, or a `sys_ui_view` sys_id otherwise.
- **`sys_store_app` is ACL-blocked for the integration user**, so `get_application_scopes` fails with 403. Query `sys_scope` directly instead.
- **Store-app scopes are writable via MCP** even when `can_edit_in_studio = false`. `switch_dev_context` to `sn_customerservice` succeeded with `ready_to_write: true`. Studio editing and app-repo publishing are blocked; Table API development and update-set export are not.
- **Data vs. metadata.** `sys_user_group_type`, `sys_user_group`, `sys_group_has_role`, and `csm_consumer` are data — they are not scope-stamped and will never appear in an update set. Plan an XML export path. Where a data record's sys_id is referenced by metadata (e.g. a reference qualifier filtering on a group type), **assign that record a fixed sys_id at creation** so the reference stays portable.

---

## Template for new entries

```
## N. Short statement of the behavior

**Observed YYYY-MM-DD · <context>**

What happened, concretely.

**Root cause / verified by:** the query or test that proves it.

**Workaround adopted.**

**Open with ServiceNow?** yes/no and why.
```
