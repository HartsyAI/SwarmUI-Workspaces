/**
 * Workspaces: the toolbar's actions: load, save, save as new, rename, star and delete. Each one is a call to the Workspaces API plus an update of the page.
 */
import { restoreSucceeded } from './helpers.js';

/**
 * Adds the toolbar actions to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function ActionsMixin(Base) {
    return class extends Base {
        /**
         * Handles a choice in the workspace picker: loads that workspace, or detaches when "No workspace" is chosen.
         * @param {string} id The chosen workspace ID, or an empty string for "No workspace".
         */
        async pickWorkspace(id) {
            if (id == (this.currentId || '')) {
                return;
            }
            if (id == '') {
                this.detach();
                return;
            }
            await this.loadWorkspace(id);
        }

        /**
         * Loads a stored workspace into the Generate tab, replacing the current settings.
         * Asks first if the current workspace has unsaved changes. The modified baseline moves only if the load succeeds.
         * @param {string} id The workspace ID.
         * @returns {Promise<string>} 'loaded' if the workspace was loaded (fully, or with skipped items reported); 'cancelled' if the user declined or nothing was attempted; 'failed' if it was refused or the load failed (the reason has been shown to the user).
         */
        async loadWorkspace(id) {
            if (this.busy || this.restoring) {
                this.refreshToolbar();
                return 'cancelled';
            }
            // The marker is debounced, so compare right now instead of trusting it: an edit made a moment ago must still trigger the prompt.
            this.updateModified();
            if (this.modified) {
                let name = this.getCurrentEntry()?.name ?? 'The current workspace';
                let question = id == this.currentId ? `"${name}" has unsaved changes. Reload the saved version and discard them?` : `"${name}" has unsaved changes. Load another workspace and discard them?`;
                if (!confirm(question)) {
                    this.refreshToolbar();
                    return 'cancelled';
                }
            }
            return await this.runBusy(async () => {
                let resolved;
                try {
                    resolved = await this.callApi('WorkspacesResolve', { id: id });
                }
                catch (error) {
                    showError(`Could not load the workspace: ${error}`);
                    try {
                        await this.listWorkspaces();
                    }
                    catch (listError) {
                        console.error('Workspaces: could not refresh the list after a failed load.', listError);
                    }
                    if (this.currentId && !this.getCurrentEntry()) {
                        this.detach();
                    }
                    return 'failed';
                }
                let result = await this.applyResolved(resolved);
                if (restoreSucceeded(result)) {
                    this.storeEntry(resolved.workspace);
                    this.setCurrent(resolved.workspace);
                    return 'loaded';
                }
                return result.status == 'cancelled' ? 'cancelled' : 'failed';
            });
        }

        /**
         * Asks for a workspace name. An empty name is refused with a message.
         * @param {string} message The prompt text.
         * @param {string} initial The name to start from.
         * @returns {string|null} The trimmed name, or null if the user cancelled or gave none.
         */
        askName(message, initial) {
            let name = prompt(message, initial);
            if (name == null) {
                return null;
            }
            if (name.trim() == '') {
                showError('A workspace needs a name.');
                return null;
            }
            return name.trim();
        }

        /**
         * Saves the current settings into the current workspace. With no workspace selected, saves a new one instead.
         * A failed save keeps the modified marker and tells the user why, including when the workspace changed elsewhere.
         */
        async saveCurrent() {
            if (this.busy || this.restoring) {
                return;
            }
            if (!this.currentId) {
                await this.saveNew(false);
                return;
            }
            if (!this.getCurrentEntry()) {
                this.detach();
                showError('This workspace no longer exists. Use Save As to keep your settings as a new workspace.');
                return;
            }
            let snapshot = this.tryCaptureSnapshot(error => showError(`Could not read the current settings: ${error.message || error}`));
            if (!snapshot) {
                return;
            }
            await this.runBusy(async () => {
                try {
                    let response = await this.callApi('WorkspacesUpdate', { id: this.currentId, revision: this.currentRevision, snapshot: snapshot });
                    this.storeEntry(response.workspace);
                    this.setCurrent(response.workspace, snapshot);
                    // The server removes a workspace's draft when it is saved, so only this page's bookkeeping needs updating.
                    this.draftIds.delete(response.workspace.id);
                    this.ownDrafts.delete(response.workspace.id);
                }
                catch (error) {
                    await this.reportFailure('save', error);
                }
            });
        }

        /**
         * Saves the current settings as a new workspace and selects it.
         * @param {boolean} copy True for Save As: the name prompt starts as "<current name> copy".
         */
        async saveNew(copy) {
            if (this.busy || this.restoring) {
                return;
            }
            let current = this.getCurrentEntry();
            let name = this.askName('Name for the new workspace:', copy && current ? `${current.name} copy` : '');
            if (name == null) {
                return;
            }
            let snapshot = this.tryCaptureSnapshot(error => showError(`Could not read the current settings: ${error.message || error}`));
            if (!snapshot) {
                return;
            }
            await this.runBusy(async () => {
                try {
                    let response = await this.callApi('WorkspacesCreate', { name: name, snapshot: snapshot });
                    this.storeEntry(response.workspace);
                    this.setCurrent(response.workspace, snapshot);
                }
                catch (error) {
                    showError(`Could not save the workspace: ${error}`);
                }
            });
        }

        /**
         * Renames the current workspace. The saved settings are not touched, and unsaved changes stay unsaved.
         */
        async renameCurrent() {
            let entry = this.getCurrentEntry();
            if (this.busy || this.restoring || !entry) {
                return;
            }
            let name = this.askName('New name for this workspace:', entry.name);
            if (name == null) {
                return;
            }
            await this.runBusy(async () => {
                try {
                    let response = await this.callApi('WorkspacesRename', { id: entry.id, revision: this.currentRevision, name: name });
                    entry.name = name;
                    entry.revision = response.revision;
                    this.currentRevision = response.revision;
                }
                catch (error) {
                    await this.reportFailure('rename', error);
                }
            });
        }

        /**
         * Stars or unstars the current workspace. The saved settings are not touched, so unsaved changes stay unsaved.
         */
        async toggleStar() {
            let entry = this.getCurrentEntry();
            if (this.busy || this.restoring || !entry) {
                return;
            }
            await this.runBusy(async () => {
                try {
                    let response = await this.callApi('WorkspacesStar', { id: entry.id, revision: this.currentRevision, starred: !entry.starred });
                    this.currentRevision = response.revision;
                    try {
                        // Take the stored values back, so the list shows exactly what the server kept.
                        await this.listWorkspaces();
                    }
                    catch (error) {
                        console.error('Workspaces: could not refresh the list after a change.', error);
                        entry.starred = !entry.starred;
                        entry.revision = response.revision;
                    }
                }
                catch (error) {
                    await this.reportFailure('update', error);
                }
            });
        }

        /**
         * Deletes the current workspace after confirmation. The Generate tab keeps its settings.
         */
        async deleteCurrent() {
            let entry = this.getCurrentEntry();
            if (this.busy || this.restoring || !entry) {
                return;
            }
            if (!confirm(`Delete the workspace "${entry.name}"? This cannot be undone. Your current settings stay as they are.`)) {
                return;
            }
            await this.runBusy(async () => {
                try {
                    await this.callApi('WorkspacesDelete', { id: entry.id, revision: this.currentRevision });
                    this.workspaces = this.workspaces.filter(w => w.id != entry.id);
                    this.detach();
                }
                catch (error) {
                    await this.reportFailure('delete', error);
                }
            });
        }
    };
}
