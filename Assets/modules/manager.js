/**
 * Workspaces: named snapshots of the Generate tab's configuration.
 *
 * HartsyWorkspacesManager is one class, built from the mixins in this folder (each file adds one concern). Everything that is not about the Generate tab's controls
 * is done by the server through the Workspaces API: storage, validating values against the real parameter definitions, choosing parts, checking presets, and drafts.
 * The browser captures the controls, calls the API, and applies what comes back.
 */
import { CoreMixin } from './core.js';
import { CaptureMixin } from './capture.js';
import { ApplyMixin } from './apply.js';
import { RestoreMixin } from './restore.js';
import { DraftsMixin } from './drafts.js';
import { RecoveryMixin } from './recovery.js';
import { ModalMixin } from './modal.js';
import { ToolbarMixin } from './toolbar.js';
import { TrackingMixin } from './tracking.js';
import { ActionsMixin } from './actions.js';
import { PartialMixin } from './partial.js';

/** The manager class, with every mixin applied from the bottom up. */
let ManagerBase = Object;
for (let mixin of [CoreMixin, CaptureMixin, ApplyMixin, RestoreMixin, DraftsMixin, RecoveryMixin, ModalMixin, ToolbarMixin, TrackingMixin, ActionsMixin, PartialMixin]) {
    ManagerBase = mixin(ManagerBase);
}

/** Manages the workspace toolbar and the state behind it for this page. */
class HartsyWorkspacesManager extends ManagerBase {
    /**
     * Runs after every parameter build: puts the toolbar back if needed and re-checks the modified state.
     */
    onParamsBuilt() {
        try {
            this.ensureToolbar();
            this.scheduleModifiedCheck();
        }
        catch (error) {
            console.error('Workspaces: could not set up the toolbar.', error);
        }
    }

    /**
     * Runs when the page session is ready: fetches the workspace list and makes sure the toolbar is there.
     */
    onSessionReady() {
        this.loadWorkspaces();
        if (this.isReady()) {
            this.ensureToolbar();
        }
    }
}

/** Singleton instance of the workspace manager, also reachable as window.hartsyWorkspacesManager. */
export let hartsyWorkspacesManager = new HartsyWorkspacesManager();
window.hartsyWorkspacesManager = hartsyWorkspacesManager;
