---
name: servicenow-mcp-development
description: Build ServiceNow artifacts through the Table API via MCP - form layouts, list layouts, related lists, UI policies, business rules, tables, and update sets. Use whenever creating or modifying sys_ui_form, sys_ui_section, sys_ui_element, sys_ui_list, sys_ui_related_list, sys_ui_policy, sys_dictionary, sys_db_object, or sys_update_set records on a ServiceNow instance, and before assuming a Table API write actually took effect.
---

# ServiceNow development via MCP

The Table API is the development API, but a meaningful set of artifacts do **not** behave like plain records. Writes can succeed with HTTP 200 and still be silently dropped, silently uncaptured, or silently overwritten later. Verify, never assume.

## The cardinal rule

**A 200 response is not proof of success.** After every write to the tables listed below, read the record back and confirm the field you set actually holds the value you sent. Three distinct failure modes produce a successful-looking response:

1. A field-level ACL drops one field (the rest of the record saves fine).
2. The record saves but is never captured into the update set.
3. The record saves but ServiceNow later auto-generates a competing record and binds to that one instead.

## Form layouts need FOUR tables, not two

This is the most common mistake. A form layout is:

```
sys_ui_form            one row per (table, view)          <- the form itself
  └─ sys_ui_form_section   join row, carries `position`   <- binds section to form
       └─ sys_ui_section    one row per section           <- the section
            └─ sys_ui_element   one row per field         <- fields, ordered by `position`
```

Creating `sys_ui_section` + `sys_ui_element` **alone renders nothing.** Without a `sys_ui_form_section` row pointing at it, a section is orphaned and the form ignores it entirely.

### Lazy materialization — the trap

For a brand-new table, **none** of `sys_ui_form`, `sys_ui_form_section`, or the default `sys_ui_section` rows exist until a human first opens that form in that view. ServiceNow materializes them on first view, copying the layout down from the parent table.

That creates a race:

- You create sections via MCP at T1.
- Someone opens the form at T2.
- ServiceNow generates its **own** full set of sections at T2 and binds `sys_ui_form_section` to those — not yours.
- Result: your correct sections sit orphaned; the form shows the inherited parent layout.

**Two safe orders of operation:**

*Preferred — let the platform create the skeleton first:*
1. Open the form once in each target view in the UI (or accept that it has already happened).
2. Query `sys_ui_form` for `name=<table>` to get the form per view.
3. Query `sys_ui_form_section` for those forms to get the auto-created sections.
4. Rewrite the auto-created `sys_ui_section` captions and replace their `sys_ui_element` rows in place.

*Alternative — build everything yourself:*
1. Create `sys_ui_form` per (table, view).
2. Create your `sys_ui_section` rows.
3. Create `sys_ui_form_section` rows binding them, with explicit `position`.
4. Create `sys_ui_element` rows.

*Recovery if the race already happened:* repoint each `sys_ui_form_section.sys_ui_section` at your section, **then** delete the orphaned auto-created sections. Repoint first — `sys_ui_form_section.sys_ui_section` has a delete cascade, so deleting a bound section takes its binding row with it.

### Section element conventions

Two-column layout uses sentinel elements where `element` and `type` hold the same literal:

| position | element | type | meaning |
| --- | --- | --- | --- |
| 0 | `.begin_split` | `.begin_split` | start two-column |
| … | field names | *(empty)* | left column |
| n | `.split` | `.split` | switch to right column |
| … | field names | *(empty)* | right column |
| n | `.end_split` | `.end_split` | end two-column |
| … | field names | *(empty)* | full width |

Formatters use `type = formatter` with `element` set to the formatter name (e.g. `activity.xml`).

The `view` field on `sys_ui_section` / `sys_ui_list` / `sys_ui_related_list` holds the **literal string `Default view`** for the default view, or a `sys_ui_view` sys_id for any named view. It is not a normal reference.

## Update-set capture: `update_synch` vs `update_synch_custom`

Whether a Table API write is captured is decided by the table's `attributes` on its `sys_dictionary` collection row (the row where `name=<table>` and `element` is empty).

| Attribute | Captured via Table API? |
| --- | --- |
| `update_synch=true` | **Yes.** e.g. `sys_app_module`, `sys_ui_policy`, `sys_script`, `sys_dictionary`, `sys_dictionary_override`, `sys_db_object` |
| `update_synch_custom=true` | **No.** e.g. `sys_ui_section`, `sys_ui_list`, `sys_ui_related_list` — these capture only when saved through their designer UI |
| *(neither)* | Never directly — they travel inside the parent's payload. e.g. `sys_ui_element`, `sys_ui_list_element`, `sys_ui_related_list_entry` |

Check before you build:

```
query_data sys_dictionary  encodedQuery: name=<table>^elementISEMPTY  fields: name,attributes
```

For `update_synch_custom` tables, either (a) have someone open the relevant designer and hit Save once to force capture, or (b) ship those records in a separate XML export. Verify capture with:

```
query_data sys_update_xml  encodedQuery: nameLIKE<table_or_record>
```

An empty result means it did not capture, no matter how clean the insert looked.

## Field-level ACLs that admin cannot override

Some fields carry ACLs with `admin_overrides = false` and no permissive counterpart. The Table API drops the field silently — the record inserts, the field is empty, and a follow-up update is a no-op (`sys_mod_count` stays 0).

Known: **`sys_ui_policy_action.ui_policy`** (both `create` and `write`). You cannot create a working UI policy action via the Table API. Put the behavior in the UI policy's `script_true` / `script_false` instead:

```js
// script_true
function onCondition() {
    g_form.setValue('my_field', true);
    g_form.setReadOnly('my_field', true);
}
// script_false
function onCondition() {
    g_form.setReadOnly('my_field', false);
}
```

To check whether a blocked field is a genuine denial or just the harmless "UserIsAuthenticated" attribute ACL:

```
query_data sys_security_acl  encodedQuery: name=<table>.<field>^ORname=<table>  fields: name,operation,admin_overrides,description
```

A denial matters only when there is **no** sibling ACL with `admin_overrides=true` for the same name+operation. Tables like `sys_ui_section` and `sys_ui_form` show `admin_overrides=false` rows that are only the authenticated-user attribute check — they have permissive counterparts and are writable.

## Table and field creation gotchas

- **New tables default to no cross-scope access.** `sys_db_object` inserts land with `create_access` / `update_access` / `delete_access` = false. If anything outside the scope must write to the table, set them to match the parent table explicitly after insert.
- **Custom columns get auto-prefixed.** Adding a field to a table rooted in a global hierarchy (e.g. anything extending `task`) renames `my_field` to `u_my_field`. Read the insert response and use the returned `element` value everywhere downstream — never assume the name you sent.
- **A child table inherits the parent's numbering** unless you add a `sys_number` row keyed to the child table.
- **`sys_script.name` is 40 characters.** Longer names truncate silently.
- Creating a table via `sys_db_object` insert works and does create the physical table; confirm with `get_table_schema` and a `get_record_count`.

## Update sets

- **An update set belongs to exactly one application.** The platform forces a new set's application to the caller's current scope and ignores any value you send. Artifacts spanning scopes need one batch base per scope.
- `create_update_set` with a `parent` batches automatically; `base_update_set` is derived, never written.
- Call `get_dev_context` before the first write of each unit of work, and `switch_dev_context` to the specific child set before building that story.
- Close each unit with `get_update_set_contents` on the base and reconcile the change count against what you built. A missing artifact type is the signal for the `update_synch_custom` problem above.

## Quick verification checklist

After any batch of writes:

1. Read back one record per table you touched; confirm reference fields are populated, not empty.
2. `get_update_set_contents` on the base; count changes by type against expectation.
3. For layouts, query `sys_ui_form_section` joined to your sections and confirm the form points at *your* rows.
4. For anything ACL-suspect, confirm `sys_mod_count` incremented after an update.
