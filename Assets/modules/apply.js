/**
 * Workspaces: writing the Generate tab. Plans a restore against the controls that exist now, applies it in a fixed order, and rolls it back.
 */
import { isMultiSelect, optionValues, toList, valuesEqual } from './helpers.js';

/**
 * Returns the order a parameter is restored in. Resolution and LoRA values that other handlers derive from come last.
 * @param {string} paramId The parameter ID.
 * @returns {number} Lower values are restored first.
 */
function getValueOrder(paramId) {
    if (paramId == 'aspectratio') {
        return 1;
    }
    if (paramId == 'width' || paramId == 'height' || paramId == 'loras') {
        return 2;
    }
    return 0;
}

/**
 * Adds applying and rolling back a restore to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function ApplyMixin(Base) {
    return class extends Base {
        /**
         * Creates the apply timings.
         */
        constructor() {
            super();
            /** Longest wait for the server to describe a model, in milliseconds. */
            this.modelRequestTimeoutMs = 30000;
            /** Longest wait for model and resolution updates to settle after a model change, in milliseconds. */
            this.settleTimeoutMs = 5000;
            /** How often to re-check a pending operation while waiting for it, in milliseconds. */
            this.settlePollMs = 10;
        }

        /**
         * Asks the server to describe a model, with a bounded wait. This is a read and changes nothing.
         * @param {string} name The model name, as shown in the model dropdown.
         * @returns {Promise<Object>} Resolves to the model data; rejects if the model is unknown, the request fails, or it times out.
         */
        async describeModel(name) {
            let timer = null;
            let timeout = new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('the server did not answer in time')), this.modelRequestTimeoutMs);
            });
            try {
                let data = await Promise.race([this.callApi('DescribeModel', { modelName: name }).catch(error => {
                    throw new Error(`${error}`);
                }), timeout]);
                if (!data.model || !data.model.name) {
                    throw new Error('the server returned no model data');
                }
                return data.model;
            }
            finally {
                clearTimeout(timer);
            }
        }

        /**
         * Waits until a condition holds, checking again each poll interval, up to a time limit.
         * @param {Function} condition Returns true when the pending operation is done.
         * @param {number} timeoutMs The longest wait, in milliseconds.
         * @returns {Promise<boolean>} True if the condition held, false on timeout. Rejects if the condition throws.
         */
        async waitFor(condition, timeoutMs) {
            let start = Date.now();
            while (!condition()) {
                if (Date.now() - start >= timeoutMs) {
                    return false;
                }
                await sleep(this.settlePollMs);
            }
            return true;
        }

        /**
         * Works out exactly what a restore will set, against the parameters that exist now. Changes nothing.
         * Parameters added since capture get their defaults and an off switch. Values that are no longer available are listed as skipped and also reset to defaults.
         * @param {Object} snapshot A validated snapshot: { values, groups, leaveAlone }.
         * @returns {Object} { modelName, values: [{ param, elem, value, enabled, fromSnapshot }], groups: [{ id, name, enabled }], skipped: [...] }.
         */
        buildPlan(snapshot) {
            let plan = { modelName: null, values: [], groups: [], skipped: [] };
            let modelEntry = snapshot.values['model'];
            if (modelEntry && `${modelEntry.value}` != '') {
                plan.modelName = `${modelEntry.value}`;
            }
            let known = new Set();
            let removedLoraIndices = [];
            for (let param of gen_param_types) {
                if (!this.isCapturableParam(param)) {
                    continue;
                }
                known.add(param.id);
                let entry = snapshot.values[param.id];
                if (param.id == 'model' || (!entry && snapshot.leaveAlone && snapshot.leaveAlone.has(param.id))) {
                    // The model is applied separately. A value the server could not use was reported as skipped, so the Generate tab keeps what it has now.
                    continue;
                }
                let elem = this.getParamElem(param);
                let item = { param: param, elem: elem, value: this.defaultValueFor(param, elem), enabled: false, fromSnapshot: false };
                if (entry) {
                    this.planEntry(item, entry, plan, removedLoraIndices);
                }
                plan.values.push(item);
            }
            if (removedLoraIndices.length > 0) {
                // The LoRA weights and confinements are lists parallel to the LoRA list, so drop the entries of the LoRAs that were removed.
                for (let item of plan.values) {
                    if ((item.param.id == 'loraweights' || item.param.id == 'lorasectionconfinement') && typeof item.value == 'string' && item.value != '') {
                        item.value = item.value.split(',').filter((part, i) => !removedLoraIndices.includes(i)).join(',');
                    }
                }
            }
            for (let id of Object.keys(snapshot.values)) {
                if (!known.has(id)) {
                    plan.skipped.push({ kind: 'value', id: id, name: id, reason: 'this parameter is not available' });
                }
            }
            plan.values.sort((a, b) => getValueOrder(a.param.id) - getValueOrder(b.param.id));
            let groupIds = new Set();
            for (let group of this.listToggleGroups()) {
                groupIds.add(group.id);
                let entry = snapshot.groups[group.id];
                plan.groups.push({ id: group.id, name: group.name, enabled: entry ? entry.enabled : false });
            }
            for (let id of Object.keys(snapshot.groups)) {
                if (!groupIds.has(id)) {
                    plan.skipped.push({ kind: 'group', id: id, name: id, reason: 'this group is not available' });
                }
            }
            return plan;
        }

        /**
         * Fills a plan item from a saved entry. Saved options that no longer exist are listed as skipped and left at the default.
         * @param {Object} item The plan item, holding the default.
         * @param {Object} entry The saved { value, enabled }.
         * @param {Object} plan The plan being built; skipped values are added to it.
         * @param {Array<number>} removedLoraIndices Collects the positions of LoRAs that are no longer available.
         */
        planEntry(item, entry, plan, removedLoraIndices) {
            let param = item.param;
            let elem = item.elem;
            let value = `${entry.value}`;
            if (isMultiSelect(elem)) {
                let options = optionValues(elem);
                let kept = [];
                let list = toList(entry.value);
                for (let i = 0; i < list.length; i++) {
                    // An empty entry means "no items", so there is nothing to keep or report.
                    if (`${list[i]}` == '') {
                        continue;
                    }
                    if (options.includes(list[i])) {
                        kept.push(list[i]);
                        continue;
                    }
                    plan.skipped.push({ kind: 'value', id: param.id, name: param.name, reason: `"${list[i]}" is not available` });
                    if (param.id == 'loras') {
                        removedLoraIndices.push(i);
                    }
                }
                item.value = kept;
            }
            else if (elem.tagName == 'SELECT') {
                if (optionValues(elem).includes(value)) {
                    item.value = value;
                }
                else if (value == '' && elem.value == '') {
                    // Saved as empty and still empty now: there is no value to restore, so it is not a skip. The saved switch state still applies.
                    item.value = '';
                }
                else {
                    plan.skipped.push({ kind: 'value', id: param.id, name: param.name, reason: `"${entry.value}" is not available` });
                    return;
                }
            }
            else {
                item.value = entry.value;
            }
            item.enabled = entry.enabled;
            item.fromSnapshot = true;
        }

        /**
         * Moves the given values' options to the end of a multi-select, in the given order, so the selection order sent to the server matches.
         * Swarm sends multi-select values in option order, so this is how LoRA order is restored. Does nothing if the order already matches.
         * @param {HTMLSelectElement} elem The multi-select.
         * @param {Array<string>} values The wanted values, in order.
         */
        orderSelectOptions(elem, values) {
            let options = Array.from(elem.options);
            if (arraysEqual(options.map(option => option.value).filter(value => values.includes(value)), values)) {
                return;
            }
            for (let value of values) {
                let option = options.find(candidate => candidate.value == value);
                if (option) {
                    elem.appendChild(option);
                }
            }
        }

        /**
         * Sets one planned parameter value.
         * @param {Object} item The plan entry.
         * @param {boolean} trigger True to fire the input's change handlers (first pass); false for a quiet correction that fires none.
         */
        applyValue(item, trigger) {
            let value = item.value;
            if (isMultiSelect(item.elem)) {
                value = toList(value);
                this.orderSelectOptions(item.elem, value);
            }
            else if (item.elem.tagName == 'SELECT') {
                value = `${value}`;
            }
            setDirectParamValue(item.param, value, item.elem, false, trigger);
            if (item.elem.tagName == 'SELECT' && !item.elem.multiple) {
                // A value missing from the dropdown is parked by setDirectParamValue to apply on a later refresh. Drop it, so the UI keeps what the restore reported.
                delete item.elem.dataset.wantsValue;
            }
        }

        /**
         * Sets a parameter's own switch.
         * @param {Object} item The plan entry.
         * @param {boolean} trigger True to fire the switch's change handlers; false to only update the switch and its disabled styling.
         */
        applyParamToggle(item, trigger) {
            let toggler = document.getElementById(`input_${item.param.id}_toggle`);
            if (!toggler) {
                return;
            }
            toggler.checked = item.enabled;
            if (trigger) {
                triggerChangeFor(toggler);
            }
            else {
                doToggleEnable(`input_${item.param.id}`);
            }
        }

        /**
         * Sets a toggle group's switch.
         * @param {Object} group The plan entry: { id, enabled }.
         * @param {boolean} trigger True to fire the switch's change handlers; false to only call doToggleGroup.
         */
        applyGroupToggle(group, trigger) {
            let toggler = this.getGroupToggle(group.id);
            if (!toggler) {
                return;
            }
            toggler.checked = group.enabled;
            if (trigger) {
                triggerChangeFor(toggler);
            }
            else {
                doToggleGroup(`input_group_content_${group.id}`);
            }
        }

        /**
         * Replaces the active presets with the given list, in order. Presets are sent by title with each generation; they are not applied into parameter values.
         * @param {Array<Object>} presets Preset data objects.
         */
        applyPresets(presets) {
            currentPresets.length = 0;
            for (let preset of presets) {
                currentPresets.push(preset);
            }
            updatePresetList();
            presetBrowser.rerender();
        }

        /**
         * Selects a model and waits for the model change to settle.
         * Clears the model helper's pending model request first, so an earlier model switch still in flight cannot land after the restore and overwrite it.
         * @param {Object|string} modelData Model data from DescribeModel, or a saved 'selected_model' cookie string.
         * @param {string} expectedName The dropdown value the model should end up with.
         */
        async applyModel(modelData, expectedName) {
            currentModelHelper.desiredModel = null;
            currentModelHelper.directSetModel(modelData);
            let settled = await this.waitFor(() => {
                let scheduled = typeof isParamUnsupportableUpdateScheduled != 'undefined' && isParamUnsupportableUpdateScheduled;
                return !currentModelHelper.antiDup && !scheduled && getRequiredElementById('input_model').value == expectedName;
            }, this.settleTimeoutMs);
            if (!settled) {
                throw new Error('the model change did not finish in time');
            }
        }

        /**
         * Lists the planned values, switches, and groups that the UI does not currently match.
         * @param {Object} plan The restore plan.
         * @returns {Object} { values, toggles, groups }: the plan entries that differ.
         */
        findDrift(plan) {
            let drift = { values: [], toggles: [], groups: [] };
            for (let item of plan.values) {
                // A select with no options cannot hold any value, so it cannot drift from its default.
                let optionless = item.elem && item.elem.tagName == 'SELECT' && item.elem.options.length == 0;
                if (!optionless && !valuesEqual(item.param, this.readParamValue(item.param, item.elem), item.value)) {
                    drift.values.push(item);
                }
                if (item.param.toggleable && this.isParamToggleOn(item.param) != item.enabled) {
                    drift.toggles.push(item);
                }
            }
            for (let group of plan.groups) {
                let toggler = this.getGroupToggle(group.id);
                if (!toggler || toggler.checked != group.enabled) {
                    drift.groups.push(group);
                }
            }
            return drift;
        }

        /**
         * Applies a plan to the UI in the fixed restore order. This is the only method that changes the UI.
         * Order: model (then wait for it to settle), dependent values, presets, per-parameter switches, group switches, a quiet correction pass for anything a handler changed, then LoRA and visibility reconciliation.
         * Workflow context needs no step: restores are refused while a custom workflow is active, and snapshots never contain one.
         * @param {Object} plan The restore plan from buildPlan.
         * @param {Object|string} modelData Model data to select, or null to leave the model alone.
         * @param {string} modelName The dropdown value the model should end up with.
         * @param {Array<Object>} presets Preset data objects to make active, in order.
         * @returns {Promise<Array>} Items that still do not match after the restore, as skipped-item entries.
         */
        async runRestore(plan, modelData, modelName, presets) {
            if (modelData) {
                await this.applyModel(modelData, modelName);
            }
            // Values fire their normal handlers, so mirrors (prompt box, LoRA list, resolution label) update. Setting a value also switches its group on; the group step below sets groups afterwards.
            for (let item of plan.values) {
                this.applyValue(item, true);
            }
            this.applyPresets(presets);
            for (let item of plan.values) {
                if (item.param.toggleable) {
                    this.applyParamToggle(item, true);
                }
            }
            for (let group of plan.groups) {
                this.applyGroupToggle(group, true);
            }
            // Switch handlers can recompute values (the side-length switch re-runs the aspect ratio handler, which rewrites width and height). Correct those quietly, without firing handlers again.
            let drift = this.findDrift(plan);
            for (let item of drift.values) {
                this.applyValue(item, false);
            }
            for (let item of drift.toggles) {
                this.applyParamToggle(item, false);
            }
            for (let group of drift.groups) {
                this.applyGroupToggle(group, false);
            }
            let widthInput = document.getElementById('input_width');
            if (widthInput && drift.values.some(item => item.param.id == 'width' || item.param.id == 'height')) {
                // The resolution label only listens for 'input', so this refreshes it without re-running the change handlers.
                widthInput.dispatchEvent(new Event('input'));
            }
            if (document.getElementById('input_loras')) {
                loraHelper.loadFromParams();
                sdLoraBrowser.rebuildSelectedClasses();
            }
            hideUnsupportableParams();
            let mismatches = [];
            let remaining = this.findDrift(plan);
            for (let item of remaining.values) {
                mismatches.push({ kind: 'value', id: item.param.id, name: item.param.name, reason: item.fromSnapshot ? 'could not be set to the saved value' : 'could not be reset to its default' });
            }
            for (let item of remaining.toggles) {
                mismatches.push({ kind: 'switch', id: item.param.id, name: item.param.name, reason: 'its switch could not be set' });
            }
            for (let group of remaining.groups) {
                mismatches.push({ kind: 'group', id: group.id, name: group.name, reason: 'its switch could not be set' });
            }
            return mismatches;
        }

        /**
         * Puts back the state captured before a failed restore.
         * @param {Object} previous The snapshot captured just before the restore changed anything.
         * @param {Array<Object>} previousPresets The preset data objects that were active.
         * @param {string} previousModelCookie The 'selected_model' cookie from before the restore, or null.
         * @returns {Promise<boolean>} True if the previous state was fully put back.
         */
        async rollback(previous, previousPresets, previousModelCookie) {
            try {
                let plan = this.buildPlan(previous);
                let modelData = null;
                if (plan.modelName) {
                    if (previousModelCookie && previousModelCookie.split(',')[0] == plan.modelName) {
                        modelData = previousModelCookie;
                    }
                    else {
                        modelData = await this.describeModel(plan.modelName);
                    }
                }
                let mismatches = await this.runRestore(plan, modelData, plan.modelName, previousPresets);
                let previousModel = previous.values['model'] ? `${previous.values['model'].value}` : '';
                if (getRequiredElementById('input_model').value != previousModel) {
                    // The model is not part of plan.values, so check it here. This also catches the case where no model was selected before: there is nothing to select back.
                    mismatches.push({ kind: 'value', id: 'model', name: 'Model', reason: 'the previous model could not be selected again' });
                }
                if (plan.skipped.length > 0 || mismatches.length > 0) {
                    console.error('Workspaces: rollback left items that do not match.', plan.skipped, mismatches);
                    return false;
                }
                return true;
            }
            catch (error) {
                console.error('Workspaces: rollback failed.', error);
                return false;
            }
        }
    };
}
