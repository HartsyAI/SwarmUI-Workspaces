/**
 * Workspaces: small pure helpers and constants shared by the manager's modules. Nothing here touches the page.
 */

/** Snapshot schema version this script reads and writes. */
export const SCHEMA_VERSION = 1;

/** Parameter IDs never captured or restored: custom workflow data, which is outside the supported scope. */
export const EXCLUDED_PARAM_IDS = ['comfyworkflowraw', 'comfyworkflowparammetadata', 'comfyuicustomworkflow'];

/** Parameter types never captured or restored: media inputs (setDirectParamValue cannot restore raw image data). */
export const MEDIA_PARAM_TYPES = ['image', 'audio', 'video', 'image_list', 'audio_list', 'video_list'];

/** Readable names for the unsupported-state IDs stored in a snapshot's 'unsupported' list. */
export const UNSUPPORTED_LABELS = {
    custom_workflow: 'a custom Comfy workflow',
    init_image: 'an init image',
    mask: 'a mask image',
    image_editor: 'the image editor'
};

/**
 * Converts a list value (array or comma-separated string) to an array of strings.
 * @param {*} value The value.
 * @returns {Array<string>} The list.
 */
export function toList(value) {
    if (Array.isArray(value)) {
        return value.map(item => `${item}`);
    }
    if (value == null) {
        return [];
    }
    return `${value}`.split(',').map(item => item.trim()).filter(item => item != '');
}

/**
 * Converts a numeric input value to a number when that is lossless; otherwise returns the trimmed text.
 * @param {Object} param The parameter definition (integer or decimal).
 * @param {*} raw The raw value.
 * @returns {number|string} The normalized value.
 */
export function normalizeNumber(param, raw) {
    let text = raw == null ? '' : `${raw}`.trim();
    let num = Number(text);
    if (text == '' || !Number.isFinite(num) || (param.type == 'integer' && !Number.isSafeInteger(num))) {
        return text;
    }
    return num;
}

/**
 * Compares two values of a parameter after normalizing them the same way capture does.
 * @param {Object} param The parameter definition.
 * @param {*} left One value.
 * @param {*} right The other value.
 * @returns {boolean} True if they are the same.
 */
export function valuesEqual(param, left, right) {
    if (Array.isArray(left) || Array.isArray(right)) {
        return arraysEqual(toList(left), toList(right));
    }
    if (param.type == 'integer' || param.type == 'decimal') {
        return `${normalizeNumber(param, left)}` == `${normalizeNumber(param, right)}`;
    }
    return `${left ?? ''}` == `${right ?? ''}`;
}

/**
 * Returns the option values of a select element, in order.
 * @param {HTMLSelectElement} elem The select.
 * @returns {Array<string>} The option values.
 */
export function optionValues(elem) {
    return Array.from(elem.options, option => option.value);
}

/**
 * Returns whether an element is a multi-select (an ordered list parameter such as LoRAs).
 * @param {HTMLElement} elem The input element.
 * @returns {boolean} True for a multi-select.
 */
export function isMultiSelect(elem) {
    return elem.tagName == 'SELECT' && elem.multiple;
}

/**
 * Joins readable labels for a list of unsupported-state IDs.
 * @param {Array<string>} ids The IDs.
 * @returns {string} The labels, joined with commas and "and".
 */
export function describeUnsupported(ids) {
    let labels = ids.map(id => UNSUPPORTED_LABELS[id] || id);
    if (labels.length <= 1) {
        return labels.join('');
    }
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Builds a restore result object.
 * @param {string} status One of 'success', 'incomplete', 'refused', 'cancelled', 'failed', 'partial'.
 * @param {string} message A readable summary.
 * @param {Array} skipped Items that could not be restored.
 * @param {Array<string>} warnings Readable warnings.
 * @returns {Object} The result.
 */
export function makeResult(status, message, skipped = [], warnings = []) {
    return { status: status, message: message, skipped: skipped, warnings: warnings };
}

/**
 * Returns whether a restore result means the Generate tab now holds the workspace.
 * @param {Object} result A restore result.
 * @returns {boolean} True for 'success' and 'incomplete'.
 */
export function restoreSucceeded(result) {
    return result.status == 'success' || result.status == 'incomplete';
}
