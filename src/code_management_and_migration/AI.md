# Code Management and Migration

Rules for making changes to `sys_metadata` ("Application File") records in ServiceNow through the
Table API, so that changes land in the right **application scope** and are captured in the right
**update set**.

Everything below was verified against the ServiceNow docs cached in the `sn_docs` folder in this
project and/or empirically against a live instance (`dev343967`, Australia release). Claims that are
platform behavior rather than documented contract are marked **[observed]**.

---

## 1. The record model

### Application File `[sys_metadata]`

The base table for everything the platform considers "code" — script includes, business rules,
client scripts, UI actions, ACLs, and so on all extend it.

| Field | Notes |
|---|---|
| `sys_scope` | Reference to `sys_scope`. The application scope the file belongs to. **This is the critical field.** Dictionary default is `gs.getCurrentApplicationId()`, which is why the caller's current app decides where a new file lands. |
| `sys_package` | Reference to `sys_package`. **Read-only in the dictionary** — the platform derives it. Never try to set it. |
| `sys_name` | Display name. |
| `sys_update_name` | The `<table>_<sys_id>` key used to identify the file in update sets. |
| `sys_policy` | Protection policy: empty, `read` (Read-only), or `protected`. |

How `sys_package` relates to `sys_scope`:

- **Scoped file** (`sys_scope` is a custom or store app): `sys_package` points at the same record.
  For a `sys_app`, both fields hold the identical sys_id. **[observed]**
- **Global file**: `sys_package` identifies the plugin or global application that delivered it —
  e.g. `OAuth 2.0`, `Password Reset`, `System (glidesoft)`. **[observed]**
- **Global scope *and* global package**: typically a legacy or non-baseline file. Still valid.

### Package `[sys_package]` and its extensions

Verified hierarchy (from `sys_db_object.super_class` on a live instance):

```
sys_package  (Package — base, no parent)
├── sys_scope           (Application)
│   ├── sys_app         (Custom Application)
│   └── sys_store_app   (Store Application)
├── sys_scoped_plugin   (Scoped Store Plugin)
└── sys_plugins         (Sys Plugins)
```

- `sys_plugins` is the plugin package table. There is **no** `sys_plugin` table. The list you see in
  the UI (*System Definition > Plugins*, and the *Add app install to current update set* related
  link) is the `v_plugin` view, labelled "System Plugin".
- `sys_scoped_plugin` — a scoped plugin delivered through the ServiceNow Store. Note it extends
  `sys_package` directly, **not** `sys_scope`.
- `sys_app` is simply the Custom Application table. It is *not* "the developer-mode table" —
  development mode is a state of a record, not a choice of table. A store app converted with
  *Convert to Development Mode* stays in `sys_store_app`.

### Global scope has a literal sys_id

The Global application record's `sys_id` is the **string `global`**, not a 32-character GUID.
Any code that builds a query or a preference name from a scope sys_id has to tolerate that.

---

## 2. Current application scope and current update set

These live in `sys_user_preference` as **per-user** rows (`system = false`, `type = string`,
`user` = the `sys_user` sys_id). They are per *user*, not per session or per connection — two
clients authenticated as the same account will overwrite each other's context.

| Preference name | Value | Meaning |
|---|---|---|
| `apps.current_app` | `sys_scope` sys_id | The user's currently selected application scope. A new `sys_metadata` file is created in this scope. Absent means global. |
| `sys_update_set` | `sys_update_set` sys_id | The user's current update set. Changes are captured here. |
| `updateSetForScope<scopeSysId>` | `sys_update_set` sys_id | The last update set the user selected *for that scope*. Note the format: the literal prefix followed by the raw sys_id, **no braces or separator** — e.g. `updateSetForScope4d00b21493dacf501fee36befaba107b`, and `updateSetForScopeglobal` for global. |

The three are consistent when things are healthy: `sys_update_set` equals
`updateSetForScope<apps.current_app>`, and that update set's `application` equals `apps.current_app`.

### Writing these preferences takes effect on the next REST call **[observed, verified]**

Setting `apps.current_app` through the Table API and then immediately inserting a `sys_metadata`
record puts the record in the new scope; setting `sys_update_set` likewise captures the change in
that set. Verified end to end on `dev343967`: after switching to `x_500909_tstclaude`, an inserted
`sys_script_include` came back with `sys_scope` and `sys_package` both set to that app, and a
matching `sys_update_xml` row appeared in the target update set.

This is platform behavior, not a documented API contract. It is the mechanism these tools rely on.

### `sys_update_set.application` cannot be set explicitly **[observed]**

Passing `application` when inserting into `sys_update_set` is **silently overridden** with the
caller's current app scope. To create an update set for scope X you must switch
`apps.current_app` to X *first*, then insert. There is no way to do it in one call.

### Changing scope moves the update set with it

Per the docs, switching application scope automatically switches the current update set to that
scope's default set. And a new default is auto-generated when:

- the default set for a scope is marked Complete or Ignore, or
- you change scope and your preferred set for the new scope is Complete/Ignore with no In-Progress
  default available.

So switching scope without also deciding the update set is not a no-op — you will silently land in
somebody's `Default` set. Always set both.

---

## 3. Update sets

`sys_update_set` fields that matter:

| Field | Notes |
|---|---|
| `name` | Mandatory. Use a naming convention; include the ticket number. |
| `application` | Mandatory, references `sys_scope`. Forced to the current scope on insert — see above. |
| `state` | `in progress` \| `complete` \| `ignore` |
| `is_default` | Only one default per scope. |
| `parent` | Writable. Set this to put the set in a batch. |
| `base_update_set` | "Batch Base". **Read-only** — the platform computes it from the parent chain. Never write it. |
| `merged_to`, `remote_sys_id`, `batch_install_plan`, `release_date`, `completed_on/by`, `origin_sys_id`, `installed_from` | Populated by platform processes. |

Changes are recorded as Customer Update `[sys_update_xml]` rows: `name` (the `sys_update_name`),
`type`, `target_name`, `action`, `payload`, `application`, and `update_set`.

### Rules

- **Complete is one-way.** Never move a Complete set back to In progress. Create another set and
  commit them in order.
- **Don't edit the Update Set field on a Customer Update record**, and don't delete `sys_update_xml`
  rows — deleting doesn't undo anything, destroys the audit trail, and causes the customization to
  be overwritten on upgrade.
- **Deleting an update set** is only possible when it isn't the current set and holds no
  `sys_update_xml` rows. To revert a change, back the set out rather than deleting it.
- **Wrong update set recovery**: switch to the desired set → modify the record (a trivial change is
  enough) → save → back out the trivial change → save. This puts the latest version of the object in
  the right set without duplicating updates.
- Keep sets small — one set per small or medium task. Large sets are slower to preview and commit
  and far more conflict-prone.

### What is *not* captured

- Tracking is governed by the `update_synch` dictionary attribute. Never add that attribute yourself.
- Special handlers bundle multi-table changes into one entry: workflows, form sections, lists,
  related lists, choice lists, dictionary entries, field labels. Some of these delete and reinsert
  records on commit.
- Home pages and content pages are excluded by default.
- Other gaps (per the Customer Updates table reference): cascading changes like display-name updates,
  unresolved cross-application metadata references, sys_id changes for coalescing files, Flow-generated
  `sys_documentation`, `ua_table_license_config` rows, and background jobs.
- Update sets don't track table removal, and skip data-type changes that would lose data.

---

## 4. Batched update sets

Batching groups update sets so they can be previewed and committed in bulk, and lets the platform
order the changes and detect conflicts by ancestry. The docs recommend it over the older Merge
feature (which is restricted to a single application).

- You batch a set by setting its **`parent`** to another update set. That is the only field you
  write; the platform fills in `base_update_set`.
- The hierarchy can be **multiple levels deep** — a set can be both a parent and a child. The set at
  the top with no parent is the batch base.
- **You cannot commit a child on its own.** Preview and commit the batch base, which processes the
  whole batch. To commit one separately, first remove it from the batch by clearing its `parent`.
- Adding an In-progress set to a batch that is marked Complete **flips the batch back to In
  progress**.
- Remove a set from a batch by clearing `parent`.
- Cloning: set only the parent to Ignore and leave the children Complete, to preserve the hierarchy.

Note: the docs frame batching as bulk preview/commit and ordering. They do not describe it as a
cross-scope bundling mechanism, and `application` is still per-set — treat cross-scope batching as
unverified.

---

## 5. Update sets vs. the Application Repository

**Do not use both for the same scoped application.** The docs are explicit: combining them "results
in skipped changes and commit errors." After installing an app from the Application Repository,
continue using the repository for that app's development and publishing.

| Use update sets for | Use the application repository for |
|---|---|
| Changes to the base system or an installed application | Installing and updating apps across company instances |
| Storing/applying a particular version of an application | Managing application update sets |
| Producing an XML file for export | Restricting app access within the company; deploying finished apps |

Update sets can only transfer a limited set of application files. For bulk data, use import sets.

Related concepts:

- **Convert to Development Mode** — makes an installed app publishable again. Controlled by
  `sn_appclient.store_app_convert_enabled`; the scope must match a key in
  `sn_appauthor.all_company_keys`. After converting, the app can no longer receive repository
  updates on that instance.
- **App Customization** `[sys_app_customization]` — how you customize an app owned by someone else
  (a Store app or scoped plugin). The customization package is authoritative and full-replacement:
  local `sys_update_xml` customizations are **not** honored.

---

## 6. Instance and transport constraints

- Role required for essentially all of this is **admin**. The update set picker is gated by
  `glide.ui.update_set_picker.role`.
- `glide.update_set.auto_preview` (default true) auto-previews retrieved update sets.
- **`sys_package` is not readable through the Table API** on a stock instance — it returns
  `403 Failed API level ACL Validation`. Get package information by dot-walking `sys_package.name`
  from `sys_metadata`, or read `sys_scope` instead. **[observed]**
- This MCP server's `execute_script` and other session tools are only registered when
  `SN_<INSTANCE>_USERNAME`/`PASSWORD` are configured; under an OAuth-only configuration they don't
  exist. Code-management tooling must therefore work through the Table API alone.
- Cross-instance migration is available through the CI/CD Update Set API
  (`/api/sn_cicd/update_set/{create,retrieve,preview,commit,commitMultiple,back_out}`) and the app
  repository endpoints (`/api/sn_cicd/app_repo/{publish,install,rollback}`). These need the
  `com.glide.continuousdelivery` plugin and the `sn_cicd.sys_ci_automation` role. Not yet wrapped by
  this server.

---

## 7. Working procedure

1. **Read the context first.** Before any write to a `sys_metadata`-derived table, check the current
   scope and update set, and confirm the update set's `application` matches the scope and its state
   is `in progress`.
2. **Switch deliberately.** If the target scope differs, set `apps.current_app`, `sys_update_set`,
   and `updateSetForScope<scopeSysId>` together — never scope alone.
3. **Prefer a named set over `Default`.** Landing changes in a scope's `Default` set is legal but
   makes the work untransportable as a unit. Reuse the set recorded in
   `updateSetForScope<scopeSysId>` when continuing existing work; create a named one otherwise.
4. **To create a set for another scope**, switch scope first, then insert.
5. **Complete when done**, and don't reopen.
