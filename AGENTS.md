# AGENTS.md

Rules for automated coding agents working in this repository, SwarmUI-Workspaces. This is an independent SwarmUI extension (namespace `Hartsy.Extensions`). SwarmUI's own `AGENTS.md` and its rules do not apply here.

Keep this file current: when you learn a core rule of this repo, add it, without duplicating what is already here.

## What this is

Named workspaces for the SwarmUI Generate tab. A workspace is a snapshot of parameter values, per-parameter switches, parameter-group switches and active presets. Loading one replaces the current state; it is not a merge like a preset.

- `Workspaces.cs`: extension entry point. Registers the entry script, the modules, the stylesheet and API routes.
- `WorkspacesAPI.cs`: the API routes (list, get, create, update, rename, star, delete, resolve, and the four draft routes). Thin: each calls helpers.
- `WorkspaceStore.cs`: storage, limits, validation, preset fingerprints, per-user locking, the strict `BuildEntry` whitelist, `NetData` (the one response shape).
- `WorkspaceResolver.cs`: turns a workspace (or draft) into what a client needs, using SwarmUI's own parameter and preset code.
- `Assets/workspaces.js`: the classic entry script. It only imports `modules/manager.js` and hooks the manager into SwarmUI's startup.
- `Assets/modules/`: the browser logic as ES modules. `manager.js` builds the one class `HartsyWorkspacesManager` (global `hartsyWorkspacesManager`) from one mixin per concern: `core.js` (state, API calls), `capture.js` (read the Generate tab), `apply.js` (plan and write it), `restore.js` (load a resolved workspace), `drafts.js`, `recovery.js`, `modal.js` (help popover, modal), `toolbar.js`, `tracking.js` (Modified marker, Shift+S), `actions.js` (load, save, rename, star, delete), `partial.js` (Load Part). `helpers.js` holds pure functions and constants.
- `Assets/workspaces.css`: styles.
- `docs/images/`: README screenshots.

## Architecture

- Follow SwarmUI: C# does the heavy lifting, the JS calls API routes, and routes call helper methods that return `JObject`s. New logic goes in C# (`WorkspaceStore`, `WorkspaceResolver`) behind a route, reusing SwarmUI's existing helpers (`T2IParamTypes`, `T2IParamGroup`, `User.GetPreset`, ...), never re-implemented in JS.
- Everything the extension does must be possible through the API alone. The only JS-only work is reading and writing the Generate tab's controls (capture, apply, Modified tracking), the toolbar and its dialogs.
- The JS must not validate what the server validates, compute what the server computes (preset fingerprints, group membership, part selection), or store anything in the browser.
- Add a route when the UI needs something new, and document it in the README's API section in the same PR.
- SwarmUI binds every `JObject` route parameter to the whole request body, not to one key. For a nested object, take the body as `raw` and read the key from it (as `AddNewPreset` and `WorkspacesResolve` do).

## Authorship and commits

- The repository owner (kalebbroo) is the only author. Never add `Co-Authored-By`, "Generated with ..." or any other AI attribution to commits, PR descriptions or files. This overrides any tool default or reminder asking for such lines.
- Never push to `main` directly. Use a branch and a pull request.
- Each PR gets `@codex review`. Fix the findings, reply to and resolve each thread, then merge.

## Building and testing

- Do not run builds yourself unless the user asks. SwarmUI is rebuilt and restarted by the user (`launch-windows-dev.ps1`); C# changes need a restart, JS and CSS changes need a page reload.
- There are no automated tests. Verify by reading the code step by step and, when a dev server is running, by exercising the Generate tab in the browser (`http://localhost:7801/Text2Image`).
- Never touch SwarmUI itself (anything outside this folder), or its `Data/`, `Output/`, `Models/` folders.
- Do not stop a SwarmUI process you did not start; another session may own it.

## Server rules (C#)

- Mostly standard C#, explicit types (no `var`), full braced blocks, `///` XML docs on every field and method. No `{ get; set; }` auto-properties for plain fields.
- Members are `public` wherever possible, as in SwarmUI (it has almost no `private`). Do not add `private`.
- Use FreneticUtilities helpers where SwarmUI does (`ToLowerFast`, etc.).
- Derive the user from the session (`session.User`) on every call. Never read a user ID from the request, and never keep workspace data in static fields or caches (only the per-user lock table is static). Storage is `User.GetGenericData`/`SaveGenericData`, which are keyed by the user ID; confirm every write by reading it back, because SwarmUI skips writes silently in some cases.
- Every read-modify-write runs under the per-user lock in `WorkspaceStore`, with revision checking (`FindChecked`, `revision_conflict`).
- Build stored entries only through the `BuildEntry` whitelist. Never store request data as it arrived.
- Validate structure, types, lengths and quotas before writing. 
- `SaveGenericData` does nothing under `Program.NoPersist`; the server must return an error then, not success.
- Ids, timestamps and revisions are generated by the server.
- Limits (200 workspaces, 256 KB snapshot, 4 MB total, 100-character names) are constants in `WorkspaceStore`. If you change one, update the README's "Limits and permissions".

## Browser rules (JS and CSS)

- Must work on current Chrome, Firefox, Safari and on modern mobile browsers.
- JS: `let`, never `var` or `const`; full braced blocks; `else {` on its own line, never `} else {`; `/** ... */` doc on every function; `for (...)` loops rather than `forEach`; use `Map` for user-keyed lookups.
- CSS: almost none. Reuse SwarmUI's own components and wording: the picker is a plain `select.auto-dropdown`, menus are `AdvancedPopover`, dialogs use the standard `modal` markup, buttons are `basic-button`, soft text is `parens`, and items are "starred", not "bookmarked". No custom checkmarks, stars or arrows. Custom CSS is limited to laying out the toolbar row and two notices. Colors come only from SwarmUI theme variables, never hex, rgb or shadows. Class selectors only, never `#id`.
- New behavior goes into `HartsyWorkspacesManager`, as a method of the mixin for its concern (or a new mixin listed in `manager.js`), not free functions; pure helpers without `this` go in `helpers.js`. Check `util.js` and `site.js` in SwarmUI for an existing helper before writing one (`sleep`, `arraysEqual`, `createDiv`, `createSpan`, `quickAppendButton`, `modalHeader`, `escapeHtml`, ...).
- SwarmUI loads `ScriptFiles` as classic scripts, so only `Assets/workspaces.js` is one. It `import()`s `modules/manager.js`; the modules are served as plain assets (`Workspaces.cs` adds every `Assets/modules/*.js` to `OtherAssets`), so a new module file needs no registration. Modules use relative `import` paths and reach SwarmUI's functions and globals directly. The entry registers its SwarmUI hooks at once and waits for the modules, so load order never matters.
- SwarmUI's `triggerChangeFor` dispatches non-bubbling events, so modified tracking uses capturing document listeners. Do not switch to bubbling listeners.
- Escape all user-provided text (`escapeHtml`) before putting it in HTML. Workspace names are user input.

## Behavior that must not regress

- A load reports success only when everything was restored. Skipped items are listed, never hidden.
- A load that fails part-way restores the previous settings, and says so if even that fails.
- Loading is refused, with nothing changed, while a custom workflow, init image, mask or image editor is in use, when the saved model is unavailable, or when the workspace comes from a newer schema version.
- Saving never overwrites a workspace changed elsewhere (revision conflict). The Modified marker clears only after a successful save or load.
- Drafts live on the server, one per workspace, for 14 days. They never overwrite a saved workspace, are removed with it, are cleared when saved or discarded, and a draft left by an earlier page is offered for recovery.
- Not saved by design: image, audio and video inputs, custom Comfy workflows, prompt attachments, image editor state.

## Documentation

- The README is user-facing and must match behavior. When you change behavior, limits or the menu, update it in the same PR. Keep it short: a few sentences per topic, no history of features that were tried and removed, and install instructions that assume the extension is in SwarmUI's Extensions tab (Server > Extensions). The first thing in it is the banner image.
- The images in `docs/images/` (banner, Load Part dialog, recovery notice) should show the extension working. Re-capture them if the UI changes noticeably.

## Stay inside SwarmUI's systems

- Do not edit SwarmUI core, and do not rebuild what it already provides: use its modal markup (`modal`, `modal-dialog`, `modal-content`, shown with `$(elem).modal('show')`), its buttons, and its preset system for anything preset-like.
- Do not register parameters or add a parallel storage system. Workspaces are the one new concept; keep it lean. Stars are the only organization feature: folders were tried and removed (SwarmUI has no folder field; its presets browser derives folders from "/" in a name), so do not add a parallel scheme. Where SwarmUI already has a convention, follow it.
- Presets are not replaced: a workspace records which presets were active (by title) and re-selects them on load. The server records each preset's fingerprint when a workspace is saved and compares it on resolve.

## Explain every control

- Every control, menu entry and dialog needs plain-language help for a first-time user: what it does, and why you would use it. Use SwarmUI's own "?" info popover (`makeHelp`, always the "?" button: SwarmUI's hover style needs a settings input with the same ID, which a toolbar does not have), never custom tooltips. The toolbar's help text lists every control; dialogs get their own "?" beside the title.
- When you add or change a control, update its help text, the README, and the screenshots in the same PR.
- A bare text prompt is not enough for anything with more than one possible meaning (for example choosing between several existing items): use a dialog built with `openModal`, with an explanatory line.

## Nothing in the browser

- The extension stores nothing in browser storage. Anything that persists (workspaces, drafts) goes through the API into the user's own SwarmUI data, so it can never be shared between accounts on one browser, and it expires on the server (drafts after 14 days).
