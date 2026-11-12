/**
 * Workspaces: loading a resolved workspace into the Generate tab.
 *
 * applyResolved takes the response of the WorkspacesResolve route and resolves to a result { status, message, skipped, warnings }, where status is one of:
 * 'success' (everything restored), 'incomplete' (finished, but some items in 'skipped' could not be restored),
 * 'refused' (nothing was changed), 'cancelled' (the user declined, nothing was changed),
 * 'failed' (an error happened after changes started, and the previous settings were put back),
 * 'partial' (an error happened and the previous settings could not be put back; the UI is marked partially restored).
 * Only 'success' and 'incomplete' mean the UI now holds the workspace, so only those may reset a modified-state baseline.
 */
import { describeUnsupported, makeResult } from './helpers.js';

/**
 * Adds loading a resolved workspace to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function RestoreMixin(Base) {
    return class extends Base {
        /**
         * Creates the restore state.
         */
        constructor() {
            super();
            /** True while a restore is running. Modified-state tracking and draft saving do nothing while this is true. */
            this.restoring = false;
            /** True after a failed restore could not put the previous settings back, until a later restore finishes. */
            this.partiallyRestored = false;
        }

        /**
         * Turns the server's preset statuses into what the restore needs: the preset objects to activate, in saved order, and the presets that need the user's confirmation.
         * The server did the comparing; this only looks the presets up in the page's own preset list.
         * @param {Object} resolved The response of WorkspacesResolve.
         * @returns {Object} { resolved: preset data in saved order (missing ones left out), issues: [{ title, problem: 'missing' | 'changed' }] }.
         */
        presetsFromResolved(resolved) {
            let found = [];
            let issues = [];
            for (let item of resolved.presets || []) {
                let preset = item.status == 'missing' ? null : getPresetByTitle(item.title);
                if (!preset) {
                    issues.push({ title: item.title, problem: 'missing' });
                    continue;
                }
                if (item.status == 'changed') {
                    issues.push({ title: item.title, problem: 'changed' });
                }
                if (!found.includes(preset)) {
                    found.push(preset);
                }
            }
            return { resolved: found, issues: issues };
        }

        /**
         * Asks the user whether to continue when presets are missing or changed.
         * @param {Array} issues The preset issues from presetsFromResolved.
         * @returns {boolean} True only if the user chose to continue.
         */
        confirmPresetIssues(issues) {
            let lines = issues.map(issue => issue.problem == 'missing'
                ? `- "${issue.title}" no longer exists and will be left out.`
                : `- "${issue.title}" has changed since this workspace was saved. Its current definition will be used.`);
            return confirm(`Some presets in this workspace do not match the presets you have now:\n${lines.join('\n')}\n\nContinue loading with the current presets?`);
        }

        /**
         * Adds an entry to a skipped-items list unless the same item is already listed.
         * @param {Array} skipped The list.
         * @param {Object} entry The entry: { kind, id, name, reason }.
         */
        addSkipped(skipped, entry) {
            if (!skipped.some(existing => existing.kind == entry.kind && existing.id == entry.id)) {
                skipped.push(entry);
            }
        }

        /**
         * Applies a resolved workspace (the response of the WorkspacesResolve route) to the Generate tab.
         * Checks the current UI and the model before changing anything. Missing or changed presets need the user's confirmation.
         * If an error happens after changes start, the previous settings are put back; if that fails too, the UI is marked partially restored.
         * @param {Object} resolved The resolved workspace: { values, groups, presets, skipped, unsupported, ... }.
         * @param {boolean} notify False to show no messages.
         * @returns {Promise<Object>} The result: { status, message, skipped, warnings }.
         */
        async applyResolved(resolved, notify = true) {
            let result;
            if (this.restoring) {
                result = makeResult('refused', 'A workspace is already being loaded.');
            }
            else {
                this.restoring = true;
                try {
                    result = await this.restoreResolved(resolved);
                }
                catch (error) {
                    // restoreResolved handles every error after changes start, so an error that reaches here happened before any change.
                    console.error('Workspaces: restore stopped before making changes.', error);
                    result = makeResult('refused', `Could not load the workspace: ${error.message || error}. Nothing was changed.`);
                }
                finally {
                    this.restoring = false;
                }
            }
            if (notify) {
                this.showResult(result);
            }
            return result;
        }

        /**
         * Refuses a restore while unsupported state is in use, because loading would leave it in place.
         * @param {Array<string>} warnings Warnings to carry on the result.
         * @param {boolean} explain True to add why and how to fix it.
         * @returns {Object|null} A 'refused' result, or null when nothing unsupported is in use.
         */
        refuseWhileUnsupported(warnings, explain) {
            let active = this.detectUnsupportedState();
            if (active.length == 0) {
                return null;
            }
            let one = active.length == 1;
            let why = explain ? `, because loading would leave ${one ? 'it' : 'them'} in place. Remove ${one ? 'it' : 'them'} first.` : '.';
            return makeResult('refused', `Cannot load a workspace while ${describeUnsupported(active)} ${one ? 'is' : 'are'} in use${why} Nothing was changed.`, [], warnings);
        }

        /**
         * Runs the restore steps for applyResolved. Call only through applyResolved, which manages the restoring flag.
         * @param {Object} resolved The resolved workspace.
         * @returns {Promise<Object>} The result.
         */
        async restoreResolved(resolved) {
            if (!this.isReady()) {
                return makeResult('refused', 'The Generate tab is not ready yet. Nothing was changed.');
            }
            let warnings = [];
            if (resolved.unsupported.length > 0) {
                warnings.push(`This workspace was saved while ${describeUnsupported(resolved.unsupported)} ${resolved.unsupported.length == 1 ? 'was' : 'were'} in use. Workspaces do not save that, so it was not restored.`);
            }
            let refusal = this.refuseWhileUnsupported(warnings, true);
            if (refusal) {
                return refusal;
            }
            let modelSkip = resolved.skipped.find(item => item.id == 'model');
            if (modelSkip) {
                return makeResult('refused', `The workspace's model is not available (${modelSkip.reason}). Nothing was changed.`, [], warnings);
            }
            let modelEntry = resolved.values['model'];
            let modelName = modelEntry && `${modelEntry.value}` != '' ? `${modelEntry.value}` : null;
            let modelData = null;
            if (modelName) {
                try {
                    modelData = await this.describeModel(modelName);
                }
                catch (error) {
                    return makeResult('refused', `The workspace's model "${modelName}" is not available (${error.message}). Nothing was changed.`, [], warnings);
                }
            }
            let presetCheck = this.presetsFromResolved(resolved);
            if (presetCheck.issues.length > 0 && !this.confirmPresetIssues(presetCheck.issues)) {
                return makeResult('cancelled', 'Loading was cancelled. Nothing was changed.', [], warnings);
            }
            // The UI may have changed while waiting for the server or the user, so check again right before changing anything.
            refusal = this.refuseWhileUnsupported(warnings, false);
            if (refusal) {
                return refusal;
            }
            let leaveAlone = new Set(resolved.skipped.filter(item => item.kind == 'param').map(item => item.id));
            let plan = this.buildPlan({ values: resolved.values, groups: resolved.groups, leaveAlone: leaveAlone });
            let skipped = plan.skipped.slice();
            for (let item of resolved.skipped) {
                let param = item.kind == 'param' ? gen_param_types.find(type => type.id == item.id) : null;
                this.addSkipped(skipped, { kind: item.kind == 'group' ? 'group' : 'value', id: item.id, name: param ? param.name : item.id, reason: item.reason });
            }
            if (!modelName && getRequiredElementById('input_model').value != '') {
                // Swarm has no way to clear a model selection (directSetModel ignores an empty model), so the current model stays. Report it instead of claiming success.
                skipped.push({ kind: 'value', id: 'model', name: 'Model', reason: 'the workspace has no model selected, so the current model was kept' });
            }
            for (let issue of presetCheck.issues) {
                if (issue.problem == 'missing') {
                    skipped.push({ kind: 'preset', id: issue.title, name: issue.title, reason: 'this preset no longer exists' });
                }
            }
            let previous = this.captureSnapshot();
            let previousPresets = currentPresets.slice();
            let previousModelCookie = getCookie('selected_model') || null;
            try {
                let mismatches = await this.runRestore(plan, modelData, modelName ? cleanModelName(modelData.name) : null, presetCheck.resolved);
                for (let entry of mismatches) {
                    this.addSkipped(skipped, entry);
                }
            }
            catch (error) {
                console.error('Workspaces: restore failed after changes started.', error);
                let reason = error && error.message ? error.message : `${error}`;
                if (await this.rollback(previous, previousPresets, previousModelCookie)) {
                    return makeResult('failed', `Loading the workspace failed (${reason}). Your previous settings were put back.`, [], warnings);
                }
                let partialMessage = `Loading the workspace failed (${reason}), and your previous settings could not be fully put back. Some settings are from the workspace and some are not. Check them before generating.`;
                this.markPartiallyRestored(partialMessage);
                return makeResult('partial', partialMessage, [], warnings);
            }
            this.clearPartiallyRestored();
            if (skipped.length > 0) {
                return makeResult('incomplete', `The workspace loaded, but ${skipped.length} ${skipped.length == 1 ? 'item' : 'items'} could not be restored.`, skipped, warnings);
            }
            return makeResult('success', 'Workspace loaded.', [], warnings);
        }

        /**
         * Shows a restore result to the user. A clean success and a cancel show nothing.
         * @param {Object} result The restore result.
         */
        showResult(result) {
            if (result.status == 'cancelled' || (result.status == 'success' && result.warnings.length == 0)) {
                return;
            }
            let lines = [result.message];
            for (let entry of result.skipped.slice(0, 10)) {
                lines.push(`- ${entry.name}: ${entry.reason}`);
            }
            if (result.skipped.length > 10) {
                lines.push(`...and ${result.skipped.length - 10} more.`);
            }
            showError(lines.concat(result.warnings).join('\n'));
        }

        /**
         * Marks the UI as partially restored with a notice above the parameters. The notice stays through parameter rebuilds, until a later restore finishes.
         * @param {string} message The text to show.
         */
        markPartiallyRestored(message) {
            this.partiallyRestored = true;
            let area = document.getElementById('main_inputs_area');
            if (!area || !area.parentElement) {
                return;
            }
            let banner = area.parentElement.querySelector('.hartsy-workspaces-partial');
            if (!banner) {
                banner = createDiv(null, 'hartsy-workspaces-partial');
                area.parentElement.insertBefore(banner, area);
            }
            banner.replaceChildren(createSpan(null, 'hartsy-workspaces-partial-text'));
            banner.firstChild.textContent = message;
            quickAppendButton(banner, '&times;', () => banner.remove(), ' hartsy-workspaces-partial-dismiss', 'Hide this notice');
        }

        /**
         * Clears the partially-restored mark and removes its notice.
         */
        clearPartiallyRestored() {
            this.partiallyRestored = false;
            for (let banner of document.querySelectorAll('.hartsy-workspaces-partial')) {
                banner.remove();
            }
        }
    };
}
