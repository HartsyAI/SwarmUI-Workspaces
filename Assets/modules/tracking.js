/**
 * Workspaces: noticing changes. Keeps the "Modified" marker and the draft up to date, and handles the Shift+S save shortcut.
 */

/**
 * Adds modified tracking and the save shortcut to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function TrackingMixin(Base) {
    return class extends Base {
        /**
         * Creates the tracking state.
         */
        constructor() {
            super();
            /** Pending timer for the debounced modified-state check, or null. */
            this.modifiedTimer = null;
            /** True once the page-wide change listeners are attached. */
            this.trackingAttached = false;
            /** True once the Shift+S listener is attached. */
            this.shortcutAttached = false;
        }

        /**
         * Attaches the page-wide listeners that notice parameter changes. Safe to call repeatedly.
         * Listeners are capturing, because Swarm's programmatic change events do not bubble, and on the document, so they survive parameter rebuilds.
         */
        attachTracking() {
            if (this.trackingAttached) {
                return;
            }
            this.trackingAttached = true;
            for (let type of ['input', 'change', 'click']) {
                document.addEventListener(type, event => {
                    this.onPossibleChange(event);
                }, true);
            }
        }

        /**
         * Handles any input, change, or click on the page by scheduling a modified-state check.
         * @param {Event} event The event.
         */
        onPossibleChange(event) {
            if (!this.currentId || this.restoring || this.busy) {
                return;
            }
            if (event.target && event.target.closest && event.target.closest('.hartsy-workspaces-toolbar')) {
                return;
            }
            this.scheduleModifiedCheck();
        }

        /**
         * Schedules a debounced modified-state check. Does nothing when no workspace is selected.
         */
        scheduleModifiedCheck() {
            if (!this.currentId) {
                return;
            }
            clearTimeout(this.modifiedTimer);
            this.modifiedTimer = setTimeout(() => {
                this.modifiedTimer = null;
                this.updateModified();
            }, 250);
        }

        /**
         * Compares the Generate tab with the baseline and updates the modified marker. Idle during restores and saves.
         */
        updateModified() {
            if (!this.currentId || this.baseline == null || this.restoring || this.busy || !this.isReady()) {
                return;
            }
            let snapshot = this.tryCaptureSnapshot(error => console.error('Workspaces: could not read the current settings.', error));
            if (!snapshot) {
                return;
            }
            let changed = this.normalizeState(snapshot) != this.baseline;
            if (changed) {
                this.scheduleDraftSave();
            }
            else {
                this.clearDraft([this.currentId]);
            }
            if (changed != this.modified) {
                this.modified = changed;
                this.refreshToolbar();
            }
        }

        /**
         * Attaches the Shift+S save shortcut. Safe to call repeatedly.
         */
        attachShortcut() {
            if (this.shortcutAttached) {
                return;
            }
            this.shortcutAttached = true;
            document.addEventListener('keydown', event => {
                this.onShortcut(event);
            });
        }

        /**
         * Handles Shift+S: saves the current workspace. Ignored while typing, composing text, or when another dialog or the image editor is in use.
         * @param {KeyboardEvent} event The key event.
         */
        onShortcut(event) {
            if (event.code != 'KeyS' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) {
                return;
            }
            let target = event.target;
            if (target && (target.isContentEditable || (target.closest && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')))) {
                return;
            }
            if (this.busy || this.restoring || document.querySelector('.modal.show')) {
                return;
            }
            let area = document.getElementById('main_inputs_area');
            if (!area || area.offsetParent == null || this.isImageEditorActive()) {
                return;
            }
            event.preventDefault();
            this.saveCurrent();
        }
    };
}
