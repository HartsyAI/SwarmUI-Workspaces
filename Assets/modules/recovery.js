/**
 * Workspaces: recovery of drafts left by an earlier page. A notice in the toolbar offers to restore or discard the newest one.
 */
import { restoreSucceeded } from './helpers.js';

/**
 * Adds draft recovery to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function RecoveryMixin(Base) {
    return class extends Base {
        /**
         * Creates the recovery state.
         */
        constructor() {
            super();
            /** True once the check for drafts left by an earlier page has run. */
            this.recoveryChecked = false;
            /** IDs of drafts already restored on this page, so they are not offered again. */
            this.recoveredIds = new Set();
        }

        /**
         * Runs the recovery check once, when the toolbar and the workspace list are both ready.
         */
        checkRecovery() {
            if (this.recoveryChecked || !this.listLoaded || !this.isReady() || !document.querySelector('.hartsy-workspaces-toolbar')) {
                return;
            }
            this.recoveryChecked = true;
            this.showRecovery();
        }

        /**
         * Shows a notice in the toolbar for the newest draft left by an earlier page, with Restore and Discard.
         */
        async showRecovery() {
            let toolbar = document.querySelector('.hartsy-workspaces-toolbar');
            if (!toolbar) {
                return;
            }
            let drafts;
            try {
                // A list that was in flight while a draft was saved or deleted here is out of date, so ask again (a few times at most).
                for (let attempt = 0; attempt < 3; attempt++) {
                    let before = this.draftChanges;
                    drafts = (await this.callApi('WorkspacesDraftList', {})).drafts;
                    if (before == this.draftChanges) {
                        break;
                    }
                }
            }
            catch (error) {
                console.error('Workspaces: could not list drafts.', error);
                return;
            }
            // Drafts this page wrote are always known, whatever the list said.
            this.draftIds = new Set([...drafts.map(draft => draft.id), ...this.ownDrafts]);
            for (let old of toolbar.querySelectorAll('.hartsy-workspaces-recover')) {
                old.remove();
            }
            drafts = drafts.filter(draft => !this.ownDrafts.has(draft.id) && !this.recoveredIds.has(draft.id));
            if (drafts.length == 0) {
                return;
            }
            let draft = drafts[0];
            let banner = createDiv(null, 'hartsy-workspaces-recover');
            let text = createSpan(null, 'hartsy-workspaces-recover-text');
            let more = drafts.length > 1 ? ` (${drafts.length - 1} more after this)` : '';
            text.textContent = `Unsaved changes to "${draft.name}" from ${new Date(draft.saved_at).toLocaleString()} were found${more}.`;
            banner.append(text);
            quickAppendButton(banner, 'Restore', () => this.recoverDraft(draft), '', 'Put those unsaved changes back on top of the workspace. Nothing is saved until you press Save.');
            quickAppendButton(banner, 'Discard', async () => {
                await this.deleteDraft(draft.id);
                this.showRecovery();
            }, '', 'Throw those unsaved changes away.');
            toolbar.append(banner);
        }

        /**
         * Restores a draft: the saved workspace is loaded first, so the draft shows as unsaved changes to it. Named workspaces are never overwritten by recovery.
         * @param {Object} draft A draft from WorkspacesDraftList.
         */
        async recoverDraft(draft) {
            if (this.busy || this.restoring) {
                return;
            }
            let outcome = await this.loadWorkspace(draft.id);
            if (outcome == 'cancelled') {
                // The user declined, or nothing was attempted; the draft stays so it can be recovered later.
                return;
            }
            let attached = outcome == 'loaded';
            if (!attached) {
                // The saved version cannot be loaded (for example its model was removed), but the draft may still be usable. Offer it without attaching it to the workspace.
                if (!confirm(`The saved workspace "${draft.name}" could not be loaded (the reason was shown above). Restore the draft anyway, without attaching it to a workspace?`)) {
                    return;
                }
                this.detach();
            }
            let result = await this.runBusy(async () => {
                try {
                    return await this.applyResolved(await this.callApi('WorkspacesResolve', { id: draft.id, draft: true }));
                }
                catch (error) {
                    showError(`Could not restore the draft: ${error}`);
                    return null;
                }
            });
            if (!result || !restoreSucceeded(result)) {
                return;
            }
            // The restored draft stays on the server until the next save replaces it, but it is not offered again. Offer the next one, if any.
            this.recoveredIds.add(draft.id);
            if (attached) {
                // The draft is now this page's own, so discarding the restored changes (switching workspaces, reloading the saved version) deletes it.
                this.draftIds.add(draft.id);
                this.ownDrafts.add(draft.id);
            }
            this.showRecovery();
            if (!attached) {
                this.setStatus('Restored the draft. The saved workspace could not be loaded, so these settings are not attached to it. Use Save As to keep them.');
            }
            else if (this.currentRevision != draft.revision) {
                this.setStatus(`Restored the draft. "${draft.name}" was saved elsewhere after this draft was made, so saving now replaces that newer version.`);
            }
            else {
                this.setStatus('Restored the draft.');
            }
        }
    };
}
