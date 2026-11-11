/**
 * Workspaces: SwarmUI's own "?" help popover and modal dialog, built from SwarmUI's standard markup.
 */

/**
 * Adds help popovers and modals to a class.
 * @param {Function} Base The class to extend.
 * @returns {Function} The extended class.
 */
export function ModalMixin(Base) {
    return class extends Base {
        /**
         * Builds a SwarmUI "?" help button and its info popover, the same pair (and classes) SwarmUI puts beside its own settings in its default button style.
         * SwarmUI's hover style is not used: it looks for a settings input with this ID, which a toolbar does not have, so the "?" button is always shown.
         * @param {string} id A unique ID for this help.
         * @param {string} html The help text, as HTML written in this extension (never user input).
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
            let modal = createDiv(null, null, modalHeader(id, escapeHtml(title) + (help ? help.button : '')) + '<div class="modal-body"></div><div class="modal-footer"></div>' + modalFooter()).firstElementChild;
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
            quickAppendButton(footer, escapeHtml(text), handler, ` btn ${primary ? 'btn-primary' : 'btn-secondary'}`);
            return footer.lastElementChild;
        }
    };
}
