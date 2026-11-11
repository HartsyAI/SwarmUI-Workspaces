/**
 * Workspaces: loading only some parts of a workspace. The parts offered, and which parent groups a chosen group needs, come from the server (WorkspacesResolve), not from this page.
 */
import { restoreSucceeded } from './helpers.js';

/** Help for the Load Part dialog's "?". */
let PARTIAL_HELP_HTML = 'Loads only the parts you tick from the workspace you choose. Everything you leave unticked stays exactly as it is now. '
    + '<br><b>Model</b>: the model used by the workspace. <b>Presets</b>: which presets are active. Each group below is one group of settings, and "Other parameters" covers settings that are not in any group. '
    + '<br>Afterwards the settings count as modified, because they no longer match any single workspace.';

/**
 * Adds the Load Part dialog to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function PartialMixin(Base) {
    return class extends Base {
        /**
         * Opens the partial-load dialog, built from Swarm's standard modal markup: pick a workspace, tick the parts to load, and everything unticked stays as it is.
         */
        showPartialDialog() {
            if (this.busy || this.restoring) {
                return;
            }
            if (this.workspaces.length == 0) {
                showError('There are no saved workspaces to load from.');
                return;
            }
            if (!this.isReady()) {
                return;
            }
            let { modal, body, footer } = this.openModal('hartsy_workspaces_partial_modal', 'Load Part of Workspace', PARTIAL_HELP_HTML);
            let source = document.createElement('select');
            source.className = 'modal_text_extra';
            for (let workspace of this.sortedWorkspaces()) {
                source.append(new Option(workspace.name, workspace.id));
            }
            if (this.getCurrentEntry()) {
                source.value = this.currentId;
            }
            let sourceRow = createDiv(null, null, 'From ');
            sourceRow.append(source);
            body.append(sourceRow);
            body.append(createDiv(null, 'parens', 'Only the ticked parts change. Everything else stays as it is now.'));
            let boxes = [];
            let list = createDiv(null, 'hartsy-workspaces-dialog-list');
            body.append(list);
            let addRow = (kind, id, text, depth, hint) => {
                let label = document.createElement('label');
                label.className = 'hartsy-workspaces-dialog-item';
                label.style.paddingLeft = `${depth * 1.2}rem`;
                let box = document.createElement('input');
                box.type = 'checkbox';
                box.dataset.kind = kind;
                box.dataset.id = id;
                label.append(box, document.createTextNode(` ${text}`));
                if (hint) {
                    label.append(createDiv(null, 'parens', hint));
                }
                list.append(label);
                boxes.push(box);
            };
            let loadButton = null;
            let fillGeneration = 0;
            let fillParts = async () => {
                // Each request is numbered, so a slow answer for a workspace that is no longer selected is ignored.
                let generation = ++fillGeneration;
                list.innerHTML = '';
                boxes.length = 0;
                if (loadButton) {
                    loadButton.disabled = true;
                }
                let resolved;
                try {
                    resolved = await this.callApi('WorkspacesResolve', { id: source.value });
                }
                catch (error) {
                    if (generation == fillGeneration) {
                        list.append(createDiv(null, 'parens', `Could not read this workspace: ${error}`));
                    }
                    return;
                }
                if (generation != fillGeneration) {
                    return;
                }
                if (resolved.parts.model) {
                    addRow('model', '', 'Model', 0, null);
                }
                addRow('presets', '', 'Presets', 0, 'The preset selection changes. Your current values in unticked groups are kept.');
                for (let group of resolved.parts.groups) {
                    addRow('group', group.id, group.name, group.depth, null);
                }
                if (resolved.parts.other) {
                    addRow('other', '', 'Other parameters (no group)', 0, null);
                }
                if (loadButton) {
                    loadButton.disabled = false;
                }
            };
            source.addEventListener('change', fillParts);
            let setAll = checked => {
                for (let box of boxes) {
                    box.checked = checked;
                }
            };
            this.addModalButton(footer, 'Select all', false, () => setAll(true));
            this.addModalButton(footer, 'Select none', false, () => setAll(false));
            this.addModalButton(footer, 'Cancel', false, () => $(modal).modal('hide'));
            loadButton = this.addModalButton(footer, 'Load', true, () => {
                let selection = { model: false, presets: false, other: false, groups: [] };
                for (let box of boxes) {
                    if (box.checked && box.dataset.kind == 'group') {
                        selection.groups.push(box.dataset.id);
                    }
                    else if (box.checked) {
                        selection[box.dataset.kind] = true;
                    }
                }
                let sourceId = source.value;
                $(modal).modal('hide');
                this.partialLoad(sourceId, selection);
            });
            fillParts();
            $(modal).modal('show');
        }

        /**
         * Combines a partial resolve with the Generate tab as it is now: everything that was not chosen stays exactly as it is, so applying the result changes only the chosen parts.
         * The server says which parent groups must be switched on for a chosen group to work; each is switched on only if it is off now, and a note says so.
         * @param {Object} resolved The response of WorkspacesResolve for a part selection.
         * @returns {Object} { merged, notes }: the full state to apply, and readable notes about extra changes.
         */
        mergeIntoCurrent(resolved) {
            let current = this.captureSnapshot();
            let merged = {
                values: Object.assign(current.values, resolved.values),
                groups: current.groups,
                presets: resolved.presets || current.presets.map(preset => ({ title: preset.title, status: 'ok' })),
                skipped: resolved.skipped,
                unsupported: resolved.unsupported
            };
            for (let id of Object.keys(resolved.groups)) {
                if (merged.groups[id]) {
                    merged.groups[id].enabled = resolved.groups[id].enabled;
                }
            }
            let notes = [];
            for (let parent of resolved.enable_groups) {
                if (merged.groups[parent.id] && !merged.groups[parent.id].enabled) {
                    merged.groups[parent.id].enabled = true;
                    notes.push(`"${parent.name}" was switched on, because "${parent.because.name}" is inside it.`);
                }
            }
            return { merged: merged, notes: notes };
        }

        /**
         * Loads the chosen parts of a workspace into the Generate tab. The current workspace and its baseline stay as they are, so the result shows as modified.
         * @param {string} sourceId The workspace to load from.
         * @param {Object} selection The chosen parts: { model, presets, other, groups: [group IDs] }.
         */
        async partialLoad(sourceId, selection) {
            if (this.busy || this.restoring) {
                return;
            }
            if (!selection.model && !selection.presets && !selection.other && selection.groups.length == 0) {
                showError('Nothing was ticked, so nothing was loaded.');
                return;
            }
            await this.runBusy(async () => {
                let resolved;
                try {
                    resolved = await this.callApi('WorkspacesResolve', { id: sourceId, parts: selection });
                }
                catch (error) {
                    showError(`Could not load the chosen parts: ${error}`);
                    return;
                }
                let combined = this.mergeIntoCurrent(resolved);
                let result = await this.applyResolved(combined.merged, false);
                if (result.status == 'success') {
                    result.message = 'The chosen parts were loaded.';
                }
                result.warnings.push(...combined.notes);
                this.showResult(result);
                if (restoreSucceeded(result)) {
                    this.setStatus(`Loaded the chosen parts of "${resolved.workspace.name}".`);
                }
            });
        }
    };
}
