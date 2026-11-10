# SwarmUI-Workspaces

A SwarmUI extension for saving and restoring named workspaces: snapshots of your Generate-tab settings, including which parameter groups are switched on.

**Workspaces and presets.** A preset sets only the parameters you ticked and stacks on top of what you have. A workspace replaces everything: every value, each parameter's on/off switch, each group switch, and which presets are active. Use presets for reusable tweaks and workspaces to jump between whole setups. Workspaces use presets, never replace them: a workspace remembers which presets were active and re-selects them when loaded.

## Status

Early release. Everything described below works. It has been tested by hand in the browser against a SwarmUI dev build; there are no automated tests yet, so please report anything odd.

## Using it

One row sits above the parameter list on the Generate tab: **[ workspace picker ] [ Save ] [ ... ]**.

![The toolbar](docs/images/toolbar.png)

When the settings differ from the saved workspace, a "Modified" marker appears:

![The toolbar with unsaved changes](docs/images/toolbar-modified.png)

- **Picker**: click it to open SwarmUI's searchable list of your workspaces: bookmarked ones first, then by folder, with the folder shown beside the name. Type to filter by name or folder, and press Enter to load the first match. Choosing a workspace replaces your current settings completely, and asks first if the current workspace has unsaved changes. "+ New workspace..." at the bottom saves the current settings under a new name.
- **Save** writes the current settings into the selected workspace (or asks for a name if none is selected). Shift+S does the same, except while you are typing in a field or a dialog or the image editor is open. If the workspace was changed elsewhere, nothing is overwritten and you are told.
- **Modified** appears when the settings differ from the selected workspace, and goes away only after a successful save or load.
- **...** holds everything else: Save As, Reload saved version, Rename, Bookmark, Folder, Load part of a workspace, and Delete.

![The picker](docs/images/picker.png) ![The ... menu](docs/images/menu.png)

### More detail

- **Save As** copies the folder (not the bookmark). **Reload saved version** throws away unsaved changes and loads the latest saved version, for example after it was changed elsewhere. **Delete** leaves your current settings as they are.
- **Load part of a workspace** opens a dialog to load only some parts: the model, the presets, or any parameter group. Only the ticked parts change, and everything else stays as it is. If you tick a group that is switched on inside a parent group that is off, the parent is switched on too, and you are told. The settings then count as modified, because they no longer match the workspace.

![Partial load dialog](docs/images/partial-load-dialog.png)

- **Bookmark** lists a workspace first. **Folder** sets a folder name (at most 100 characters). Saving settings never changes a workspace's folder or bookmark.
- **Drafts**: while the selected workspace has unsaved changes, a draft of them is kept in your browser a couple of seconds after each change. If you reload the page or close the tab, a notice below the toolbar offers to **Restore** or **Discard** it. Restoring loads the workspace first and then puts the draft on top, so it shows as unsaved changes and never overwrites the saved workspace. Each browser tab keeps its own draft, and a draft from a tab that is still open is never offered.

## What a workspace saves, and what loading does

A workspace saves the Generate tab's parameter values (including values you have configured but switched off), each parameter's own on/off switch, every parameter group's switch (nested groups too), and the active presets in order. Loading replaces all of that; it is not a merge like a preset.

Not saved: image, audio and video inputs (init image, mask, reference images), custom Comfy workflows, prompt attachments, and image editor state. A seed set to random (-1) is saved as -1, so it still picks a new seed each time. A workspace cannot bring back a model or preset that no longer exists.

Loading is careful:

- It checks the whole workspace first, and refuses a workspace from a newer version of this extension.
- It refuses to load while a custom workflow, init image, mask or the image editor is in use, because loading would leave that state in place. Nothing is changed.
- If the workspace's model is not available, it refuses and nothing is changed.
- If a saved preset is missing or has changed since, it asks before continuing.
- It never reports success when something was skipped: items that could not be restored are listed.
- If an error happens part-way, it puts your previous settings back. If even that fails, a notice above the parameters says the settings are a mix and should be checked.

## Limits and permissions

- Per user: up to 200 workspaces, each snapshot up to 256 KB, 4 MB of workspaces in total, names up to 100 characters.
- Listing, saving and deleting workspaces needs the permission "[Workspaces] Manage Workspaces", which regular users have by default.
- If SwarmUI runs with `--no_persist`, nothing can be saved, and saving says so instead of pretending to work.

## Installation

Clone into your SwarmUI extensions folder, then restart SwarmUI:

```bash
cd SwarmUI/src/Extensions
git clone https://github.com/HartsyAI/SwarmUI-Workspaces.git Workspaces
```

## Data and connections

- Workspaces are stored per user on the SwarmUI server, in that user's generic data.
- The extension makes no external network connections.
- Earlier builds could also store tags and thumbnails. They are no longer used or shown, and the leftover data is harmless.
- Workspaces are stored in SwarmUI's account database, so they are lost if that database is lost.

## License

MIT. See [LICENSE](LICENSE).
