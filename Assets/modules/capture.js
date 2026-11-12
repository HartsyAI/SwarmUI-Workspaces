/**
 * Workspaces: reading the Generate tab. Captures parameter values, switches, groups, presets and unsupported state as a schema v1 snapshot.
 */
import { SCHEMA_VERSION, EXCLUDED_PARAM_IDS, MEDIA_PARAM_TYPES, isMultiSelect, normalizeNumber, toList } from './helpers.js';

/**
 * Adds capture of the Generate tab's controls to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function CaptureMixin(Base) {
    return class extends Base {
        /**
         * Returns whether the Generate tab's parameters have been built.
         * @returns {boolean} True if parameters are available.
         */
        isReady() {
            return typeof gen_param_types != 'undefined' && gen_param_types != null && document.getElementById('main_inputs_area') != null;
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
            if (EXCLUDED_PARAM_IDS.includes(param.id) || MEDIA_PARAM_TYPES.includes(param.type)) {
                return false;
            }
            return this.getParamElem(param) != null;
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
                return normalizeNumber(param, raw);
            }
            return raw == null ? '' : `${raw}`;
        }

        /**
         * Returns a parameter's registered default value, in a form setDirectParamValue accepts.
         * @param {Object} param The parameter definition.
         * @param {HTMLElement} elem The parameter's input element.
         * @returns {*} The default value.
         */
        defaultValueFor(param, elem) {
            if (isMultiSelect(elem)) {
                return toList(param.default);
            }
            if (param.type == 'boolean') {
                return `${param.default}` == 'true';
            }
            return param.default == null ? '' : param.default;
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
                if (this.isCapturableParam(param)) {
                    values[param.id] = { value: this.readParamValue(param, this.getParamElem(param)), enabled: this.isParamToggleOn(param) };
                }
            }
            let groups = {};
            for (let group of this.listToggleGroups()) {
                groups[group.id] = { enabled: this.getGroupToggle(group.id).checked };
            }
            // Presets are captured in selection order, by title. The server records each preset's current definition when the snapshot is saved.
            let presets = currentPresets.map(preset => ({ title: preset.title }));
            return { schemaVersion: SCHEMA_VERSION, values: values, groups: groups, presets: presets, unsupported: this.detectUnsupportedState() };
        }

        /**
         * Captures the current state, or reports why that was not possible.
         * @param {Function} report Called with the error when the state cannot be read.
         * @returns {Object|null} The snapshot, or null after reporting.
         */
        tryCaptureSnapshot(report) {
            try {
                return this.captureSnapshot();
            }
            catch (error) {
                report(error);
                return null;
            }
        }

        /**
         * Reduces a snapshot to the parts that count for modified-state comparison. Timestamps, revision, and name are left out. List order is kept.
         * Keys always come in the order capture produces them, so equal states give equal text.
         * @param {Object} snapshot A captured snapshot.
         * @returns {string} Text for comparing two states.
         */
        normalizeState(snapshot) {
            return JSON.stringify({ values: snapshot.values, groups: snapshot.groups, presets: snapshot.presets, unsupported: snapshot.unsupported });
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
            if (document.getElementById('input_initimage')?.dataset.filedata) {
                found.push('init_image');
            }
            if (document.getElementById('input_maskimage')?.dataset.filedata) {
                found.push('mask');
            }
            if (this.isImageEditorActive()) {
                found.push('image_editor');
            }
            return found;
        }

        /**
         * Returns whether SwarmUI's image editor is open.
         * @returns {boolean} True while the editor is active.
         */
        isImageEditorActive() {
            return typeof imageEditor != 'undefined' && Boolean(imageEditor && imageEditor.active);
        }

        /**
         * Returns every toggle group present in the UI, parents before children.
         * @returns {Array<Object>} The group definitions.
         */
        listToggleGroups() {
            let found = new Set();
            let groups = [];
            for (let param of gen_param_types) {
                for (let start of [param.group, param.original_group]) {
                    let group = start;
                    while (group && typeof group == 'object') {
                        if (group.toggles && !found.has(group.id) && this.getGroupToggle(group.id)) {
                            found.add(group.id);
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
            for (let parent = group.parent; parent && typeof parent == 'object'; parent = parent.parent) {
                depth++;
            }
            return depth;
        }
    };
}
