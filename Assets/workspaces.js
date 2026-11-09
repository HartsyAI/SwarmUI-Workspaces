/**
 * Workspaces: named snapshots of the generation configuration, managed from a toolbar above the parameters.
 */
class HartsyWorkspacesManager {
    /**
     * Creates the manager. Holds the cached workspace list for this session.
     */
    constructor() {
        /** The user's workspaces, as last returned by the server. */
        this.workspaces = [];
    }

    /**
     * Loads the workspace list from the server and builds the toolbar.
     * TODO: build the toolbar (dropdown, New, Save, Save As, Delete, Export, Import).
     */
    loadWorkspaces() {
        genericRequest('WorkspacesList', {}, (data) => {
            this.workspaces = data.workspaces;
        });
    }
}

/** Singleton instance of the workspace manager. */
let hartsyWorkspacesManager = new HartsyWorkspacesManager();

sessionReadyCallbacks.push(() => {
    hartsyWorkspacesManager.loadWorkspaces();
});
