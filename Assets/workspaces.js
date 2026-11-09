/**
 * Workspaces: named snapshots of the Generate tab's configuration.
 *
 * Public entry points (used by the toolbar):
 * - captureSnapshot(): returns a schema v1 snapshot of the current Generate tab.
 * - applySnapshot(snapshot, options): restores a snapshot (or a stored workspace entry) in a fixed order, and resolves to a result object.
 * - listWorkspaces(): fetches the user's stored workspaces from the server.
 * - isRestoring(): true while a restore runs. Modified-state tracking and draft saving must do nothing while this is true.
 * - restoreFinishedCallbacks: functions called with each restore result, after isRestoring() is false again.
 *
 * Restore results have the form { status, message, skipped, warnings }, where status is one of:
 * 'success' (everything restored), 'incomplete' (finished, but some items in 'skipped' could not be restored),
 * 'refused' (nothing was changed), 'cancelled' (the user declined, nothing was changed),
 * 'failed' (an error happened after changes started, and the previous settings were put back),
 * 'partial' (an error happened and the previous settings could not be put back; the UI is marked partially restored).
 * Only 'success' and 'incomplete' mean the UI now holds the workspace, so only those may reset a modified-state baseline.
 */
class HartsyWorkspacesManager {
    /**
     * Creates the manager. Holds the cached workspace list and the restore state for this page.
     */
    constructor() {
        /** The user's workspaces, as last returned by the server. */
        this.workspaces = [];
        /** Snapshot schema version this script reads and writes. */
        this.schemaVersion = 1;
        /** True while a restore is running. */
        this.restoring = false;
        /** True after a failed restore could not put the previous settings back, until a later restore finishes. */
        this.partiallyRestored = false;
        /** Functions called as callback(result) after every applySnapshot call finishes. */
        this.restoreFinishedCallbacks = [];
        /** Longest wait for the server to describe a model, in milliseconds. */
        this.modelRequestTimeoutMs = 30000;
        /** Longest wait for model and resolution updates to settle after a model change, in milliseconds. */
        this.settleTimeoutMs = 5000;
        /** How often to re-check a pending operation while waiting for it, in milliseconds. */
        this.settlePollMs = 10;
        /** Parameter IDs never captured or restored: custom workflow data, which is outside the supported scope. */
        this.excludedParamIds = ['comfyworkflowraw', 'comfyworkflowparammetadata', 'comfyuicustomworkflow'];
        /** Parameter types never captured or restored: media inputs (setDirectParamValue cannot restore raw image data). */
        this.mediaParamTypes = ['image', 'audio', 'video', 'image_list', 'audio_list', 'video_list'];
        /** Readable names for the unsupported-state IDs stored in a snapshot's 'unsupported' list. */
        this.unsupportedLabels = {
            custom_workflow: 'a custom Comfy workflow',
            init_image: 'an init image',
            mask: 'a mask image',
            image_editor: 'the image editor'
        };
    }

    /**
     * Fetches the user's workspaces from the server and caches them.
     * @returns {Promise<Array>} Resolves to the workspace list; rejects with the server's error message.
     */
    listWorkspaces() {
        return new Promise((resolve, reject) => {
            genericRequest('WorkspacesList', {}, data => {
                this.workspaces = data.workspaces || [];
                resolve(this.workspaces);
            }, 0, error => {
                reject(error);
            });
        });
    }

    /**
     * Loads the workspace list when the page session is ready. Shows an error if the request fails.
     */
    loadWorkspaces() {
        this.listWorkspaces().catch(error => {
            console.error('Workspaces: failed to load the workspace list.', error);
            showError(`Failed to load workspaces: ${error}`);
        });
    }

    /**
     * Returns whether a restore is running. Modified-state tracking and draft saving must skip their work while this is true.
     * @returns {boolean} True during a restore.
     */
    isRestoring() {
        return this.restoring;
    }

    /**
     * Returns whether the Generate tab's parameters have been built.
     * @returns {boolean} True if parameters are available.
     */
    isReady() {
        return typeof gen_param_types != 'undefined' && gen_param_types != null && document.getElementById('main_inputs_area') != null;
    }

    /**
     * Captures the current Generate-tab state as a schema v1 snapshot.
     * Server-owned fields (id, name, revision, timestamps) are added by the server when the snapshot is saved.
     * @returns {Object} The snapshot: { schemaVersion, values, groups, presets, unsupported }.
     */
    captureSnapshot() {
        if (!this.isReady()) {
            throw new Error('The Generate tab is not ready yet.');
        }
        let values = {};
        for (let param of gen_param_types) {
            if (!this.isCapturableParam(param)) {
                continue;
            }
            values[param.id] = {
                value: this.readParamValue(param, this.getParamElem(param)),
                enabled: this.isParamToggleOn(param)
            };
        }
        return {
            schemaVersion: this.schemaVersion,
            values: values,
            groups: this.captureGroups(),
            presets: this.capturePresets(),
            unsupported: this.detectUnsupportedState()
        };
    }

    /**
     * Captures the on/off state of every toggle group in the UI, nested groups included.
     * @returns {Object} Map of group ID to { enabled, parent }.
     */
    captureGroups() {
        let groups = {};
        for (let group of this.listToggleGroups()) {
            groups[group.id] = {
                enabled: this.getGroupToggle(group.id).checked,
                parent: this.getParentGroupId(group)
            };
        }
        return groups;
    }

    /**
     * Captures the active presets in selection order, each with a fingerprint of its definition.
     * @returns {Array} List of { title, fingerprint }.
     */
    capturePresets() {
        let presets = [];
        for (let preset of currentPresets) {
            presets.push({ title: preset.title, fingerprint: this.fingerprintPreset(preset) });
        }
        return presets;
    }

    /**
     * Lists the unsupported state present in the current UI: a custom Comfy workflow, an init image, a mask image, or an open image editor.
     * Init and mask images count when they hold data, even if their group is off, because a restore could switch that group on.
     * @returns {Array<string>} IDs of the unsupported state found.
     */
    detectUnsupportedState() {
        let found = [];
        let customWorkflow = false;
        for (let param of gen_param_types) {
            if (param.id == 'comfyworkflowraw') {
                customWorkflow = true;
            }
            else if (param.id == 'comfyuicustomworkflow') {
                let elem = this.getParamElem(param);
                if (elem && elem.value && this.isParamToggleOn(param)) {
                    customWorkflow = true;
                }
            }
        }
        if (customWorkflow) {
            found.push('custom_workflow');
        }
        if (this.hasMediaData('initimage')) {
            found.push('init_image');
        }
        if (this.hasMediaData('maskimage')) {
            found.push('mask');
        }
        if (typeof imageEditor != 'undefined' && imageEditor && imageEditor.active) {
            found.push('image_editor');
        }
        return found;
    }

    /**
     * Returns whether a media parameter's input currently holds a file.
     * @param {string} paramId The parameter ID.
     * @returns {boolean} True if the input has file data.
     */
    hasMediaData(paramId) {
        let elem = document.getElementById(`input_${paramId}`);
        return elem != null && elem.dataset.filedata ? true : false;
    }

    /**
     * Returns the main input element for a parameter, or null if it is not rendered.
     * @param {Object} param The parameter definition.
     * @returns {HTMLElement} The input element, or null.
     */
    getParamElem(param) {
        return document.getElementById(`input_${param.id}`);
    }

    /**
     * Returns the toggle checkbox of a toggle group, or null if the group has none in the UI.
     * @param {string} groupId The group ID.
     * @returns {HTMLInputElement} The toggle, or null.
     */
    getGroupToggle(groupId) {
        return document.getElementById(`input_group_content_${groupId}_toggle`);
    }

    /**
     * Returns whether a parameter is in the supported scope: rendered, not a media input, and not custom-workflow data.
     * @param {Object} param The parameter definition.
     * @returns {boolean} True if the parameter is captured and restored.
     */
    isCapturableParam(param) {
        if (this.excludedParamIds.includes(param.id) || this.mediaParamTypes.includes(param.type)) {
            return false;
        }
        return this.getParamElem(param) != null;
    }

    /**
     * Returns whether an element is a multi-select (an ordered list parameter such as LoRAs).
     * @param {HTMLElement} elem The input element.
     * @returns {boolean} True for a multi-select.
     */
    isMultiSelect(elem) {
        return elem.tagName == 'SELECT' && elem.multiple;
    }

    /**
     * Returns the state of a parameter's own switch. Parameters without a switch report true.
     * This is the switch state only, not visibility or group state (see isParamEnabled in params.js for the combined check).
     * @param {Object} param The parameter definition.
     * @returns {boolean} True if the switch is on, or the parameter has no switch.
     */
    isParamToggleOn(param) {
        if (!param.toggleable) {
            return true;
        }
        let toggler = document.getElementById(`input_${param.id}_toggle`);
        return toggler != null && toggler.checked;
    }

    /**
     * Reads a parameter's value as typed JSON: booleans as booleans, numbers as numbers (unsafe integers such as large seeds stay strings), multi-selects as ordered arrays.
     * @param {Object} param The parameter definition.
     * @param {HTMLElement} elem The parameter's input element.
     * @returns {*} The value.
     */
    readParamValue(param, elem) {
        let raw = getInputVal(elem, true);
        if (Array.isArray(raw)) {
            return raw.slice();
        }
        if (param.type == 'boolean') {
            return `${raw}` == 'true';
        }
        if (param.type == 'integer' || param.type == 'decimal') {
            return this.normalizeNumber(param, raw);
        }
        return raw == null ? '' : `${raw}`;
    }

    /**
     * Converts a numeric input value to a number when that is lossless; otherwise returns the trimmed text.
     * @param {Object} param The parameter definition (integer or decimal).
     * @param {*} raw The raw value.
     * @returns {number|string} The normalized value.
     */
    normalizeNumber(param, raw) {
        let text = raw == null ? '' : `${raw}`.trim();
        if (text == '') {
            return '';
        }
        let num = Number(text);
        if (!Number.isFinite(num)) {
            return text;
        }
        if (param.type == 'integer' && !Number.isSafeInteger(num)) {
            return text;
        }
        return num;
    }

    /**
     * Converts a list value (array or comma-separated string) to an array of strings.
     * @param {*} value The value.
     * @returns {Array<string>} The list.
     */
    toList(value) {
        if (Array.isArray(value)) {
            let list = [];
            for (let item of value) {
                list.push(`${item}`);
            }
            return list;
        }
        if (value == null || `${value}`.trim() == '') {
            return [];
        }
        let list = [];
        for (let item of `${value}`.split(',')) {
            if (item.trim() != '') {
                list.push(item.trim());
            }
        }
        return list;
    }

    /**
     * Compares two values of a parameter after normalizing them the same way capture does.
     * @param {Object} param The parameter definition.
     * @param {*} left One value.
     * @param {*} right The other value.
     * @returns {boolean} True if they are the same.
     */
    valuesEqual(param, left, right) {
        if (Array.isArray(left) || Array.isArray(right)) {
            let a = this.toList(left);
            let b = this.toList(right);
            if (a.length != b.length) {
                return false;
            }
            for (let i = 0; i < a.length; i++) {
                if (a[i] != b[i]) {
                    return false;
                }
            }
            return true;
        }
        if (param.type == 'integer' || param.type == 'decimal') {
            return `${this.normalizeNumber(param, left)}` == `${this.normalizeNumber(param, right)}`;
        }
        return `${left == null ? '' : left}` == `${right == null ? '' : right}`;
    }

    /**
     * Returns a parameter's registered default value, in a form setDirectParamValue accepts.
     * @param {Object} param The parameter definition.
     * @param {HTMLElement} elem The parameter's input element.
     * @returns {*} The default value.
     */
    defaultValueFor(param, elem) {
        if (this.isMultiSelect(elem)) {
            return this.toList(param.default);
        }
        if (param.type == 'boolean') {
            return `${param.default}` == 'true';
        }
        return param.default == null ? '' : param.default;
    }

    /**
     * Returns every toggle group present in the UI, parents before children.
     * @returns {Array<Object>} The group definitions.
     */
    listToggleGroups() {
        let found = {};
        let groups = [];
        for (let param of gen_param_types) {
            for (let start of [param.group, param.original_group]) {
                let group = start;
                while (group && typeof group == 'object') {
                    if (group.toggles && !found[group.id] && this.getGroupToggle(group.id)) {
                        found[group.id] = true;
                        groups.push(group);
                    }
                    group = group.parent;
                }
            }
        }
        groups.sort((a, b) => this.getGroupDepth(a) - this.getGroupDepth(b));
        return groups;
    }

    /**
     * Returns how many parent groups a group has.
     * @param {Object} group The group definition.
     * @returns {number} The nesting depth (0 for a top-level group).
     */
    getGroupDepth(group) {
        let depth = 0;
        let parent = group.parent;
        while (parent && typeof parent == 'object') {
            depth++;
            parent = parent.parent;
        }
        return depth;
    }

    /**
     * Returns the ID of a group's direct parent group, or null for a top-level group.
     * @param {Object} group The group definition.
     * @returns {string} The parent ID, or null.
     */
    getParentGroupId(group) {
        if (!group.parent) {
            return null;
        }
        if (typeof group.parent == 'object') {
            return group.parent.id;
        }
        return `${group.parent}`;
    }

    /**
     * Fingerprints a preset's definition (its parameter map), so a restore can tell whether the preset changed since capture.
     * @param {Object} preset The preset data.
     * @returns {string} The fingerprint.
     */
    fingerprintPreset(preset) {
        let json = this.stableStringify(preset.param_map || {});
        let hash = (hashCode(json) || 0) >>> 0;
        return `v1-${hash.toString(16)}-${json.length}`;
    }

    /**
     * Serializes a value as JSON with object keys sorted, so equal content always gives equal text.
     * @param {*} value The value.
     * @returns {string} The JSON text.
     */
    stableStringify(value) {
        if (Array.isArray(value)) {
            let parts = [];
            for (let item of value) {
                parts.push(this.stableStringify(item));
            }
            return `[${parts.join(',')}]`;
        }
        if (value != null && typeof value == 'object') {
            let parts = [];
            for (let key of Object.keys(value).sort()) {
                parts.push(`${JSON.stringify(key)}:${this.stableStringify(value[key])}`);
            }
            return `{${parts.join(',')}}`;
        }
        if (value == null) {
            return 'null';
        }
        return JSON.stringify(value);
    }

    /**
     * Returns whether a value is a plain object (not null, not an array).
     * @param {*} value The value.
     * @returns {boolean} True for a plain object.
     */
    isPlainObject(value) {
        return value != null && typeof value == 'object' && !Array.isArray(value);
    }

    /**
     * Returns whether a stored parameter value has a type this script can restore.
     * @param {*} value The value.
     * @returns {boolean} True for a boolean, finite number, string, or array of strings and numbers.
     */
    isRestorableValue(value) {
        if (typeof value == 'boolean' || typeof value == 'string') {
            return true;
        }
        if (typeof value == 'number') {
            return Number.isFinite(value);
        }
        if (Array.isArray(value)) {
            for (let item of value) {
                if (typeof item != 'string' && !(typeof item == 'number' && Number.isFinite(item))) {
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    /**
     * Checks the whole snapshot's structure before anything is changed. Extra fields (id, name, revision, timestamps) are allowed.
     * @param {Object} snapshot The snapshot or stored workspace entry.
     * @returns {string} A description of the first problem, or null if the snapshot is valid.
     */
    validateSnapshot(snapshot) {
        if (!this.isPlainObject(snapshot)) {
            return 'the workspace data is not an object.';
        }
        let version = snapshot.schemaVersion;
        if (!Number.isInteger(version)) {
            return "it has no 'schemaVersion'.";
        }
        if (version > this.schemaVersion) {
            return `it uses schema version ${version}, which is newer than this extension supports (${this.schemaVersion}). Update the Workspaces extension to load it.`;
        }
        if (version != this.schemaVersion) {
            return `it uses unknown schema version ${version}.`;
        }
        if (!this.isPlainObject(snapshot.values)) {
            return "'values' is missing or is not an object.";
        }
        for (let id of Object.keys(snapshot.values)) {
            let entry = snapshot.values[id];
            if (!this.isPlainObject(entry)) {
                return `'values.${id}' is not an object.`;
            }
            if (typeof entry.enabled != 'boolean') {
                return `'values.${id}.enabled' is not a boolean.`;
            }
            if (!this.isRestorableValue(entry.value)) {
                return `'values.${id}.value' is missing or has an unsupported type.`;
            }
        }
        if (!this.isPlainObject(snapshot.groups)) {
            return "'groups' is missing or is not an object.";
        }
        for (let id of Object.keys(snapshot.groups)) {
            let entry = snapshot.groups[id];
            if (!this.isPlainObject(entry)) {
                return `'groups.${id}' is not an object.`;
            }
            if (typeof entry.enabled != 'boolean') {
                return `'groups.${id}.enabled' is not a boolean.`;
            }
            if ('parent' in entry && entry.parent != null && typeof entry.parent != 'string') {
                return `'groups.${id}.parent' must be a group ID or null.`;
            }
        }
        if (!Array.isArray(snapshot.presets)) {
            return "'presets' is missing or is not a list.";
        }
        for (let preset of snapshot.presets) {
            if (!this.isPlainObject(preset) || typeof preset.title != 'string' || typeof preset.fingerprint != 'string') {
                return "each entry in 'presets' needs a 'title' and a 'fingerprint'.";
            }
        }
        if (!Array.isArray(snapshot.unsupported)) {
            return "'unsupported' is missing or is not a list.";
        }
        for (let item of snapshot.unsupported) {
            if (typeof item != 'string') {
                return "each entry in 'unsupported' must be text.";
            }
        }
        return null;
    }

    /**
     * Joins readable labels for a list of unsupported-state IDs.
     * @param {Array<string>} ids The IDs.
     * @returns {string} The labels, joined with commas and "and".
     */
    describeUnsupported(ids) {
        let labels = [];
        for (let id of ids) {
            labels.push(this.unsupportedLabels[id] || id);
        }
        if (labels.length <= 1) {
            return labels.join('');
        }
        return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    }

    /**
     * Matches the snapshot's presets against the presets that exist now.
     * @param {Object} snapshot A validated snapshot.
     * @returns {Object} { resolved: preset data in saved order (missing ones left out), issues: [{ title, problem: 'missing' | 'changed' }] }.
     */
    checkPresets(snapshot) {
        let resolved = [];
        let issues = [];
        for (let saved of snapshot.presets) {
            let current = null;
            for (let preset of allPresetsUnsorted || []) {
                if (preset.title == saved.title) {
                    current = preset;
                    break;
                }
            }
            if (!current) {
                issues.push({ title: saved.title, problem: 'missing' });
                continue;
            }
            if (this.fingerprintPreset(current) != saved.fingerprint) {
                issues.push({ title: saved.title, problem: 'changed' });
            }
            if (!resolved.includes(current)) {
                resolved.push(current);
            }
        }
        return { resolved: resolved, issues: issues };
    }

    /**
     * Asks the user whether to continue when presets are missing or changed. Uses options.confirmPresets if given, else the browser's confirm dialog.
     * @param {Array} issues The preset issues from checkPresets.
     * @param {Object} options The applySnapshot options.
     * @returns {Promise<boolean>} True only if the user chose to continue.
     */
    async confirmPresetIssues(issues, options) {
        let lines = [];
        for (let issue of issues) {
            if (issue.problem == 'missing') {
                lines.push(`- "${issue.title}" no longer exists and will be left out.`);
            }
            else {
                lines.push(`- "${issue.title}" has changed since this workspace was saved. Its current definition will be used.`);
            }
        }
        let message = `Some presets in this workspace do not match the presets you have now:\n${lines.join('\n')}\n\nContinue loading with the current presets?`;
        if (options.confirmPresets) {
            let answer = await options.confirmPresets(issues, message);
            return answer == true;
        }
        return window.confirm(message);
    }

    /**
     * Asks the server to describe a model, with a bounded wait. This is a read and changes nothing.
     * @param {string} name The model name, as shown in the model dropdown.
     * @returns {Promise<Object>} Resolves to the model data; rejects if the model is unknown, the request fails, or it times out.
     */
    describeModel(name) {
        return new Promise((resolve, reject) => {
            let done = false;
            let timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    reject(new Error('the server did not answer in time'));
                }
            }, this.modelRequestTimeoutMs);
            genericRequest('DescribeModel', { modelName: name }, data => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                if (!data.model || !data.model.name) {
                    reject(new Error('the server returned no model data'));
                    return;
                }
                resolve(data.model);
            }, 0, error => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                reject(new Error(`${error}`));
            });
        });
    }

    /**
     * Waits until a condition holds, checking again each poll interval, up to a time limit.
     * @param {Function} condition Returns true when the pending operation is done.
     * @param {number} timeoutMs The longest wait, in milliseconds.
     * @returns {Promise<boolean>} True if the condition held, false on timeout. Rejects if the condition throws.
     */
    waitFor(condition, timeoutMs) {
        return new Promise((resolve, reject) => {
            let start = Date.now();
            let check = () => {
                try {
                    if (condition()) {
                        resolve(true);
                        return;
                    }
                }
                catch (error) {
                    reject(error);
                    return;
                }
                if (Date.now() - start >= timeoutMs) {
                    resolve(false);
                    return;
                }
                setTimeout(check, this.settlePollMs);
            };
            check();
        });
    }

    /**
     * Adds an entry to a skipped-items list unless the same item is already listed.
     * @param {Array} skipped The list.
     * @param {Object} entry The entry: { kind, id, name, reason }.
     */
    addSkipped(skipped, entry) {
        for (let existing of skipped) {
            if (existing.kind == entry.kind && existing.id == entry.id) {
                return;
            }
        }
        skipped.push(entry);
    }

    /**
     * Returns the order a parameter is restored in. Resolution and LoRA values that other handlers derive from come last.
     * @param {string} paramId The parameter ID.
     * @returns {number} Lower values are restored first.
     */
    getValueOrder(paramId) {
        if (paramId == 'aspectratio') {
            return 1;
        }
        if (paramId == 'width' || paramId == 'height' || paramId == 'loras') {
            return 2;
        }
        return 0;
    }

    /**
     * Works out exactly what a restore will set, against the parameters that exist now. Changes nothing.
     * Parameters added since capture get their defaults and an off switch. Values that are no longer available are listed as skipped and also reset to defaults.
     * @param {Object} snapshot A validated snapshot.
     * @returns {Object} { modelName, values: [{ param, elem, value, enabled, fromSnapshot }], groups: [{ id, name, enabled }], skipped: [...] }.
     */
    buildPlan(snapshot) {
        let plan = { modelName: null, values: [], groups: [], skipped: [] };
        let modelEntry = snapshot.values['model'];
        if (modelEntry && `${modelEntry.value}` != '') {
            plan.modelName = `${modelEntry.value}`;
        }
        let known = {};
        let removedLoraIndices = [];
        for (let param of gen_param_types) {
            if (!this.isCapturableParam(param)) {
                continue;
            }
            known[param.id] = true;
            if (param.id == 'model') {
                continue;
            }
            let elem = this.getParamElem(param);
            let entry = snapshot.values[param.id];
            let item = { param: param, elem: elem, value: this.defaultValueFor(param, elem), enabled: false, fromSnapshot: false };
            if (entry) {
                if (this.isMultiSelect(elem)) {
                    let options = [];
                    for (let option of elem.options) {
                        options.push(option.value);
                    }
                    let kept = [];
                    let list = this.toList(entry.value);
                    for (let i = 0; i < list.length; i++) {
                        if (options.includes(list[i])) {
                            kept.push(list[i]);
                        }
                        else {
                            plan.skipped.push({ kind: 'value', id: param.id, name: param.name, reason: `"${list[i]}" is not available` });
                            if (param.id == 'loras') {
                                removedLoraIndices.push(i);
                            }
                        }
                    }
                    item.value = kept;
                    item.enabled = entry.enabled;
                    item.fromSnapshot = true;
                }
                else if (elem.tagName == 'SELECT') {
                    let options = [];
                    for (let option of elem.options) {
                        options.push(option.value);
                    }
                    if (options.includes(`${entry.value}`)) {
                        item.value = `${entry.value}`;
                        item.enabled = entry.enabled;
                        item.fromSnapshot = true;
                    }
                    else {
                        plan.skipped.push({ kind: 'value', id: param.id, name: param.name, reason: `"${entry.value}" is not available` });
                    }
                }
                else {
                    item.value = entry.value;
                    item.enabled = entry.enabled;
                    item.fromSnapshot = true;
                }
            }
            plan.values.push(item);
        }
        if (removedLoraIndices.length > 0) {
            for (let item of plan.values) {
                if ((item.param.id == 'loraweights' || item.param.id == 'lorasectionconfinement') && typeof item.value == 'string' && item.value != '') {
                    let parts = item.value.split(',');
                    let kept = [];
                    for (let i = 0; i < parts.length; i++) {
                        if (!removedLoraIndices.includes(i)) {
                            kept.push(parts[i]);
                        }
                    }
                    item.value = kept.join(',');
                }
            }
        }
        for (let id of Object.keys(snapshot.values)) {
            if (!known[id]) {
                plan.skipped.push({ kind: 'value', id: id, name: id, reason: 'this parameter is not available' });
            }
        }
        plan.values.sort((a, b) => this.getValueOrder(a.param.id) - this.getValueOrder(b.param.id));
        let groupIds = {};
        for (let group of this.listToggleGroups()) {
            groupIds[group.id] = true;
            let entry = snapshot.groups[group.id];
            plan.groups.push({ id: group.id, name: group.name, enabled: entry ? entry.enabled : false });
        }
        for (let id of Object.keys(snapshot.groups)) {
            if (!groupIds[id]) {
                plan.skipped.push({ kind: 'group', id: id, name: id, reason: 'this group is not available' });
            }
        }
        return plan;
    }

    /**
     * Moves the given values' options to the end of a multi-select, in the given order, so the selection order sent to the server matches.
     * Swarm sends multi-select values in option order, so this is how LoRA order is restored. Does nothing if the order already matches.
     * @param {HTMLSelectElement} elem The multi-select.
     * @param {Array<string>} values The wanted values, in order.
     */
    orderSelectOptions(elem, values) {
        let options = [...elem.options];
        let domOrder = [];
        for (let option of options) {
            if (values.includes(option.value)) {
                domOrder.push(option.value);
            }
        }
        if (arraysEqual(domOrder, values)) {
            return;
        }
        for (let value of values) {
            for (let option of options) {
                if (option.value == value) {
                    elem.appendChild(option);
                    break;
                }
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
        if (this.isMultiSelect(item.elem)) {
            value = this.toList(value);
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
            if (!this.valuesEqual(item.param, this.readParamValue(item.param, item.elem), item.value)) {
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
        let resolutionCorrected = false;
        for (let item of drift.values) {
            this.applyValue(item, false);
            if (item.param.id == 'width' || item.param.id == 'height') {
                resolutionCorrected = true;
            }
        }
        for (let item of drift.toggles) {
            this.applyParamToggle(item, false);
        }
        for (let group of drift.groups) {
            this.applyGroupToggle(group, false);
        }
        if (resolutionCorrected) {
            let widthInput = document.getElementById('input_width');
            if (widthInput) {
                // The resolution label only listens for 'input', so this refreshes it without re-running the change handlers.
                widthInput.dispatchEvent(new Event('input'));
            }
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

    /**
     * Builds a restore result object.
     * @param {string} status One of 'success', 'incomplete', 'refused', 'cancelled', 'failed', 'partial'.
     * @param {string} message A readable summary.
     * @param {Array} skipped Items that could not be restored.
     * @param {Array<string>} warnings Readable warnings.
     * @returns {Object} The result.
     */
    makeResult(status, message, skipped = [], warnings = []) {
        return { status: status, message: message, skipped: skipped, warnings: warnings };
    }

    /**
     * Restores a snapshot (or a stored workspace entry) into the Generate tab.
     * Validates the whole snapshot and checks the current UI and the model before changing anything. Missing or changed presets need the user's confirmation.
     * If an error happens after changes start, the previous settings are put back; if that fails too, the UI is marked partially restored.
     * Modified-state tracking and draft saving must stay idle while isRestoring() is true.
     * @param {Object} snapshot The snapshot to restore.
     * @param {Object} options Optional: { notify: false to show no messages, confirmPresets: async (issues, message) => boolean to replace the confirm dialog }.
     * @returns {Promise<Object>} The result: { status, message, skipped, warnings }.
     */
    async applySnapshot(snapshot, options = {}) {
        let notify = options.notify != false;
        if (this.restoring) {
            return this.finishRestore(this.makeResult('refused', 'A workspace is already being loaded.'), notify);
        }
        this.restoring = true;
        let result;
        try {
            result = await this.restoreSnapshot(snapshot, options);
        }
        catch (error) {
            // restoreSnapshot handles every error after changes start, so an error that reaches here happened before any change.
            console.error('Workspaces: restore stopped before making changes.', error);
            result = this.makeResult('refused', `Could not load the workspace: ${error.message || error}. Nothing was changed.`);
        }
        finally {
            this.restoring = false;
        }
        return this.finishRestore(result, notify);
    }

    /**
     * Runs the restore steps for applySnapshot. Call only through applySnapshot, which manages the restoring flag.
     * @param {Object} snapshot The snapshot to restore.
     * @param {Object} options The applySnapshot options.
     * @returns {Promise<Object>} The result.
     */
    async restoreSnapshot(snapshot, options) {
        if (!this.isReady()) {
            return this.makeResult('refused', 'The Generate tab is not ready yet. Nothing was changed.');
        }
        let problem = this.validateSnapshot(snapshot);
        if (problem) {
            return this.makeResult('refused', `This workspace cannot be loaded: ${problem} Nothing was changed.`);
        }
        let warnings = [];
        if (snapshot.unsupported.length > 0) {
            warnings.push(`This workspace was saved while ${this.describeUnsupported(snapshot.unsupported)} ${snapshot.unsupported.length == 1 ? 'was' : 'were'} in use. Workspaces do not save that, so it was not restored.`);
        }
        let active = this.detectUnsupportedState();
        if (active.length > 0) {
            return this.makeResult('refused', `Cannot load a workspace while ${this.describeUnsupported(active)} ${active.length == 1 ? 'is' : 'are'} in use, because loading would leave ${active.length == 1 ? 'it' : 'them'} in place. Remove ${active.length == 1 ? 'it' : 'them'} first. Nothing was changed.`, [], warnings);
        }
        let modelEntry = snapshot.values['model'];
        let modelName = modelEntry && `${modelEntry.value}` != '' ? `${modelEntry.value}` : null;
        let modelData = null;
        if (modelName) {
            try {
                modelData = await this.describeModel(modelName);
            }
            catch (error) {
                return this.makeResult('refused', `The workspace's model "${modelName}" is not available (${error.message}). Nothing was changed.`, [], warnings);
            }
        }
        let presetCheck = this.checkPresets(snapshot);
        if (presetCheck.issues.length > 0) {
            let accepted = await this.confirmPresetIssues(presetCheck.issues, options);
            if (!accepted) {
                return this.makeResult('cancelled', 'Loading was cancelled. Nothing was changed.', [], warnings);
            }
        }
        // The UI may have changed while waiting for the server or the user, so check again right before changing anything.
        active = this.detectUnsupportedState();
        if (active.length > 0) {
            return this.makeResult('refused', `Cannot load a workspace while ${this.describeUnsupported(active)} ${active.length == 1 ? 'is' : 'are'} in use. Nothing was changed.`, [], warnings);
        }
        let plan = this.buildPlan(snapshot);
        let skipped = plan.skipped.slice();
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
                return this.makeResult('failed', `Loading the workspace failed (${reason}). Your previous settings were put back.`, [], warnings);
            }
            let partialMessage = `Loading the workspace failed (${reason}), and your previous settings could not be fully put back. Some settings are from the workspace and some are not. Check them before generating.`;
            this.markPartiallyRestored(partialMessage);
            return this.makeResult('partial', partialMessage, [], warnings);
        }
        this.clearPartiallyRestored();
        if (skipped.length > 0) {
            return this.makeResult('incomplete', `The workspace loaded, but ${skipped.length} ${skipped.length == 1 ? 'item' : 'items'} could not be restored.`, skipped, warnings);
        }
        return this.makeResult('success', 'Workspace loaded.', [], warnings);
    }

    /**
     * Reports a finished restore: shows a message when needed and calls restoreFinishedCallbacks.
     * @param {Object} result The restore result.
     * @param {boolean} notify False to show no message.
     * @returns {Object} The same result.
     */
    finishRestore(result, notify) {
        if (notify) {
            this.showResult(result);
        }
        for (let callback of this.restoreFinishedCallbacks) {
            try {
                callback(result);
            }
            catch (error) {
                console.error('Workspaces: a restore callback failed.', error);
            }
        }
        return result;
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
        let shown = 0;
        for (let entry of result.skipped) {
            if (shown >= 10) {
                lines.push(`...and ${result.skipped.length - shown} more.`);
                break;
            }
            lines.push(`- ${entry.name}: ${entry.reason}`);
            shown++;
        }
        for (let warning of result.warnings) {
            lines.push(warning);
        }
        showError(lines.join('\n'));
    }

    /**
     * Marks the UI as partially restored with a notice above the parameters. The notice stays through parameter rebuilds, until a later restore finishes.
     * @param {string} message The text to show.
     */
    markPartiallyRestored(message) {
        this.partiallyRestored = true;
        try {
            let area = document.getElementById('main_inputs_area');
            if (!area || !area.parentElement) {
                return;
            }
            let banner = area.parentElement.querySelector('.hartsy-workspaces-partial');
            if (!banner) {
                banner = createDiv(null, 'hartsy-workspaces-partial');
                area.parentElement.insertBefore(banner, area);
            }
            banner.innerHTML = `<span class="hartsy-workspaces-partial-text">${escapeHtml(message)}</span><button class="basic-button hartsy-workspaces-partial-dismiss" title="Hide this notice">&times;</button>`;
            banner.querySelector('.hartsy-workspaces-partial-dismiss').addEventListener('click', () => {
                banner.remove();
            });
        }
        catch (error) {
            console.error('Workspaces: could not show the partial-restore notice.', error);
        }
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
}

/** Singleton instance of the workspace manager. */
let hartsyWorkspacesManager = new HartsyWorkspacesManager();

sessionReadyCallbacks.push(() => {
    hartsyWorkspacesManager.loadWorkspaces();
});
