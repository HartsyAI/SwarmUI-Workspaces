# SwarmUI-Workspaces

A SwarmUI extension for saving and restoring named workspaces: snapshots of your Generate-tab settings, including which parameter groups are switched on.

## Status

In development. The server API (create, update, rename, delete, import) is in place. The Generate-tab toolbar and load/save UI are not built yet.

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
