/**
 * Workspaces: the toolbar above the Generate tab's parameters, its "More" menu and its "?" help.
 * The picker is a plain SwarmUI dropdown (select.auto-dropdown) and the menu is SwarmUI's own popover (AdvancedPopover), so both follow every theme.
 */

/** The plain-language help shown by the toolbar's "?": what a workspace is and what every control does. */
let TOOLBAR_HELP_HTML = '<b>Workspaces</b><br>A workspace saves your whole Generate tab so you can switch setups in one step: every setting, which settings and groups are switched on, and which presets are active. '
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

/**
 * Adds the toolbar to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function ToolbarMixin(Base) {
    return class extends Base {
        /**
         * Creates the toolbar state.
         */
        constructor() {
            super();
            /** The SwarmUI popover (the menu) opened from the toolbar, or null. Its 'popover' field is null once it has closed. */
            this.activePopover = null;
            /** Pending timer that clears the toolbar's status text, or null. */
            this.statusTimer = null;
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
            for (let i = 1; i < toolbars.length; i++) {
                toolbars[i].remove();
            }
            let toolbar = toolbars.length > 0 ? toolbars[0] : this.buildToolbar();
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
         * @returns {Element} The new toolbar, not yet placed on the page.
         */
        buildToolbar() {
            let toolbar = createDiv(null, 'hartsy-workspaces-toolbar');
            let help = this.makeHelp('hartsy_workspaces_help', TOOLBAR_HELP_HTML);
            toolbar.innerHTML = '<div class="hartsy-workspaces-bar">'
                + '<select class="auto-dropdown hartsy-workspaces-picker" autocomplete="off" title="Choose a workspace to load"></select>'
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
            let addOptions = (parent, items) => {
                for (let item of items) {
                    parent.append(new Option(item.name, item.id));
                }
            };
            select.append(new Option('No workspace', ''));
            let sorted = this.sortedWorkspaces();
            let starred = sorted.filter(workspace => workspace.starred);
            if (starred.length == 0) {
                addOptions(select, sorted);
            }
            else {
                for (let [label, items] of [['Starred', starred], ['Other workspaces', sorted.filter(workspace => !workspace.starred)]]) {
                    if (items.length > 0) {
                        let group = document.createElement('optgroup');
                        group.label = label;
                        addOptions(group, items);
                        select.append(group);
                    }
                }
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
         * Shows a short status line in the toolbar, which clears itself after a few seconds.
         * @param {string} text The message.
         */
        setStatus(text) {
            let status = document.querySelector('.hartsy-workspaces-status');
            if (!status) {
                return;
            }
            status.textContent = text;
            clearTimeout(this.statusTimer);
            this.statusTimer = setTimeout(() => {
                this.statusTimer = null;
                status.textContent = '';
            }, 8000);
        }
    };
}
