/**
 * Workspaces: entry script. SwarmUI loads extension scripts as classic scripts, so this one only loads the ES modules in modules/ (starting with manager.js)
 * and hooks the manager into SwarmUI's startup. The hooks are registered now, and wait for the modules, so they work whether the page finishes building before or after the modules arrive.
 */
{
    let loaded = import('./modules/manager.js');
    loaded.catch(error => {
        console.error('Workspaces: could not load its modules.', error);
    });
    postParamBuildSteps.push(() => {
        loaded.then(module => module.hartsyWorkspacesManager.onParamsBuilt(), () => {});
    });
    sessionReadyCallbacks.push(() => {
        loaded.then(module => module.hartsyWorkspacesManager.onSessionReady(), () => {});
    });
}
