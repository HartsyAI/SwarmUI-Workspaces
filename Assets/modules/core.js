/**
 * Workspaces: the manager's core state and server access.
 * Holds the cached workspace list, which workspace the Generate tab is attached to, the modified baseline and the busy flag.
 * Everything else about workspaces (storage, validation, choosing parts, preset checks, drafts) is done by the server through the Workspaces API.
 */

/**
 * Adds the core state and API access to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function CoreMixin(Base) {
    return class extends Base {
        /**
         * Creates the core state for this page.
         */
        constructor() {
            super();
            /** The user's workspaces, as last returned by the server. */
            this.workspaces = [];
            /** True once the workspace list has been fetched from the server at least once. */
            this.listLoaded = false;
            /** ID of the workspace the Generate tab was last loaded from or saved to, or null when none is selected. */
            this.currentId = null;
            /** Server revision of the current workspace, sent back with every update, rename, and delete. */
            this.currentRevision = null;
            /** Normalized state of the Generate tab as of the last successful load or save, or null when no workspace is selected. */
            this.baseline = null;
            /** True when the Generate tab differs from the baseline. */
            this.modified = false;
            /** True while a save, rename, delete, or load started from the toolbar is running. */
            this.busy = false;
        }

        /**
         * Calls a Workspaces API route.
         * @param {string} route The route name, for example 'WorkspacesCreate'.
         * @param {Object} data The request body.
         * @returns {Promise<Object>} Resolves to the response; rejects with the error message.
         */
        callApi(route, data) {
            return new Promise((resolve, reject) => {
                genericRequest(route, data, resolve, 0, error => {
                    reject(`${error}`);
                });
            });
        }

        /**
         * Fetches the user's workspaces from the server and caches them.
         * @returns {Promise<Array>} Resolves to the workspace list; rejects with the server's error message.
         */
        async listWorkspaces() {
            this.workspaces = (await this.callApi('WorkspacesList', {})).workspaces || [];
            return this.workspaces;
        }

        /**
         * Loads the workspace list when the page session is ready. Shows an error if the request fails.
         */
        async loadWorkspaces() {
            try {
                await this.listWorkspaces();
            }
            catch (error) {
                console.error('Workspaces: failed to load the workspace list.', error);
                showError(`Failed to load workspaces: ${error}`);
                return;
            }
            this.listLoaded = true;
            this.refreshToolbar();
            this.checkRecovery();
        }

        /**
         * Returns the cached workspaces sorted by name.
         * @returns {Array<Object>} A sorted copy of the list.
         */
        sortedWorkspaces() {
            return this.workspaces.slice().sort((a, b) => `${a.name}`.localeCompare(`${b.name}`));
        }

        /**
         * Finds the stored workspace the toolbar is currently attached to.
         * @returns {Object|null} The workspace entry, or null.
         */
        getCurrentEntry() {
            if (!this.currentId) {
                return null;
            }
            return this.workspaces.find(w => w.id == this.currentId) || null;
        }

        /**
         * Stores a workspace entry returned by the server into the cached list, replacing an entry with the same ID.
         * @param {Object} entry The workspace entry.
         */
        storeEntry(entry) {
            let index = this.workspaces.findIndex(w => w.id == entry.id);
            if (index >= 0) {
                this.workspaces[index] = entry;
            }
            else {
                this.workspaces.push(entry);
            }
        }

        /**
         * Makes a workspace the current one and resets the modified baseline to the given (or present) state.
         * Call only when the Generate tab really holds that workspace: after a successful load or save.
         * @param {Object} entry The stored workspace entry (with its new revision).
         * @param {Object} snapshot Optional: the snapshot that was saved, used as the baseline instead of re-capturing.
         */
        setCurrent(entry, snapshot = null) {
            let previousId = this.currentId;
            this.currentId = entry.id;
            this.currentRevision = entry.revision;
            this.baseline = this.normalizeState(snapshot || this.captureSnapshot());
            this.modified = false;
            this.clearDraft([previousId, entry.id]);
            this.refreshToolbar();
        }

        /**
         * Detaches the toolbar from any workspace. The Generate tab keeps its settings.
         */
        detach() {
            let previousId = this.currentId;
            this.currentId = null;
            this.currentRevision = null;
            this.baseline = null;
            this.modified = false;
            this.clearDraft([previousId]);
            this.refreshToolbar();
        }

        /**
         * Sets or clears the busy flag, which disables the toolbar while a request or a load runs.
         * @param {boolean} busy True while an operation runs.
         */
        setBusy(busy) {
            this.busy = busy;
            this.refreshToolbar();
            if (!busy) {
                this.scheduleModifiedCheck();
            }
        }

        /**
         * Runs a task with the toolbar marked busy, and clears the mark when the task ends, however it ends.
         * @param {Function} task An async function.
         * @returns {Promise<*>} Resolves to the task's result.
         */
        async runBusy(task) {
            this.setBusy(true);
            try {
                return await task();
            }
            finally {
                this.setBusy(false);
            }
        }

        /**
         * Tells the user a save, rename, or delete failed. Re-reads the list to explain a conflict: the workspace changed or was deleted elsewhere.
         * Never clears the modified marker.
         * @param {string} verb What was attempted: 'save', 'rename', or 'delete'.
         * @param {string} error The error message from the server.
         */
        async reportFailure(verb, error) {
            let message = `${error}`;
            try {
                await this.listWorkspaces();
                let entry = this.getCurrentEntry();
                if (!entry) {
                    message = 'This workspace was deleted elsewhere. Use Save As to keep your settings as a new workspace.';
                    this.currentId = null;
                    this.currentRevision = null;
                    this.baseline = null;
                    this.modified = false;
                }
                else if (entry.revision != this.currentRevision) {
                    message = `"${entry.name}" was changed elsewhere. Nothing was overwritten. Use Save As to keep your settings as a new workspace, or load the workspace again to get the latest version.`;
                }
            }
            catch (listError) {
                console.error('Workspaces: could not re-read the list after a failure.', listError);
            }
            showError(`Could not ${verb} the workspace: ${message}`);
        }
    };
}
