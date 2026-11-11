/**
 * Workspaces: named snapshots of the Generate tab's configuration.
 *
 * Public entry points (used by the toolbar):
 * - captureSnapshot(): returns a schema v1 snapshot of the current Generate tab.
 * - applyResolved(resolved, options): applies the response of the WorkspacesResolve API route to the Generate tab in a fixed order, and resolves to a result object.
 * - listWorkspaces(): fetches the user's workspaces from the server.
 * - isRestoring(): true while a restore runs. Modified-state tracking and draft saving must do nothing while this is true.
 * - restoreFinishedCallbacks: functions called with each restore result, after isRestoring() is false again.
 *
 * Everything that is not about the Generate tab's controls is done by the server through the Workspaces API: storage, validating values against the real
 * parameter definitions, choosing parts, checking presets, and drafts. This script captures the controls, calls the API, and applies what comes back.
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
        /** Functions called as callback(result) after every applyResolved call finishes. */
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
        /** ID of the workspace the Generate tab was last loaded from or saved to, or null when none is selected. */
        this.currentId = null;
        /** Server revision of the current workspace, sent back with every update, rename, and delete. */
        this.currentRevision = null;
        /** Normalized state of the Generate tab as of the last successful load or save, or null when no workspace is selected. */
        this.baseline = null;
        /** True when the Generate tab differs from the baseline. */
        this.modified = false;
        /** True while a save, rename, delete, or load started from the toolbar is running. */
        this.busy = false;
        /** Pending timer for the debounced modified-state check, or null. */
        this.modifiedTimer = null;
        /** True once the page-wide change listeners are attached. */
        this.trackingAttached = false;
        /** Pending timer that clears the toolbar's status text, or null. */
        this.statusTimer = null;
        /** Longest workspace name, in characters. Matches the server's limit. */
        this.maxNameLength = 100;
        /** The SwarmUI popover (picker or menu) opened from the toolbar, or null. Its 'popover' field is null once it has closed. */
        this.activePopover = null;
        /** Pending timer for the debounced draft save, or null. */
        this.draftTimer = null;
        /** Wait after the last change before a draft is saved to the server, in milliseconds. */
        this.draftDebounceMs = 2000;
        /** True once the workspace list has been fetched from the server at least once. */
        this.listLoaded = false;
        /** True once the check for drafts left by an earlier page has run. */
        this.recoveryChecked = false;
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
        /** IDs of drafts already restored on this page, so they are not offered again. */
        this.recoveredIds = new Set();
        /** True once the Shift+S listener is attached. */
        this.shortcutAttached = false;
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
        this.listWorkspaces().then(() => {
            this.listLoaded = true;
            this.refreshToolbar();
            this.checkRecovery();
        }).catch(error => {
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
     * @returns {Object} Map of group ID to { enabled }.
     */
    captureGroups() {
        let groups = {};
        for (let group of this.listToggleGroups()) {
            groups[group.id] = { enabled: this.getGroupToggle(group.id).checked };
        }
        return groups;
    }

    /**
     * Captures the active presets in selection order, by title. The server records each preset's current definition when the snapshot is saved.
     * @returns {Array} List of { title }.
     */
    capturePresets() {
        let presets = [];
        for (let preset of currentPresets) {
            presets.push({ title: preset.title });
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
     * Asks the user whether to continue when presets are missing or changed. Uses options.confirmPresets if given, else the browser's confirm dialog.
     * @param {Array} issues The preset issues from checkPresets.
     * @param {Object} options The applyResolved options.
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
            if (!entry && snapshot.leaveAlone && snapshot.leaveAlone.has(param.id)) {
                // The server could not use this saved value, so it was reported as skipped. Keep what the Generate tab has now.
                continue;
            }
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
                        if (`${list[i]}` == '') {
                            // An empty entry means "no items", so there is nothing to keep or report.
                        }
                        else if (options.includes(list[i])) {
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
                    else if (`${entry.value}` == '' && elem.value == '') {
                        // Saved as empty and still empty now: there is no value to restore, so it is not a skip. The saved switch state still applies.
                        item.value = '';
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
            // A select with no options cannot hold any value, so it cannot drift from its default.
            let optionless = item.elem && item.elem.tagName == 'SELECT' && item.elem.options.length == 0;
            if (!optionless && !this.valuesEqual(item.param, this.readParamValue(item.param, item.elem), item.value)) {
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
     * Applies a resolved workspace (the response of the WorkspacesResolve route) to the Generate tab.
     * Checks the current UI and the model before changing anything. Missing or changed presets need the user's confirmation.
     * If an error happens after changes start, the previous settings are put back; if that fails too, the UI is marked partially restored.
     * Modified-state tracking and draft saving must stay idle while isRestoring() is true.
     * @param {Object} resolved The resolved workspace: { values, groups, presets, skipped, unsupported, ... }.
     * @param {Object} options Optional: { notify: false to show no messages, confirmPresets: async (issues, message) => boolean to replace the confirm dialog }.
     * @returns {Promise<Object>} The result: { status, message, skipped, warnings }.
     */
    async applyResolved(resolved, options = {}) {
        let notify = options.notify != false;
        if (this.restoring) {
            return this.finishRestore(this.makeResult('refused', 'A workspace is already being loaded.'), notify);
        }
        this.restoring = true;
        let result;
        try {
            result = await this.restoreResolved(resolved, options);
        }
        catch (error) {
            // restoreResolved handles every error after changes start, so an error that reaches here happened before any change.
            console.error('Workspaces: restore stopped before making changes.', error);
            result = this.makeResult('refused', `Could not load the workspace: ${error.message || error}. Nothing was changed.`);
        }
        finally {
            this.restoring = false;
        }
        return this.finishRestore(result, notify);
    }

    /**
     * Runs the restore steps for applyResolved. Call only through applyResolved, which manages the restoring flag.
     * @param {Object} resolved The resolved workspace.
     * @param {Object} options The applyResolved options.
     * @returns {Promise<Object>} The result.
     */
    async restoreResolved(resolved, options) {
        if (!this.isReady()) {
            return this.makeResult('refused', 'The Generate tab is not ready yet. Nothing was changed.');
        }
        let warnings = [];
        if (resolved.unsupported.length > 0) {
            warnings.push(`This workspace was saved while ${this.describeUnsupported(resolved.unsupported)} ${resolved.unsupported.length == 1 ? 'was' : 'were'} in use. Workspaces do not save that, so it was not restored.`);
        }
        let active = this.detectUnsupportedState();
        if (active.length > 0) {
            return this.makeResult('refused', `Cannot load a workspace while ${this.describeUnsupported(active)} ${active.length == 1 ? 'is' : 'are'} in use, because loading would leave ${active.length == 1 ? 'it' : 'them'} in place. Remove ${active.length == 1 ? 'it' : 'them'} first. Nothing was changed.`, [], warnings);
        }
        let modelSkip = resolved.skipped.find(item => item.id == 'model');
        if (modelSkip) {
            return this.makeResult('refused', `The workspace's model is not available (${modelSkip.reason}). Nothing was changed.`, [], warnings);
        }
        let modelEntry = resolved.values['model'];
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
        let presetCheck = this.presetsFromResolved(resolved);
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

    /**
     * Calls a Workspaces API route.
     * @param {string} route The route name, for example 'WorkspacesCreate'.
     * @param {Object} data The request body.
     * @returns {Promise<Object>} Resolves to the response; rejects with the error message.
     */
    callApi(route, data) {
        return new Promise((resolve, reject) => {
            genericRequest(route, data, response => {
                resolve(response);
            }, 0, error => {
                reject(`${error}`);
            });
        });
    }

    /**
     * Reduces a snapshot to the parts that count for modified-state comparison. Timestamps, revision, and name are left out. List order is kept.
     * @param {Object} snapshot A captured snapshot.
     * @returns {string} Stable text for comparing two states.
     */
    normalizeState(snapshot) {
        return this.stableStringify({ values: snapshot.values, groups: snapshot.groups, presets: snapshot.presets, unsupported: snapshot.unsupported });
    }

    /**
     * Makes sure exactly one toolbar sits directly above the parameter area, and refreshes it.
     * Safe to call any number of times, including after every parameter rebuild.
     * The toolbar is one row: a workspace picker, Save, a "Modified" marker, and a "..." menu that holds every other action.
     * @returns {Element|null} The toolbar, or null if the Generate tab is not on the page yet.
     */
    ensureToolbar() {
        let area = document.getElementById('main_inputs_area');
        if (!area || !area.parentElement) {
            return null;
        }
        let toolbars = area.parentElement.querySelectorAll('.hartsy-workspaces-toolbar');
        let toolbar = toolbars.length > 0 ? toolbars[0] : null;
        for (let i = 1; i < toolbars.length; i++) {
            toolbars[i].remove();
        }
        if (!toolbar) {
            toolbar = this.buildToolbar();
        }
        if (toolbar.nextElementSibling != area) {
            area.parentElement.insertBefore(toolbar, area);
        }
        this.attachTracking();
        this.attachShortcut();
        this.refreshToolbar();
        this.checkRecovery();
        return toolbar;
    }

    /**
     * Builds the toolbar element and wires its buttons. Call only from ensureToolbar, which makes sure there is just one.
     * The picker is a plain SwarmUI dropdown (select.auto-dropdown) and the menu is SwarmUI's own popover (AdvancedPopover), so both follow every theme.
     * @returns {Element} The new toolbar, not yet placed on the page.
     */
    buildToolbar() {
        let toolbar = createDiv(null, 'hartsy-workspaces-toolbar');
        let help = this.makeHelp('hartsy_workspaces_help', this.toolbarHelpHtml());
        toolbar.innerHTML = '<div class="hartsy-workspaces-bar">'
            + `<select class="auto-dropdown hartsy-workspaces-picker" autocomplete="off" title="Choose a workspace to load"></select>`
            + '<button class="basic-button hartsy-workspaces-save" title="Save the current settings (Shift+S)">Save</button>'
            + '<span class="hartsy-workspaces-modified" title="The settings differ from the saved workspace" hidden>Modified</span>'
            + '<button class="basic-button hartsy-workspaces-more" title="More workspace actions">More &#x2B9F;</button>'
            + help.button
            + '</div>'
            + '<div class="parens hartsy-workspaces-status" role="status"></div>';
        toolbar.append(help.popover);
        this.keepHelpOnScreen(toolbar.querySelector('.info-popover-button'), 'hartsy_workspaces_help');
        toolbar.querySelector('.hartsy-workspaces-save').addEventListener('click', () => {
            this.saveCurrent();
        });
        let picker = toolbar.querySelector('.hartsy-workspaces-picker');
        picker.addEventListener('change', async () => {
            await this.pickWorkspace(picker.value);
            // Whatever happened (loaded, declined, failed), show the workspace the Generate tab is really attached to.
            this.refreshToolbar();
        });
        // A click on the button while its popover is open closes it (SwarmUI does that before this runs), so remember on mousedown whether it was open, to toggle instead of reopening.
        let more = toolbar.querySelector('.hartsy-workspaces-more');
        let wasOpen = false;
        more.addEventListener('mousedown', () => {
            wasOpen = this.isPopoverOpen();
        });
        more.addEventListener('click', () => {
            let skip = wasOpen;
            wasOpen = false;
            if (!skip && !this.busy) {
                this.openMenu(more.getBoundingClientRect());
            }
        });
        return toolbar;
    }

    /**
     * Builds a SwarmUI "?" help button and its info popover, the same pair (and classes) SwarmUI puts beside its own settings in its default button style.
     * SwarmUI's hover style is not used: it looks for a settings input with this ID, which a toolbar does not have, so the "?" button is always shown.
     * @param {string} id A unique ID for this help.
     * @param {string} html The help text, as HTML written in this file (never user input).
     * @returns {Object} { button: HTML of the "?" button, popover: the popover element, which the caller must add to the page }.
     */
    makeHelp(id, html) {
        return {
            button: `<span class="auto-input-qbutton info-popover-button" onclick="doPopover('${id}', arguments[0])">?</span>`,
            popover: createDiv(`popover_${id}`, 'sui-popover sui-info-popover', html)
        };
    }

    /**
     * SwarmUI positions an info popover using a narrow trial width, so a long one can end up partly off the top or right edge of the window.
     * After SwarmUI has shown it, this moves it fully on screen.
     * @param {Element} button The "?" button, or null.
     * @param {string} helpId The ID the help was made with (see makeHelp).
     */
    keepHelpOnScreen(button, helpId) {
        if (!button) {
            return;
        }
        // Capture phase, then a zero-delay timer: SwarmUI's own click handler on the button runs first and shows the popover, then this adjusts it.
        button.addEventListener('click', () => {
            setTimeout(() => {
                let pop = document.getElementById(`popover_${helpId}`);
                if (!pop || pop.dataset.visible != 'true') {
                    return;
                }
                pop.style.left = `${Math.max(10, Math.min(parseFloat(pop.style.left) || 0, window.innerWidth - pop.offsetWidth - 10))}px`;
                pop.style.top = `${Math.max(10, Math.min(parseFloat(pop.style.top) || 0, window.innerHeight - pop.offsetHeight - 10))}px`;
            }, 0);
        }, true);
    }

    /**
     * The plain-language help shown by the toolbar's "?": what a workspace is and what every control does.
     * @returns {string} The help HTML.
     */
    toolbarHelpHtml() {
        return '<b>Workspaces</b><br>A workspace saves your whole Generate tab so you can switch setups in one step: every setting, which settings and groups are switched on, and which presets are active. '
            + 'Choosing one replaces what you have now. It is not a merge like a preset.'
            + '<br><br><b>Dropdown</b>: choose a saved workspace to load it.'
            + '<br><b>Save</b>: store your current settings in the selected workspace. With none selected, it asks for a name and creates one. Shortcut: Shift+S.'
            + '<br><b>Modified</b>: your settings differ from the saved workspace. Save keeps the changes. Choosing another workspace or Reload Saved Version throws them away, after asking.'
            + '<br><br><b>More</b>'
            + '<br>&bull; <b>Save As New Workspace</b>: copy your current settings into a new workspace, leaving the selected one as it is.'
            + '<br>&bull; <b>Reload Saved Version</b>: discard your unsaved changes and go back to the saved settings.'
            + '<br>&bull; <b>Rename Workspace</b>: change its name.'
            + '<br>&bull; <b>Star Workspace</b>: mark it as a favorite, so it is listed first in the dropdown, under Starred.'
            + '<br>&bull; <b>Load Part of Workspace</b>: apply only some parts of a workspace (for example just the model, or just one group) and leave everything else as it is.'
            + '<br>&bull; <b>Delete Workspace</b>: remove the saved workspace. Your current settings stay as they are.';
    }

    /**
     * Builds and shows a SwarmUI modal from the standard modal markup, with a title, an optional "?" help beside it, a body, and a footer. It removes itself when closed.
     * @param {string} id The modal's element ID. An open modal with the same ID is replaced.
     * @param {string} title The title.
     * @param {string} helpHtml Help text for a "?" beside the title, or null for none.
     * @returns {Object} { modal, body, footer }: the modal element and the elements to fill.
     */
    openModal(id, title, helpHtml) {
        let existing = document.getElementById(id);
        if (existing) {
            $(existing).modal('hide');
            this.removeModal(existing);
        }
        let help = helpHtml ? this.makeHelp(`${id}_help`, helpHtml) : null;
        let modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = id;
        modal.tabIndex = -1;
        modal.setAttribute('role', 'dialog');
        modal.innerHTML = '<div class="modal-dialog" role="document"><div class="modal-content">'
            + `<div class="modal-header"><h5 class="modal-title">${escapeHtml(title)}${help ? help.button : ''}</h5></div>`
            + '<div class="modal-body"></div>'
            + '<div class="modal-footer"></div>'
            + '</div></div>';
        if (help) {
            modal.append(help.popover);
            this.keepHelpOnScreen(modal.querySelector('.info-popover-button'), `${id}_help`);
        }
        document.body.append(modal);
        $(modal).on('hidden.bs.modal', () => {
            this.removeModal(modal);
        });
        return { modal: modal, body: modal.querySelector('.modal-body'), footer: modal.querySelector('.modal-footer') };
    }

    /**
     * Removes a modal from the page. An open help popover is hidden first, so SwarmUI is not left tracking a popover that no longer exists.
     * @param {Element} modal The modal element.
     */
    removeModal(modal) {
        for (let pop of modal.querySelectorAll('.sui-info-popover')) {
            if (pop.dataset.visible == 'true') {
                hidePopover(pop.id.replace(/^popover_/, ''));
            }
        }
        modal.remove();
    }

    /**
     * Adds a SwarmUI-styled button to a modal footer.
     * @param {Element} footer The modal footer.
     * @param {string} text The button text.
     * @param {boolean} primary True for the main (highlighted) button.
     * @param {Function} handler Called on click.
     * @returns {Element} The button.
     */
    addModalButton(footer, text, primary, handler) {
        let button = document.createElement('button');
        button.type = 'button';
        button.className = `btn ${primary ? 'btn-primary' : 'btn-secondary'} basic-button`;
        button.textContent = text;
        button.addEventListener('click', handler);
        footer.append(button);
        return button;
    }

    /**
     * Returns whether the toolbar's menu popover is currently open.
     * @returns {boolean} True if open.
     */
    isPopoverOpen() {
        return this.activePopover != null && this.activePopover.popover != null;
    }

    /**
     * Opens the "More" menu as a SwarmUI popover under its button.
     * @param {DOMRect} rect The bounds of the button to open under.
     */
    openMenu(rect) {
        if (this.isPopoverOpen()) {
            this.activePopover.remove();
        }
        this.activePopover = new AdvancedPopover('hartsy_workspaces_menu', this.menuButtons(), false, rect.x, rect.bottom + 4, document.body);
    }

    /**
     * Builds the "More" menu's entries. Entries that need a selected workspace are left out when none is selected.
     * @returns {Array<Object>} The popover entries.
     */
    menuButtons() {
        let entry = this.getCurrentEntry();
        let buttons = [{ key: 'Save As New Workspace', title: 'Save the current settings as a new workspace, keeping this one as it is', action: () => this.saveNew(true) }];
        if (entry) {
            buttons.push({ key: 'Reload Saved Version', title: 'Throw away unsaved changes and load the latest saved version of this workspace', action: () => this.loadWorkspace(this.currentId) });
            buttons.push({ key: 'Rename Workspace', action: () => this.renameCurrent() });
            buttons.push({ key: entry.starred ? 'Unstar Workspace' : 'Star Workspace', title: 'Starred workspaces are listed first', action: () => this.toggleStar() });
        }
        if (this.workspaces.length > 0) {
            buttons.push({ key: 'Load Part of Workspace', title: 'Load only some parts of a workspace and leave everything else as it is', action: () => this.showPartialDialog() });
        }
        if (entry) {
            buttons.push({ key: 'Delete Workspace', title: 'Delete this workspace. Your current settings stay as they are', action: () => this.deleteCurrent() });
        }
        return buttons;
    }

    /**
     * Fills the picker dropdown: "No workspace", then starred workspaces under "Starred" and the rest under "Other workspaces", and selects the current workspace.
     * With no starred workspace the list is flat.
     * @param {Element} select The picker's select element.
     */
    fillPicker(select) {
        select.innerHTML = '';
        let addOption = (parent, value, text) => {
            let option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            parent.append(option);
        };
        addOption(select, '', 'No workspace');
        let sorted = this.workspaces.slice().sort((a, b) => `${a.name}`.localeCompare(`${b.name}`));
        let starred = sorted.filter(workspace => workspace.starred);
        let others = sorted.filter(workspace => !workspace.starred);
        let addGroup = (label, items) => {
            if (items.length == 0) {
                return;
            }
            let group = document.createElement('optgroup');
            group.label = label;
            for (let workspace of items) {
                addOption(group, workspace.id, workspace.name);
            }
            select.append(group);
        };
        if (starred.length == 0) {
            for (let workspace of others) {
                addOption(select, workspace.id, workspace.name);
            }
        }
        else {
            addGroup('Starred', starred);
            addGroup('Other workspaces', others);
        }
        select.value = this.currentId || '';
        if (select.selectedIndex < 0) {
            select.value = '';
        }
    }

    /**
     * Redraws the toolbar's picker, button states, and modified marker from the current state.
     */
    refreshToolbar() {
        let toolbar = document.querySelector('.hartsy-workspaces-toolbar');
        if (!toolbar) {
            return;
        }
        let hasCurrent = this.getCurrentEntry() != null;
        let picker = toolbar.querySelector('.hartsy-workspaces-picker');
        this.fillPicker(picker);
        picker.disabled = this.busy;
        toolbar.querySelector('.hartsy-workspaces-more').disabled = this.busy;
        let save = toolbar.querySelector('.hartsy-workspaces-save');
        save.disabled = this.busy;
        save.title = hasCurrent ? 'Save the current settings to this workspace (Shift+S)' : 'Save the current settings as a new workspace (Shift+S)';
        toolbar.querySelector('.hartsy-workspaces-modified').hidden = !(hasCurrent && this.modified);
    }

    /**
     * Stars or unstars the current workspace. The saved settings are not touched, so unsaved changes stay unsaved.
     */
    async toggleStar() {
        let entry = this.getCurrentEntry();
        if (this.busy || this.restoring || !entry) {
            return;
        }
        this.setBusy(true);
        try {
            let response = await this.callApi('WorkspacesStar', { id: entry.id, revision: this.currentRevision, starred: !entry.starred });
            this.currentRevision = response.revision;
            try {
                // Take the stored values back, so the list shows exactly what the server kept.
                await this.listWorkspaces();
            }
            catch (error) {
                console.error('Workspaces: could not refresh the list after a change.', error);
                entry.starred = !entry.starred;
                entry.revision = response.revision;
            }
        }
        catch (error) {
            await this.reportFailure('update', error);
        }
        finally {
            this.setBusy(false);
        }
    }

    /**
     * Shows a short status line in the toolbar, which clears itself after a few seconds.
     * @param {string} text The message.
     */
    setStatus(text) {
        let status = document.querySelector('.hartsy-workspaces-status');
        if (!status) {
            return;
        }
        status.textContent = text;
        if (this.statusTimer) {
            clearTimeout(this.statusTimer);
        }
        this.statusTimer = setTimeout(() => {
            this.statusTimer = null;
            status.textContent = '';
        }, 8000);
    }

    /**
     * Sets or clears the busy flag, which disables the toolbar while a request or a load runs.
     * @param {boolean} busy True while an operation runs.
     */
    setBusy(busy) {
        this.busy = busy;
        this.refreshToolbar();
        if (!busy) {
            this.scheduleModifiedCheck();
        }
    }

    /**
     * Finds the stored workspace the toolbar is currently attached to.
     * @returns {Object|null} The workspace entry, or null.
     */
    getCurrentEntry() {
        if (!this.currentId) {
            return null;
        }
        return this.workspaces.find(w => w.id == this.currentId) || null;
    }

    /**
     * Makes a workspace the current one and resets the modified baseline to the given (or present) state.
     * Call only when the Generate tab really holds that workspace: after a successful load or save.
     * @param {Object} entry The stored workspace entry (with its new revision).
     * @param {Object} snapshot Optional: the snapshot that was saved, used as the baseline instead of re-capturing.
     */
    setCurrent(entry, snapshot = null) {
        let previousId = this.currentId;
        this.currentId = entry.id;
        this.currentRevision = entry.revision;
        this.baseline = this.normalizeState(snapshot || this.captureSnapshot());
        this.modified = false;
        this.clearDraft([previousId, entry.id]);
        this.refreshToolbar();
    }

    /**
     * Detaches the toolbar from any workspace. The Generate tab keeps its settings.
     */
    detach() {
        let previousId = this.currentId;
        this.currentId = null;
        this.currentRevision = null;
        this.baseline = null;
        this.modified = false;
        this.clearDraft([previousId]);
        this.refreshToolbar();
    }

    /**
     * Stores a workspace entry returned by the server into the cached list, replacing an entry with the same ID.
     * @param {Object} entry The workspace entry.
     */
    storeEntry(entry) {
        let index = this.workspaces.findIndex(w => w.id == entry.id);
        if (index >= 0) {
            this.workspaces[index] = entry;
        }
        else {
            this.workspaces.push(entry);
        }
    }

    /**
     * Handles a choice in the workspace picker: loads that workspace, or detaches when "No workspace" is chosen.
     * @param {string} id The chosen workspace ID, or an empty string for "No workspace".
     */
    async pickWorkspace(id) {
        if (id == (this.currentId || '')) {
            return;
        }
        if (id == '') {
            this.detach();
            return;
        }
        await this.loadWorkspace(id);
    }

    /**
     * Loads a stored workspace into the Generate tab, replacing the current settings.
     * Asks first if the current workspace has unsaved changes. The modified baseline moves only if the load succeeds.
     * @param {string} id The workspace ID.
     * @returns {Promise<string>} 'loaded' if the workspace was loaded (fully, or with skipped items reported); 'cancelled' if the user declined or nothing was attempted; 'failed' if it was refused or the load failed (the reason has been shown to the user).
     */
    async loadWorkspace(id) {
        if (this.busy || this.restoring) {
            this.refreshToolbar();
            return 'cancelled';
        }
        // The marker is debounced, so compare right now instead of trusting it: an edit made a moment ago must still trigger the prompt.
        this.updateModified();
        if (this.modified) {
            let current = this.getCurrentEntry();
            let name = current ? current.name : 'The current workspace';
            let question = id == this.currentId ? `"${name}" has unsaved changes. Reload the saved version and discard them?` : `"${name}" has unsaved changes. Load another workspace and discard them?`;
            if (!confirm(question)) {
                this.refreshToolbar();
                return 'cancelled';
            }
        }
        this.setBusy(true);
        try {
            let resolved;
            try {
                resolved = await this.callApi('WorkspacesResolve', { id: id });
            }
            catch (error) {
                showError(`Could not load the workspace: ${error}`);
                try {
                    await this.listWorkspaces();
                }
                catch (listError) {
                    console.error('Workspaces: could not refresh the list after a failed load.', listError);
                }
                if (this.currentId && !this.getCurrentEntry()) {
                    this.detach();
                }
                return 'failed';
            }
            let result = await this.applyResolved(resolved);
            if (result.status == 'success' || result.status == 'incomplete') {
                this.storeEntry(resolved.workspace);
                this.setCurrent(resolved.workspace);
                return 'loaded';
            }
            return result.status == 'cancelled' ? 'cancelled' : 'failed';
        }
        finally {
            this.setBusy(false);
        }
    }

    /**
     * Saves the current settings into the current workspace. With no workspace selected, saves a new one instead.
     * A failed save keeps the modified marker and tells the user why, including when the workspace changed elsewhere.
     */
    async saveCurrent() {
        if (this.busy || this.restoring) {
            return;
        }
        if (!this.currentId) {
            await this.saveNew(false);
            return;
        }
        let entry = this.getCurrentEntry();
        if (!entry) {
            this.detach();
            showError('This workspace no longer exists. Use Save As to keep your settings as a new workspace.');
            return;
        }
        let snapshot;
        try {
            snapshot = this.captureSnapshot();
        }
        catch (error) {
            showError(`Could not read the current settings: ${error.message || error}`);
            return;
        }
        this.setBusy(true);
        try {
            let response = await this.callApi('WorkspacesUpdate', { id: this.currentId, revision: this.currentRevision, snapshot: snapshot });
            this.storeEntry(response.workspace);
            this.setCurrent(response.workspace, snapshot);
            // The server removes a workspace's draft when it is saved, so only this page's bookkeeping needs updating.
            this.draftIds.delete(response.workspace.id);
            this.ownDrafts.delete(response.workspace.id);
        }
        catch (error) {
            await this.reportFailure('save', error);
        }
        finally {
            this.setBusy(false);
        }
    }

    /**
     * Saves the current settings as a new workspace and selects it.
     * @param {boolean} copy True for Save As: the name prompt starts as "<current name> copy".
     */
    async saveNew(copy) {
        if (this.busy || this.restoring) {
            return;
        }
        let current = this.getCurrentEntry();
        let name = prompt('Name for the new workspace:', copy && current ? `${current.name} copy` : '');
        if (name == null) {
            return;
        }
        name = name.trim();
        if (name == '') {
            showError('A workspace needs a name.');
            return;
        }
        let snapshot;
        try {
            snapshot = this.captureSnapshot();
        }
        catch (error) {
            showError(`Could not read the current settings: ${error.message || error}`);
            return;
        }
        this.setBusy(true);
        try {
            let request = { name: name, snapshot: snapshot };
            let response = await this.callApi('WorkspacesCreate', request);
            this.storeEntry(response.workspace);
            this.setCurrent(response.workspace, snapshot);
        }
        catch (error) {
            showError(`Could not save the workspace: ${error}`);
        }
        finally {
            this.setBusy(false);
        }
    }

    /**
     * Renames the current workspace. The saved settings are not touched, and unsaved changes stay unsaved.
     */
    async renameCurrent() {
        let entry = this.getCurrentEntry();
        if (this.busy || this.restoring || !entry) {
            return;
        }
        let name = prompt('New name for this workspace:', entry.name);
        if (name == null) {
            return;
        }
        name = name.trim();
        if (name == '') {
            showError('A workspace needs a name.');
            return;
        }
        this.setBusy(true);
        try {
            let response = await this.callApi('WorkspacesRename', { id: entry.id, revision: this.currentRevision, name: name });
            entry.name = name;
            entry.revision = response.revision;
            this.currentRevision = response.revision;
        }
        catch (error) {
            await this.reportFailure('rename', error);
        }
        finally {
            this.setBusy(false);
        }
    }

    /**
     * Deletes the current workspace after confirmation. The Generate tab keeps its settings.
     */
    async deleteCurrent() {
        let entry = this.getCurrentEntry();
        if (this.busy || this.restoring || !entry) {
            return;
        }
        if (!confirm(`Delete the workspace "${entry.name}"? This cannot be undone. Your current settings stay as they are.`)) {
            return;
        }
        this.setBusy(true);
        try {
            await this.callApi('WorkspacesDelete', { id: entry.id, revision: this.currentRevision });
            this.workspaces = this.workspaces.filter(w => w.id != entry.id);
            this.detach();
        }
        catch (error) {
            await this.reportFailure('delete', error);
        }
        finally {
            this.setBusy(false);
        }
    }

    /**
     * Tells the user a save, rename, or delete failed. Re-reads the list to explain a conflict: the workspace changed or was deleted elsewhere.
     * Never clears the modified marker.
     * @param {string} verb What was attempted: 'save', 'rename', or 'delete'.
     * @param {string} error The error message from the server.
     */
    async reportFailure(verb, error) {
        let message = `${error}`;
        try {
            await this.listWorkspaces();
            let entry = this.getCurrentEntry();
            if (!entry) {
                message = 'This workspace was deleted elsewhere. Use Save As to keep your settings as a new workspace.';
                this.currentId = null;
                this.currentRevision = null;
                this.baseline = null;
                this.modified = false;
            }
            else if (entry.revision != this.currentRevision) {
                message = `"${entry.name}" was changed elsewhere. Nothing was overwritten. Use Save As to keep your settings as a new workspace, or load the workspace again to get the latest version.`;
            }
        }
        catch (listError) {
            console.error('Workspaces: could not re-read the list after a failure.', listError);
        }
        showError(`Could not ${verb} the workspace: ${message}`);
    }

    /**
     * Opens the partial-load dialog, built from Swarm's standard modal markup: pick a workspace, tick the parts to load, and everything unticked stays as it is.
     * The parts offered come from the server (what the chosen workspace contains), not from this page.
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
        let { modal, body, footer } = this.openModal('hartsy_workspaces_partial_modal', 'Load Part of Workspace', 'Loads only the parts you tick from the workspace you choose. Everything you leave unticked stays exactly as it is now. '
            + '<br><b>Model</b>: the model used by the workspace. <b>Presets</b>: which presets are active. Each group below is one group of settings, and "Other parameters" covers settings that are not in any group. '
            + '<br>Afterwards the settings count as modified, because they no longer match any single workspace.');
        let sourceRow = createDiv(null, null, 'From ');
        let source = document.createElement('select');
        source.className = 'modal_text_extra';
        let sorted = this.workspaces.slice().sort((a, b) => `${a.name}`.localeCompare(`${b.name}`));
        for (let workspace of sorted) {
            let option = document.createElement('option');
            option.value = workspace.id;
            option.textContent = workspace.name;
            source.append(option);
        }
        if (this.currentId && sorted.some(w => w.id == this.currentId)) {
            source.value = this.currentId;
        }
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
            label.append(box);
            label.append(document.createTextNode(` ${text}`));
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
        let makeButton = (text, primary, handler) => this.addModalButton(footer, text, primary, handler);
        makeButton('Select all', false, () => {
            for (let box of boxes) {
                box.checked = true;
            }
        });
        makeButton('Select none', false, () => {
            for (let box of boxes) {
                box.checked = false;
            }
        });
        makeButton('Cancel', false, () => {
            $(modal).modal('hide');
        });
        loadButton = makeButton('Load', true, () => {
            let selection = { model: false, presets: false, other: false, groups: [] };
            for (let box of boxes) {
                if (!box.checked) {
                    continue;
                }
                if (box.dataset.kind == 'group') {
                    selection.groups.push(box.dataset.id);
                }
                else {
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
            values: current.values,
            groups: current.groups,
            presets: resolved.presets || current.presets.map(preset => ({ title: preset.title, status: 'ok' })),
            skipped: resolved.skipped,
            unsupported: resolved.unsupported
        };
        Object.assign(merged.values, resolved.values);
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
        this.setBusy(true);
        try {
            let resolved;
            try {
                resolved = await this.callApi('WorkspacesResolve', { id: sourceId, parts: selection });
            }
            catch (error) {
                showError(`Could not load the chosen parts: ${error}`);
                return;
            }
            let combined = this.mergeIntoCurrent(resolved);
            let result = await this.applyResolved(combined.merged, { notify: false });
            if (result.status == 'success') {
                result.message = 'The chosen parts were loaded.';
            }
            for (let note of combined.notes) {
                result.warnings.push(note);
            }
            this.showResult(result);
            if (result.status == 'success' || result.status == 'incomplete') {
                this.setStatus(`Loaded the chosen parts of "${resolved.workspace.name}".`);
            }
        }
        finally {
            this.setBusy(false);
        }
    }

    /**
     * Schedules a debounced save of the current workspace's draft: its unsaved settings.
     */
    scheduleDraftSave() {
        if (this.draftTimer) {
            clearTimeout(this.draftTimer);
        }
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
        let snapshot;
        try {
            snapshot = this.captureSnapshot();
        }
        catch (error) {
            console.error('Workspaces: could not read the settings for a draft.', error);
            return;
        }
        if (this.normalizeState(snapshot) == this.baseline) {
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
            let next = request;
            while (next) {
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
                next = this.queuedDrafts.get(id) || null;
                this.queuedDrafts.delete(id);
                if (next && next.epoch != (this.draftEpochs.get(id) || 0)) {
                    next = null;
                }
            }
        }
        finally {
            this.savingDrafts.delete(id);
        }
    }

    /**
     * Cancels any pending draft save, and deletes the drafts this page wrote for the given workspaces. Used when the settings match a workspace again or are being replaced.
     * A draft left by an earlier page is not touched, so it can still be recovered. A draft save still in flight is deleted when it finishes.
     * @param {Array<string>} ids Workspace IDs, any of which may be null.
     */
    clearDraft(ids) {
        if (this.draftTimer) {
            clearTimeout(this.draftTimer);
            this.draftTimer = null;
        }
        for (let id of ids) {
            if (id) {
                this.draftEpochs.set(id, (this.draftEpochs.get(id) || 0) + 1);
                this.queuedDrafts.delete(id);
            }
            if (id && this.savingDrafts.has(id)) {
                // A save is still in flight, and deleting now could run before it lands. It deletes its own draft when it finishes.
                this.discardedWhileSaving.add(id);
            }
            else if (id && this.ownDrafts.has(id)) {
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
        let text = document.createElement('span');
        text.className = 'hartsy-workspaces-recover-text';
        let more = drafts.length > 1 ? ` (${drafts.length - 1} more after this)` : '';
        text.textContent = `Unsaved changes to "${draft.name}" from ${new Date(draft.saved_at).toLocaleString()} were found${more}.`;
        banner.append(text);
        let restore = document.createElement('button');
        restore.className = 'basic-button';
        restore.textContent = 'Restore';
        restore.title = 'Put those unsaved changes back on top of the workspace. Nothing is saved until you press Save.';
        restore.addEventListener('click', () => {
            this.recoverDraft(draft);
        });
        banner.append(restore);
        let discard = document.createElement('button');
        discard.className = 'basic-button';
        discard.textContent = 'Discard';
        discard.title = 'Throw those unsaved changes away.';
        discard.addEventListener('click', async () => {
            await this.deleteDraft(draft.id);
            this.showRecovery();
        });
        banner.append(discard);
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
        let result;
        this.setBusy(true);
        try {
            let resolved = await this.callApi('WorkspacesResolve', { id: draft.id, draft: true });
            result = await this.applyResolved(resolved);
        }
        catch (error) {
            showError(`Could not restore the draft: ${error}`);
            return;
        }
        finally {
            this.setBusy(false);
        }
        if (result.status != 'success' && result.status != 'incomplete') {
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
        if (!area || area.offsetParent == null) {
            return;
        }
        if (typeof imageEditor != 'undefined' && imageEditor && imageEditor.active) {
            return;
        }
        event.preventDefault();
        this.saveCurrent();
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
        if (this.modifiedTimer) {
            clearTimeout(this.modifiedTimer);
        }
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
        let state;
        try {
            state = this.normalizeState(this.captureSnapshot());
        }
        catch (error) {
            console.error('Workspaces: could not read the current settings.', error);
            return;
        }
        let changed = state != this.baseline;
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
}

/** Singleton instance of the workspace manager. */
let hartsyWorkspacesManager = new HartsyWorkspacesManager();

if (typeof postParamBuildSteps != 'undefined') {
    postParamBuildSteps.push(() => {
        hartsyWorkspacesManager.onParamsBuilt();
    });
}

sessionReadyCallbacks.push(() => {
    hartsyWorkspacesManager.loadWorkspaces();
    if (hartsyWorkspacesManager.isReady()) {
        hartsyWorkspacesManager.ensureToolbar();
    }
});
