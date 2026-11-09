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
        /** Value of the 'format' field in exported files. */
        this.exportFormat = 'swarmui-workspaces';
        /** Largest import file accepted, in bytes. */
        this.maxImportBytes = 8 * 1024 * 1024;
        /** Most workspaces one import may hold. Matches the server's limit. */
        this.maxImportCount = 200;
        /** Longest workspace name, in characters. Matches the server's limit. */
        this.maxNameLength = 100;
        /** Function that closes the open partial-load dialog, or null when none is open. */
        this.closeDialogHandler = null;
        /** Pending timer for the debounced draft save, or null. */
        this.draftTimer = null;
        /** Timer that refreshes this tab's "still open" mark, or null. */
        this.heartbeatTimer = null;
        /** Wait after the last change before a draft is written, in milliseconds. */
        this.draftDebounceMs = 2000;
        /** How often an open tab refreshes its "still open" mark, in milliseconds. */
        this.heartbeatMs = 5000;
        /** A tab whose mark is older than this counts as closed, so its draft can be recovered, in milliseconds. */
        this.staleTabMs = 20000;
        /** True once the recovery check for drafts left by earlier page loads has run. */
        this.recoveryChecked = false;
        /** ID of this browser tab, kept in session storage so a reload keeps it. Null until first needed. */
        this.tabId = null;
        /** True once the workspace list has been fetched from the server at least once. */
        this.listLoaded = false;
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
     * Reduces a snapshot to the parts that count for modified-state comparison. Timestamps, revision, name, and thumbnails are left out. List order is kept.
     * @param {Object} snapshot A captured snapshot.
     * @returns {string} Stable text for comparing two states.
     */
    normalizeState(snapshot) {
        return this.stableStringify({ values: snapshot.values, groups: snapshot.groups, presets: snapshot.presets, unsupported: snapshot.unsupported });
    }

    /**
     * Makes sure exactly one toolbar sits directly above the parameter area, and refreshes it.
     * Safe to call any number of times, including after every parameter rebuild.
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
            toolbar = createDiv(null, 'hartsy-workspaces-toolbar');
            toolbar.innerHTML = '<select class="hartsy-workspaces-select" title="Load a saved workspace"></select>'
                + '<button class="basic-button hartsy-workspaces-new" title="Save the current settings as a new workspace">New</button>'
                + '<button class="basic-button hartsy-workspaces-save" title="Save the current settings to this workspace (Shift+S)">Save</button>'
                + '<button class="basic-button hartsy-workspaces-saveas" title="Save the current settings as a copy">Save As</button>'
                + '<button class="basic-button hartsy-workspaces-reload" title="Throw away unsaved changes and load the latest saved version of this workspace">Reload</button>'
                + '<button class="basic-button hartsy-workspaces-rename" title="Rename this workspace">Rename</button>'
                + '<button class="basic-button hartsy-workspaces-delete" title="Delete this workspace">Delete</button>'
                + '<span class="hartsy-workspaces-modified" title="The settings differ from the saved workspace" hidden>● Modified</span>'
                + '<span class="hartsy-workspaces-break"></span>'
                + '<button class="basic-button hartsy-workspaces-loadpart" title="Load only some parts of a workspace, and leave everything else as it is">Load Part...</button>'
                + '<button class="basic-button hartsy-workspaces-export" title="Download the saved version of this workspace as a JSON file">Export</button>'
                + '<button class="basic-button hartsy-workspaces-exportall" title="Download every workspace as one JSON file">Export All</button>'
                + '<button class="basic-button hartsy-workspaces-import" title="Add workspaces from a JSON file">Import</button>'
                + '<span class="hartsy-workspaces-status" role="status"></span>';
            toolbar.querySelector('.hartsy-workspaces-loadpart').addEventListener('click', () => {
                this.showPartialDialog();
            });
            toolbar.querySelector('.hartsy-workspaces-export').addEventListener('click', () => {
                this.exportCurrent();
            });
            toolbar.querySelector('.hartsy-workspaces-exportall').addEventListener('click', () => {
                this.exportAll();
            });
            toolbar.querySelector('.hartsy-workspaces-import').addEventListener('click', () => {
                this.pickImportFile();
            });
            toolbar.querySelector('.hartsy-workspaces-select').addEventListener('change', event => {
                this.onSelectChange(event.target);
            });
            toolbar.querySelector('.hartsy-workspaces-new').addEventListener('click', () => {
                this.saveNew(false);
            });
            toolbar.querySelector('.hartsy-workspaces-save').addEventListener('click', () => {
                this.saveCurrent();
            });
            toolbar.querySelector('.hartsy-workspaces-saveas').addEventListener('click', () => {
                this.saveNew(true);
            });
            toolbar.querySelector('.hartsy-workspaces-reload').addEventListener('click', () => {
                if (this.currentId) {
                    this.loadWorkspace(this.currentId);
                }
            });
            toolbar.querySelector('.hartsy-workspaces-rename').addEventListener('click', () => {
                this.renameCurrent();
            });
            toolbar.querySelector('.hartsy-workspaces-delete').addEventListener('click', () => {
                this.deleteCurrent();
            });
        }
        if (toolbar.nextElementSibling != area) {
            area.parentElement.insertBefore(toolbar, area);
        }
        this.attachTracking();
        this.attachShortcut();
        this.startHeartbeat();
        this.refreshToolbar();
        this.checkRecovery();
        return toolbar;
    }

    /**
     * Redraws the toolbar's dropdown, button states, and modified marker from the current state.
     */
    refreshToolbar() {
        let toolbar = document.querySelector('.hartsy-workspaces-toolbar');
        if (!toolbar) {
            return;
        }
        let select = toolbar.querySelector('.hartsy-workspaces-select');
        let sorted = this.workspaces.slice().sort((a, b) => `${a.name}`.localeCompare(`${b.name}`));
        select.innerHTML = '';
        let none = document.createElement('option');
        none.value = '';
        none.textContent = '(no workspace)';
        select.append(none);
        for (let workspace of sorted) {
            let option = document.createElement('option');
            option.value = workspace.id;
            option.textContent = workspace.name;
            select.append(option);
        }
        select.value = this.currentId && this.workspaces.some(w => w.id == this.currentId) ? this.currentId : '';
        let hasCurrent = select.value != '';
        select.disabled = this.busy;
        toolbar.querySelector('.hartsy-workspaces-new').disabled = this.busy;
        toolbar.querySelector('.hartsy-workspaces-save').disabled = this.busy;
        toolbar.querySelector('.hartsy-workspaces-saveas').disabled = this.busy;
        toolbar.querySelector('.hartsy-workspaces-reload').disabled = this.busy || !hasCurrent;
        toolbar.querySelector('.hartsy-workspaces-rename').disabled = this.busy || !hasCurrent;
        toolbar.querySelector('.hartsy-workspaces-delete').disabled = this.busy || !hasCurrent;
        toolbar.querySelector('.hartsy-workspaces-modified').hidden = !(hasCurrent && this.modified);
        toolbar.querySelector('.hartsy-workspaces-loadpart').disabled = this.busy || this.workspaces.length == 0;
        toolbar.querySelector('.hartsy-workspaces-export').disabled = this.busy || !hasCurrent;
        toolbar.querySelector('.hartsy-workspaces-exportall').disabled = this.busy || this.workspaces.length == 0;
        toolbar.querySelector('.hartsy-workspaces-import').disabled = this.busy;
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
        this.currentId = entry.id;
        this.currentRevision = entry.revision;
        this.baseline = this.normalizeState(snapshot || this.captureSnapshot());
        this.modified = false;
        this.clearDraft();
        this.refreshToolbar();
    }

    /**
     * Detaches the toolbar from any workspace. The Generate tab keeps its settings.
     */
    detach() {
        this.currentId = null;
        this.currentRevision = null;
        this.baseline = null;
        this.modified = false;
        this.clearDraft();
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
     * Handles a choice in the toolbar dropdown: loads that workspace, or detaches when "(no workspace)" is chosen.
     * @param {HTMLSelectElement} select The dropdown.
     */
    async onSelectChange(select) {
        let id = select.value;
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
     */
    async loadWorkspace(id) {
        if (this.busy || this.restoring) {
            this.refreshToolbar();
            return;
        }
        // The marker is debounced, so compare right now instead of trusting it: an edit made a moment ago must still trigger the prompt.
        this.updateModified();
        if (this.modified) {
            let current = this.getCurrentEntry();
            let name = current ? current.name : 'The current workspace';
            let question = id == this.currentId ? `"${name}" has unsaved changes. Reload the saved version and discard them?` : `"${name}" has unsaved changes. Load another workspace and discard them?`;
            if (!confirm(question)) {
                this.refreshToolbar();
                return;
            }
        }
        this.setBusy(true);
        try {
            try {
                await this.listWorkspaces();
            }
            catch (error) {
                console.error('Workspaces: could not refresh the list before loading; using the cached list.', error);
            }
            let entry = this.workspaces.find(w => w.id == id);
            if (!entry) {
                showError('That workspace no longer exists. The list was refreshed.');
                if (this.currentId == id) {
                    this.detach();
                }
                return;
            }
            let result = await this.applySnapshot(entry);
            if (result.status == 'success' || result.status == 'incomplete') {
                this.setCurrent(entry);
            }
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
            let response = await this.callApi('WorkspacesUpdate', { id: this.currentId, revision: this.currentRevision, name: entry.name, snapshot: snapshot });
            this.storeEntry(response.workspace);
            this.setCurrent(response.workspace, snapshot);
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
            let response = await this.callApi('WorkspacesCreate', { name: name, snapshot: snapshot });
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
     * Lists the parameter groups in the UI for the partial-load dialog, parents before their children, plus whether any parameters have no group.
     * @returns {Object} { groups: [{ id, name, parentId, depth }], hasOther }.
     */
    listParamGroups() {
        let found = {};
        let groups = [];
        let hasOther = false;
        for (let param of gen_param_types) {
            if (!this.isCapturableParam(param) || param.id == 'model') {
                continue;
            }
            if (!param.group || typeof param.group != 'object') {
                hasOther = true;
                continue;
            }
            let chain = [];
            let group = param.group;
            while (group && typeof group == 'object') {
                chain.push(group);
                group = group.parent;
            }
            for (let item of chain.reverse()) {
                if (!found[item.id]) {
                    found[item.id] = true;
                    groups.push({ id: item.id, name: item.name || item.id, parentId: this.getParentGroupId(item), depth: this.getGroupDepth(item) });
                }
            }
        }
        let ordered = [];
        let addWithChildren = group => {
            ordered.push(group);
            for (let child of groups) {
                if (child.parentId == group.id) {
                    addWithChildren(child);
                }
            }
        };
        for (let group of groups) {
            if (!group.parentId || !found[group.parentId]) {
                addWithChildren(group);
            }
        }
        return { groups: ordered, hasOther: hasOther };
    }

    /**
     * Builds the snapshot for a partial load: the current Generate-tab state, with only the chosen parts taken from the workspace.
     * Loading the result with applySnapshot changes just the chosen parts. If a chosen group is switched on inside a parent group that is off and not chosen, the parent is switched on too, and a note says so.
     * @param {Object} source The stored workspace to load from.
     * @param {Object} selection { model, presets, other, groups: Set of group IDs }.
     * @returns {Object} { snapshot, notes }: the merged snapshot and readable notes about extra changes.
     */
    buildPartialSnapshot(source, selection) {
        let current = this.captureSnapshot();
        let merged = { schemaVersion: current.schemaVersion, values: current.values, groups: current.groups, presets: current.presets, unsupported: source.unsupported.slice() };
        let notes = [];
        for (let param of gen_param_types) {
            if (!this.isCapturableParam(param) || !source.values[param.id]) {
                continue;
            }
            let chosen;
            if (param.id == 'model') {
                chosen = selection.model;
            }
            else if (param.group && typeof param.group == 'object') {
                chosen = selection.groups.has(param.group.id);
            }
            else {
                chosen = selection.other;
            }
            if (chosen) {
                merged.values[param.id] = JSON.parse(JSON.stringify(source.values[param.id]));
            }
        }
        for (let groupId of selection.groups) {
            if (source.groups[groupId] && merged.groups[groupId]) {
                merged.groups[groupId].enabled = source.groups[groupId].enabled;
            }
        }
        if (selection.presets) {
            merged.presets = JSON.parse(JSON.stringify(source.presets));
        }
        // Walk the real group hierarchy, not just the toggle entries: a chosen group without a toggle of its own can still sit inside a toggle group that is off.
        let byId = {};
        for (let group of this.listParamGroups().groups) {
            byId[group.id] = group;
        }
        for (let groupId of selection.groups) {
            if (merged.groups[groupId] && !merged.groups[groupId].enabled) {
                continue;
            }
            let parentId = byId[groupId] ? byId[groupId].parentId : null;
            let guard = 0;
            while (parentId && guard++ < 50) {
                let parent = merged.groups[parentId];
                if (parent && !parent.enabled && !selection.groups.has(parentId)) {
                    parent.enabled = true;
                    notes.push(`"${byId[parentId] ? byId[parentId].name : parentId}" was switched on, because "${byId[groupId] ? byId[groupId].name : groupId}" is inside it.`);
                }
                parentId = byId[parentId] ? byId[parentId].parentId : null;
            }
        }
        return { snapshot: merged, notes: notes };
    }

    /**
     * Opens the partial-load dialog: pick a workspace, tick the parts to load, and everything unticked stays as it is.
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
        this.closeDialog();
        let info = this.listParamGroups();
        let backdrop = createDiv(null, 'hartsy-workspaces-dialog-backdrop');
        let dialog = createDiv(null, 'hartsy-workspaces-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', 'Load part of a workspace');
        backdrop.append(dialog);
        dialog.append(createDiv(null, 'hartsy-workspaces-dialog-title', 'Load part of a workspace'));
        let sourceRow = createDiv(null, 'hartsy-workspaces-dialog-row');
        sourceRow.append(document.createTextNode('From '));
        let source = document.createElement('select');
        source.className = 'hartsy-workspaces-dialog-source';
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
        dialog.append(sourceRow);
        dialog.append(createDiv(null, 'hartsy-workspaces-dialog-note', 'Only the ticked parts change. Everything else stays as it is now.'));
        let list = createDiv(null, 'hartsy-workspaces-dialog-list');
        let boxes = [];
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
                let hintElem = document.createElement('span');
                hintElem.className = 'hartsy-workspaces-dialog-hint';
                hintElem.textContent = hint;
                label.append(hintElem);
            }
            list.append(label);
            boxes.push(box);
        };
        addRow('model', '', 'Model', 0, null);
        addRow('presets', '', 'Presets', 0, 'The preset selection changes. Your current values in unticked groups are kept.');
        for (let group of info.groups) {
            addRow('group', group.id, group.name, group.depth, null);
        }
        if (info.hasOther) {
            addRow('other', '', 'Other parameters (no group)', 0, null);
        }
        dialog.append(list);
        let actions = createDiv(null, 'hartsy-workspaces-dialog-actions');
        let makeButton = (text, handler) => {
            let button = document.createElement('button');
            button.className = 'basic-button';
            button.textContent = text;
            button.addEventListener('click', handler);
            actions.append(button);
        };
        makeButton('Select all', () => {
            for (let box of boxes) {
                box.checked = true;
            }
        });
        makeButton('Select none', () => {
            for (let box of boxes) {
                box.checked = false;
            }
        });
        makeButton('Load', () => {
            let selection = { model: false, presets: false, other: false, groups: new Set() };
            for (let box of boxes) {
                if (!box.checked) {
                    continue;
                }
                if (box.dataset.kind == 'group') {
                    selection.groups.add(box.dataset.id);
                }
                else {
                    selection[box.dataset.kind] = true;
                }
            }
            let sourceId = source.value;
            this.closeDialog();
            this.partialLoad(sourceId, selection);
        });
        makeButton('Cancel', () => {
            this.closeDialog();
        });
        dialog.append(actions);
        let onKey = event => {
            if (event.key == 'Escape') {
                this.closeDialog();
            }
        };
        document.addEventListener('keydown', onKey);
        backdrop.addEventListener('mousedown', event => {
            if (event.target == backdrop) {
                this.closeDialog();
            }
        });
        this.closeDialogHandler = () => {
            document.removeEventListener('keydown', onKey);
            backdrop.remove();
        };
        document.body.append(backdrop);
        source.focus();
    }

    /**
     * Closes the partial-load dialog if it is open.
     */
    closeDialog() {
        if (this.closeDialogHandler) {
            let handler = this.closeDialogHandler;
            this.closeDialogHandler = null;
            handler();
        }
    }

    /**
     * Loads the chosen parts of a workspace into the Generate tab. The current workspace and its baseline stay as they are, so the result shows as modified.
     * @param {string} sourceId The workspace to load from.
     * @param {Object} selection The chosen parts: { model, presets, other, groups: Set of group IDs }.
     */
    async partialLoad(sourceId, selection) {
        if (this.busy || this.restoring) {
            return;
        }
        if (!selection.model && !selection.presets && !selection.other && selection.groups.size == 0) {
            showError('Nothing was ticked, so nothing was loaded.');
            return;
        }
        this.setBusy(true);
        try {
            try {
                await this.listWorkspaces();
            }
            catch (error) {
                console.error('Workspaces: could not refresh the list before loading; using the cached list.', error);
            }
            let source = this.workspaces.find(w => w.id == sourceId);
            if (!source) {
                showError('That workspace no longer exists. The list was refreshed.');
                return;
            }
            let problem = this.validateSnapshot(source);
            if (problem) {
                showError(`This workspace cannot be loaded: ${problem}`);
                return;
            }
            let built = this.buildPartialSnapshot(source, selection);
            let result = await this.applySnapshot(built.snapshot, { notify: false });
            if (result.status == 'success') {
                result.message = 'The chosen parts were loaded.';
            }
            for (let note of built.notes) {
                result.warnings.push(note);
            }
            this.showResult(result);
            if (result.status == 'success' || result.status == 'incomplete') {
                this.setStatus(`Loaded the chosen parts of "${source.name}".`);
            }
        }
        finally {
            this.setBusy(false);
        }
    }

    /**
     * Turns a stored workspace into the form written to export files: the saved settings and the name, without server-owned fields.
     * @param {Object} entry The stored workspace.
     * @returns {Object} The export entry.
     */
    toExportEntry(entry) {
        return { name: entry.name, schemaVersion: entry.schemaVersion, values: entry.values, groups: entry.groups, presets: entry.presets, unsupported: entry.unsupported };
    }

    /**
     * Downloads workspaces as one JSON file.
     * @param {Array<Object>} entries The stored workspaces to export.
     * @param {string} fileName The file name to suggest.
     */
    downloadExport(entries, fileName) {
        let data = { format: this.exportFormat, formatVersion: 1, exportedAt: new Date().toISOString(), workspaces: entries.map(e => this.toExportEntry(e)) };
        let blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
        let url = URL.createObjectURL(blob);
        let link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    /**
     * Exports the current workspace's saved version.
     */
    exportCurrent() {
        let entry = this.getCurrentEntry();
        if (!entry) {
            return;
        }
        let safeName = `${entry.name}`.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'workspace';
        this.downloadExport([entry], `swarmui-workspace-${safeName}.json`);
        this.setStatus(`Exported the saved version of "${entry.name}".`);
    }

    /**
     * Exports every workspace as one file.
     */
    async exportAll() {
        if (this.busy) {
            return;
        }
        try {
            await this.listWorkspaces();
        }
        catch (error) {
            console.error('Workspaces: could not refresh the list before exporting; using the cached list.', error);
        }
        if (this.workspaces.length == 0) {
            showError('There are no workspaces to export.');
            return;
        }
        this.downloadExport(this.workspaces, 'swarmui-workspaces.json');
        this.setStatus(`Exported ${this.workspaces.length} ${this.workspaces.length == 1 ? 'workspace' : 'workspaces'}.`);
    }

    /**
     * Opens a file picker and imports the chosen file.
     */
    pickImportFile() {
        if (this.busy || this.restoring) {
            return;
        }
        let input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => {
            if (input.files && input.files.length > 0) {
                this.importFile(input.files[0]);
            }
        });
        input.click();
    }

    /**
     * Reads, checks, and imports a workspace file. The whole file is checked before anything is sent, and the server stores all of it or none of it.
     * @param {File} file The chosen file.
     */
    async importFile(file) {
        if (this.busy || this.restoring) {
            return;
        }
        if (file.size > this.maxImportBytes) {
            showError(`Nothing was imported: the file is larger than ${Math.round(this.maxImportBytes / 1024 / 1024)} MB.`);
            return;
        }
        let text;
        try {
            text = await file.text();
        }
        catch (error) {
            showError('Nothing was imported: the file could not be read.');
            return;
        }
        let parsed = this.parseImport(text);
        if (parsed.error) {
            showError(`Nothing was imported: ${parsed.error}`);
            return;
        }
        this.setBusy(true);
        try {
            let response;
            try {
                await this.listWorkspaces();
                this.makeNamesUnique(parsed.entries);
                response = await this.callApi('WorkspacesImport', { workspaces: parsed.entries });
            }
            catch (error) {
                showError(`Nothing was imported: ${error}`);
                return;
            }
            let summary = `Imported ${response.imported} ${response.imported == 1 ? 'workspace' : 'workspaces'}.`;
            this.setStatus(summary);
            try {
                await this.listWorkspaces();
            }
            catch (error) {
                // The server already stored everything, so say so: importing the file again would add a second copy.
                showError(`${summary} The list could not be refreshed (${error}). Reload the page to see them, and do not import the file again.`);
            }
        }
        finally {
            this.setBusy(false);
        }
    }

    /**
     * Checks the text of an import file as a whole. Accepts an export file, a bare list of workspaces, or a single workspace.
     * @param {string} text The file text.
     * @returns {Object} { entries } with clean workspace entries, or { error } describing the first problem.
     */
    parseImport(text) {
        let data;
        try {
            data = JSON.parse(text);
        }
        catch (error) {
            return { error: 'the file is not valid JSON.' };
        }
        let list;
        if (Array.isArray(data)) {
            list = data;
        }
        else if (this.isPlainObject(data) && Array.isArray(data.workspaces)) {
            if ('format' in data && data.format != this.exportFormat) {
                return { error: 'the file is not a Workspaces export.' };
            }
            if (Number.isInteger(data.formatVersion) && data.formatVersion > 1) {
                return { error: `the file uses export format ${data.formatVersion}, which is newer than this extension supports. Update the Workspaces extension.` };
            }
            list = data.workspaces;
        }
        else if (this.isPlainObject(data) && 'schemaVersion' in data) {
            list = [data];
        }
        else {
            return { error: 'the file is not a Workspaces export.' };
        }
        if (list.length == 0) {
            return { error: 'the file contains no workspaces.' };
        }
        if (list.length > this.maxImportCount) {
            return { error: `the file contains ${list.length} workspaces, and an import can hold at most ${this.maxImportCount}.` };
        }
        let entries = [];
        for (let i = 0; i < list.length; i++) {
            let item = list[i];
            let label = `workspace ${i + 1}`;
            if (!this.isPlainObject(item)) {
                return { error: `${label} is not an object.` };
            }
            let name = typeof item.name == 'string' ? item.name.trim() : '';
            if (name.length < 1 || name.length > this.maxNameLength) {
                return { error: `${label} needs a name of 1 to ${this.maxNameLength} characters.` };
            }
            let problem = this.validateSnapshot(item);
            if (problem) {
                return { error: `${label} ("${name}") cannot be imported: ${problem}` };
            }
            entries.push(this.toExportEntry({ name: name, schemaVersion: item.schemaVersion, values: item.values, groups: item.groups, presets: item.presets, unsupported: item.unsupported }));
        }
        return { entries: entries };
    }

    /**
     * Renames imported entries whose names are already taken (by existing workspaces or earlier entries in the file) by adding " (2)", " (3)", and so on.
     * @param {Array<Object>} entries The entries to import. Changed in place.
     */
    makeNamesUnique(entries) {
        let used = new Set();
        for (let workspace of this.workspaces) {
            used.add(`${workspace.name}`.toLowerCase());
        }
        for (let entry of entries) {
            let name = entry.name;
            let counter = 2;
            while (used.has(name.toLowerCase())) {
                let suffix = ` (${counter++})`;
                name = `${entry.name.slice(0, this.maxNameLength - suffix.length)}${suffix}`;
            }
            entry.name = name;
            used.add(name.toLowerCase());
        }
    }

    /**
     * Reads a browser-storage value. Storage can be blocked or full, so every access is guarded.
     * @param {string} key The storage key.
     * @returns {string} The value, or null if missing or unavailable.
     */
    storageGet(key) {
        try {
            return localStorage.getItem(key);
        }
        catch (error) {
            return null;
        }
    }

    /**
     * Writes a browser-storage value.
     * @param {string} key The storage key.
     * @param {string} value The value.
     * @returns {boolean} True if it was stored.
     */
    storageSet(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        }
        catch (error) {
            return false;
        }
    }

    /**
     * Removes a browser-storage value, ignoring failures.
     * @param {string} key The storage key.
     */
    storageRemove(key) {
        try {
            localStorage.removeItem(key);
        }
        catch (error) {
            // Nothing to do: storage is unavailable.
        }
    }

    /**
     * Builds a storage key scoped to this server and user, so drafts from other servers or accounts never mix.
     * @param {string} kind 'draft' or 'alive'.
     * @param {string} tabId The tab the key belongs to.
     * @returns {string} The key.
     */
    scopeKey(kind, tabId) {
        return `${this.scopePrefix()}${kind}:${tabId}`;
    }

    /**
     * Returns the storage key prefix shared by all of this server-and-user's draft and tab keys.
     * @returns {string} The prefix.
     */
    scopePrefix() {
        return `hartsy_workspaces:${location.origin}:${typeof user_id != 'undefined' && user_id ? user_id : ''}:`;
    }

    /**
     * Returns this tab's ID. It is kept in session storage, so a reload keeps it and a new tab gets its own.
     * A duplicated tab copies session storage, so an ID whose tab is still marked open gets replaced.
     * @returns {string} The tab ID.
     */
    getTabId() {
        if (this.tabId) {
            return this.tabId;
        }
        let id = null;
        try {
            id = sessionStorage.getItem('hartsy_workspaces_tab');
        }
        catch (error) {
            id = null;
        }
        if (id) {
            let alive = parseInt(this.storageGet(this.scopeKey('alive', id)) || '0');
            if (Date.now() - alive < this.staleTabMs) {
                id = null;
            }
        }
        if (!id) {
            id = typeof crypto != 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            try {
                sessionStorage.setItem('hartsy_workspaces_tab', id);
            }
            catch (error) {
                // Session storage is blocked: the ID just lasts for this page load.
            }
        }
        this.tabId = id;
        return id;
    }

    /**
     * Starts marking this tab as open every few seconds, so other tabs can tell a closed tab's draft from a live tab's. Safe to call repeatedly.
     */
    startHeartbeat() {
        if (this.heartbeatTimer) {
            return;
        }
        let key = this.scopeKey('alive', this.getTabId());
        let beat = () => {
            this.storageSet(key, `${Date.now()}`);
        };
        beat();
        this.heartbeatTimer = setInterval(beat, this.heartbeatMs);
        window.addEventListener('pagehide', () => {
            this.storageRemove(key);
        });
    }

    /**
     * Schedules a debounced save of this tab's draft: the current unsaved settings of the current workspace.
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
     * Writes this tab's draft to browser storage, if the settings still differ from the current workspace. Other tabs' drafts are never touched.
     */
    saveDraft() {
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
        let record = { tabId: this.getTabId(), workspaceId: entry.id, workspaceName: entry.name, revision: this.currentRevision, savedAt: Date.now(), snapshot: snapshot };
        if (!this.storageSet(this.scopeKey('draft', this.getTabId()), JSON.stringify(record))) {
            this.setStatus('Could not keep a draft of your unsaved changes: browser storage is full or blocked.');
        }
    }

    /**
     * Removes this tab's draft and cancels any pending draft save. Used whenever the settings match a workspace again.
     */
    clearDraft() {
        if (this.draftTimer) {
            clearTimeout(this.draftTimer);
            this.draftTimer = null;
        }
        let key = this.scopeKey('draft', this.getTabId());
        if (this.storageGet(key) != null) {
            this.storageRemove(key);
        }
    }

    /**
     * Lists drafts that can be recovered: this tab's own draft from before a reload, and drafts of tabs that are no longer open. Newest first.
     * @returns {Array<Object>} Draft records, each with a 'key' field naming its storage entry.
     */
    findDrafts() {
        let prefix = this.scopePrefix();
        let ownKey = this.scopeKey('draft', this.getTabId());
        let found = [];
        let keys = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                let key = localStorage.key(i);
                if (key && key.startsWith(`${prefix}draft:`)) {
                    keys.push(key);
                }
            }
        }
        catch (error) {
            return [];
        }
        for (let key of keys) {
            let record;
            try {
                record = JSON.parse(this.storageGet(key));
            }
            catch (error) {
                record = null;
            }
            if (!this.isPlainObject(record) || typeof record.tabId != 'string' || !this.isPlainObject(record.snapshot)) {
                this.storageRemove(key);
                continue;
            }
            if (key != ownKey) {
                let alive = parseInt(this.storageGet(this.scopeKey('alive', record.tabId)) || '0');
                if (Date.now() - alive < this.staleTabMs) {
                    continue;
                }
            }
            record.key = key;
            found.push(record);
        }
        found.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        return found;
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
     * Shows a notice in the toolbar for the newest recoverable draft, with Restore and Discard. Removes the notice when there is none.
     */
    showRecovery() {
        let toolbar = document.querySelector('.hartsy-workspaces-toolbar');
        if (!toolbar) {
            return;
        }
        for (let old of toolbar.querySelectorAll('.hartsy-workspaces-recover')) {
            old.remove();
        }
        let drafts = this.findDrafts();
        if (drafts.length == 0) {
            return;
        }
        let draft = drafts[0];
        let banner = createDiv(null, 'hartsy-workspaces-recover');
        let text = document.createElement('span');
        text.className = 'hartsy-workspaces-recover-text';
        let more = drafts.length > 1 ? ` (${drafts.length - 1} more after this)` : '';
        text.textContent = `Unsaved changes to "${draft.workspaceName || 'a workspace'}" from ${new Date(draft.savedAt).toLocaleString()} were found${more}.`;
        banner.append(text);
        let restore = document.createElement('button');
        restore.className = 'basic-button';
        restore.textContent = 'Restore';
        restore.addEventListener('click', () => {
            this.recoverDraft(draft);
        });
        banner.append(restore);
        let discard = document.createElement('button');
        discard.className = 'basic-button';
        discard.textContent = 'Discard';
        discard.addEventListener('click', () => {
            this.storageRemove(draft.key);
            this.showRecovery();
        });
        banner.append(discard);
        toolbar.append(banner);
    }

    /**
     * Restores a recovered draft. If its workspace still exists, that workspace is loaded first, so the draft shows as unsaved changes to it. Named workspaces are never overwritten by recovery.
     * @param {Object} draft The draft record from findDrafts.
     */
    async recoverDraft(draft) {
        if (this.busy || this.restoring) {
            return;
        }
        let entry = draft.workspaceId ? this.workspaces.find(w => w.id == draft.workspaceId) : null;
        if (entry) {
            await this.loadWorkspace(entry.id);
            if (this.currentId != entry.id) {
                // The load was refused or cancelled; the draft stays so it can be recovered later.
                return;
            }
        }
        let result;
        this.setBusy(true);
        try {
            result = await this.applySnapshot(draft.snapshot);
        }
        finally {
            this.setBusy(false);
        }
        if (result.status != 'success' && result.status != 'incomplete') {
            return;
        }
        this.storageRemove(draft.key);
        if (!entry) {
            this.setStatus('Restored the draft. Its workspace no longer exists, so these settings are not attached to one. Use Save As to keep them.');
        }
        else if (entry.revision != draft.revision) {
            this.setStatus(`Restored the draft. "${entry.name}" was saved elsewhere after this draft was made, so saving now replaces that newer version.`);
        }
        else {
            this.setStatus('Restored the draft.');
        }
        this.showRecovery();
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
        if (this.closeDialogHandler || this.busy || this.restoring || document.querySelector('.modal.show')) {
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
            this.clearDraft();
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
