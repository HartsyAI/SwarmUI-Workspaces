# SwarmUI-Workspaces

A SwarmUI extension for saving and restoring named workspaces: snapshots of your Generate-tab settings, including which parameter groups are switched on.

## Status

In development. Working now: the server API (create, update, rename, delete, import), capturing and restoring the Generate tab, and a toolbar above the parameters. Not built yet: partial load, JSON export and import in the UI, folders and tags, drafts.

## Using it

The toolbar sits above the parameter list on the Generate tab:

- **Dropdown**: pick a workspace to load it. A load replaces your current settings completely. If the current workspace has unsaved changes, you are asked first.
- **New** saves the current settings as a new workspace. **Save As** does the same, starting from "<name> copy".
- **Save** writes the current settings into the selected workspace. If it was changed elsewhere, nothing is overwritten and you are told.
- **Rename** and **Delete** act on the selected workspace. Delete leaves your settings as they are.
- **Modified** appears when the settings differ from the selected workspace, and goes away only after a successful save or load.

![Toolbar with unsaved changes](docs/images/toolbar-modified.png)

![Toolbar after saving](docs/images/toolbar-saved.png)

## Installation

Clone into your SwarmUI extensions folder, then restart SwarmUI:

```bash
cd SwarmUI/src/Extensions
git clone https://github.com/HartsyAI/SwarmUI-Workspaces.git Workspaces
```

## Data and connections

- Workspaces are stored per user on the SwarmUI server, in that user's generic data.
- The extension makes no external network connections.
- Workspaces are stored in SwarmUI's account database, so they are lost if that database is lost.

## License

MIT. See [LICENSE](LICENSE).
