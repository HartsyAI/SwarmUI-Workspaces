![Workspaces for SwarmUI](docs/images/banner.png)

Save your whole Generate tab as a named **workspace**, then switch between complete setups in one click. A preset sets only the parameters you tick and stacks on what you have; a workspace replaces everything: every value, each on/off switch, each group switch, and which presets are active.

## Install

In SwarmUI, open **Server > Extensions**, find **Workspaces**, click **Install**, and restart SwarmUI.

## Use it

A toolbar sits at the top of the Generate tab's parameter list. The **?** beside it explains every control.

1. Set up the Generate tab, click **Save**, and give it a name.
2. Change something and a **Modified** marker appears. **Save** (or **Shift+S**) keeps the change. Picking another workspace, or **More > Reload Saved Version**, throws it away after asking.
3. **More > Save As New Workspace** makes a variation and leaves the original untouched.
4. Switch with the dropdown. **More > Star Workspace** lists your favorites first.
5. **More > Load Part of Workspace** applies only the parts you tick (the model, the presets, any group) and leaves everything else as it is.

   <img src="docs/images/load-part.png" alt="Load Part dialog" width="300">

6. Closed the tab by accident? Unsaved changes are kept on the server, and a notice offers to **Restore** or **Discard** them.

   <img src="docs/images/recovery.png" alt="Recovery notice" width="420">

The toolbar uses SwarmUI's own controls, so it follows your theme.

## What is saved

Every parameter value (including ones switched off), each parameter's and group's on/off switch, and the active presets in order. Not saved: image, audio and video inputs, custom Comfy workflows, prompt attachments, and image editor state. A random seed (-1) stays random.

Loading checks everything first and never reports success when something was skipped. It refuses (changing nothing) if a custom workflow, init image, mask or the image editor is in use, or if the saved model is missing. A changed or missing preset asks before continuing. If a load fails part-way, your previous settings are put back.

## Limits and data

- Per user: 200 workspaces, 256 KB each, 4 MB in total, names up to 100 characters (plain text only). The permission is "[Workspaces] Manage Workspaces", which users have by default.
- Workspaces are stored in each user's own data on the SwarmUI server. An account can only ever see its own, and nothing is shared or sent anywhere else. Anyone who can read SwarmUI's database (a server admin) can read them, as with all account data.
- Unsaved-change drafts, which include your prompts, are stored the same way, one per workspace, for up to 14 days. Nothing is kept in your browser.
- With `--no_persist`, nothing can be saved, and saving says so.

## API

Everything the toolbar does goes through these routes, so scripts and bots can do it too. They follow SwarmUI's API conventions: `POST /API/<Route>` with a JSON body that includes `session_id`. All need the "[Workspaces] Manage Workspaces" permission and only ever see the caller's own workspaces. Failures return `error` and a stable `error_id`.

| Route | What it does | Body |
| --- | --- | --- |
| `WorkspacesList` | List workspaces (summaries). | `snapshots` (bool) to include snapshots |
| `WorkspacesGet` | One workspace with its snapshot. | `id` |
| `WorkspacesCreate` | Create one. | `name`, `snapshot`, optional `starred` |
| `WorkspacesUpdate` | Replace the snapshot (and optionally the name). | `id`, `revision`, `snapshot`, optional `name` |
| `WorkspacesRename` | Rename. | `id`, `revision`, `name` |
| `WorkspacesStar` | Star or unstar. | `id`, `revision`, `starred` |
| `WorkspacesDelete` | Delete it and its draft. | `id`, `revision` |
| `WorkspacesResolve` | Check a workspace (or its draft) against this server and return what to apply. | `id`, optional `draft` (bool), optional `parts` |
| `WorkspacesDraftSave` | Save a workspace's unsaved changes. | `id`, `revision`, `snapshot` |
| `WorkspacesDraftList` / `Get` / `Delete` | List, read, or delete drafts. | `id` (Get and Delete) |

A snapshot is `{ "schemaVersion": 1, "values": { "steps": { "value": 30, "enabled": true } }, "groups": { "refineupscale": { "enabled": false } }, "presets": [ { "title": "Sharp" } ], "unsupported": [] }`. Updates, renames, stars and deletes need the `revision` you last saw, so a change made somewhere else is never overwritten. Presets must exist; the server records their current definition.

**Resolve** is where the work happens. It checks every value with SwarmUI's own parameter validation and returns: `values` and `groups` to apply, `presets` with a status each (`ok`, `changed`, `missing`, `unverified`), `skipped` (anything unusable, with the reason), `params` (enabled values only, normalized), and `parts` (what the workspace contains). Pass `parts` as `{ "model": true, "presets": false, "other": false, "groups": ["coreparameters"] }` to take only some parts; leave it out for everything.

To generate with a workspace, send `params` and the preset titles to `GenerateText2Image`:

```
POST /API/WorkspacesResolve   { "session_id": "...", "id": "..." }
POST /API/GenerateText2Image  { "session_id": "...", "images": 1, ...params, "presets": [ "Sharp" ] }
```

Error IDs: `not_found`, `revision_conflict` (with `current_revision`), `invalid_name`, `invalid_snapshot`, `unsupported_schema`, `snapshot_too_large`, `quota_exceeded`, `invalid_revision`, `invalid_parts`, `no_draft`, `storage_disabled`, `storage_failed`.

## License

MIT. See [LICENSE](LICENSE).
