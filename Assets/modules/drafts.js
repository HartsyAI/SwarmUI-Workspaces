/**
 * Workspaces: drafts. Unsaved changes to the current workspace are kept on the server, one draft per workspace.
 * A draft never overwrites the saved workspace. Saves and deletes are ordered per workspace so a stale request can never land after a newer one.
 */

/**
 * Adds draft saving and deleting to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function DraftsMixin(Base) {
    return class extends Base {
        /**
         * Creates the draft bookkeeping for this page.
         */
        constructor() {
            super();
            /** Pending timer for the debounced draft save, or null. */
            this.draftTimer = null;
            /** Wait after the last change before a draft is saved to the server, in milliseconds. */
            this.draftDebounceMs = 2000;
            /** IDs of workspaces that have a draft on the server, as far as this page knows. */
            this.draftIds = new Set();
            /** Goes up whenever this page finishes saving a draft or starts deleting one, so a draft list requested before that can be recognized as out of date. */
            this.draftChanges = 0;
            /** IDs of workspaces whose draft was written by this page, which this page may clear when its changes are saved or discarded. */
            this.ownDrafts = new Set();
            /** IDs of workspaces with a draft save still in flight. */
            this.savingDrafts = new Set();
            /** IDs whose changes were discarded or saved while a draft save was in flight, so that draft is deleted as soon as its save finishes. */
            this.discardedWhileSaving = new Set();
            /** The newest draft save waiting for the one in flight for the same workspace to finish, by workspace ID. Only one save per workspace runs at a time, so an older request can never land after a newer one. */
            this.queuedDrafts = new Map();
            /** Per workspace ID, a number that goes up whenever its changes are discarded or saved. A draft request made before that is obsolete. */
            this.draftEpochs = new Map();
            /** The draft deletion most recently started for a workspace ID, so a later draft save waits for it instead of landing first and being deleted. */
            this.draftDeletes = new Map();
        }

        /**
         * Schedules a debounced save of the current workspace's draft: its unsaved settings.
         */
        scheduleDraftSave() {
            clearTimeout(this.draftTimer);
            this.draftTimer = setTimeout(() => {
                this.draftTimer = null;
                this.saveDraft();
            }, this.draftDebounceMs);
        }

        /**
         * Saves the current workspace's draft on the server, if the settings still differ from the workspace.
         */
        async saveDraft() {
            let entry = this.getCurrentEntry();
            if (!entry || this.baseline == null || this.restoring || this.busy || !this.isReady()) {
                return;
            }
            let snapshot = this.tryCaptureSnapshot(error => console.error('Workspaces: could not read the settings for a draft.', error));
            if (!snapshot || this.normalizeState(snapshot) == this.baseline) {
                return;
            }
            let id = entry.id;
            let request = { id: id, revision: this.currentRevision, snapshot: snapshot, epoch: this.draftEpochs.get(id) || 0 };
            if (this.savingDrafts.has(id)) {
                // One save per workspace at a time. Keep only the newest snapshot, to send when the one in flight finishes.
                this.queuedDrafts.set(id, request);
                return;
            }
            this.savingDrafts.add(id);
            try {
                for (let next = request; next; next = this.takeQueuedDraft(id)) {
                    // A delete started earlier for this workspace must reach the server first, or it would remove this newer draft.
                    await this.draftDeletes.get(id);
                    if (next.epoch == (this.draftEpochs.get(id) || 0)) {
                        try {
                            await this.callApi('WorkspacesDraftSave', { id: next.id, revision: next.revision, snapshot: next.snapshot });
                            this.draftIds.add(id);
                            this.ownDrafts.add(id);
                            this.draftChanges++;
                        }
                        catch (error) {
                            this.setStatus(`Could not keep a draft of your unsaved changes: ${error}`);
                        }
                    }
                    // The changes were discarded or saved while that request was in flight, so the draft it just wrote is obsolete. Wait for the delete before sending anything newer.
                    if (this.discardedWhileSaving.delete(id)) {
                        await this.deleteDraft(id);
                    }
                }
            }
            finally {
                this.savingDrafts.delete(id);
            }
        }

        /**
         * Takes the draft save queued behind the one that just finished, unless it is obsolete.
         * @param {string} id The workspace ID.
         * @returns {Object|null} The queued request, or null.
         */
        takeQueuedDraft(id) {
            let next = this.queuedDrafts.get(id) || null;
            this.queuedDrafts.delete(id);
            return next && next.epoch == (this.draftEpochs.get(id) || 0) ? next : null;
        }

        /**
         * Cancels any pending draft save, and deletes the drafts this page wrote for the given workspaces. Used when the settings match a workspace again or are being replaced.
         * A draft left by an earlier page is not touched, so it can still be recovered. A draft save still in flight is deleted when it finishes.
         * @param {Array<string>} ids Workspace IDs, any of which may be null.
         */
        clearDraft(ids) {
            clearTimeout(this.draftTimer);
            this.draftTimer = null;
            for (let id of ids) {
                if (!id) {
                    continue;
                }
                this.draftEpochs.set(id, (this.draftEpochs.get(id) || 0) + 1);
                this.queuedDrafts.delete(id);
                if (this.savingDrafts.has(id)) {
                    // A save is still in flight, and deleting now could run before it lands. It deletes its own draft when it finishes.
                    this.discardedWhileSaving.add(id);
                }
                else if (this.ownDrafts.has(id)) {
                    this.deleteDraft(id);
                }
            }
        }

        /**
         * Deletes a workspace's draft on the server, if this page knows of one. A failure is only logged: a leftover draft expires by itself.
         * @param {string} id The workspace ID.
         * @returns {Promise} Resolves when the request has finished.
         */
        async deleteDraft(id) {
            if (!this.draftIds.has(id)) {
                return;
            }
            this.draftIds.delete(id);
            this.ownDrafts.delete(id);
            this.draftChanges++;
            let previous = this.draftDeletes.get(id);
            let request = (async () => {
                await previous;
                try {
                    await this.callApi('WorkspacesDraftDelete', { id: id });
                }
                catch (error) {
                    console.error('Workspaces: could not delete a draft.', error);
                }
            })();
            this.draftDeletes.set(id, request);
            await request;
            if (this.draftDeletes.get(id) == request) {
                this.draftDeletes.delete(id);
            }
        }
    };
}
