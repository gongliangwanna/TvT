(function () {
    'use strict';

    const SEARCH_THRESHOLD = 12;
    let overlay = null;
    let activeSelect = null;
    let activeCustom = null;
    let lastTrigger = null;
    let ignoreOverlayClickUntil = 0;

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function readableText(element) {
        if (!element) return '';
        const clone = element.cloneNode(true);
        clone.querySelectorAll('select, input, textarea, button, option, p, small, .api-field-tip').forEach(node => node.remove());
        return normalizeText(clone.textContent);
    }

    function findTitle(select) {
        const explicit = normalizeText(select.getAttribute('aria-label') || select.getAttribute('title'));
        if (explicit) return explicit;

        if (select.id) {
            const label = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
            const text = readableText(label);
            if (text) return text;
        }

        const wrappingLabel = select.closest('label');
        const wrappingText = readableText(wrappingLabel);
        if (wrappingText) return wrappingText;

        const item = select.closest('.kkt-item, .form-group, .api-sub-presets-strip, .reminder-form-group, .theater-control-group');
        if (item) {
            const heading = item.querySelector('.kkt-item-label, .api-sub-presets-label, :scope > label');
            const text = readableText(heading);
            if (text) return text;
        }

        let ancestor = select.parentElement;
        for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
            const heading = ancestor.querySelector(':scope > .kkt-item-label, :scope > label');
            const text = readableText(heading);
            if (text) return text;
        }

        const fieldName = select.name || select.id || '';
        return fieldName ? '选择选项' : '请选择';
    }

    function createModal() {
        const root = document.createElement('div');
        root.className = 'centered-select-overlay';
        root.hidden = true;
        root.setAttribute('aria-hidden', 'true');
        root.innerHTML = `
            <section class="centered-select-panel" role="dialog" aria-modal="true" aria-labelledby="centered-select-title" tabindex="-1">
                <header class="centered-select-header">
                    <h2 id="centered-select-title" class="centered-select-title">请选择</h2>
                    <button type="button" class="centered-select-close" aria-label="关闭选择窗口">×</button>
                </header>
                <div class="centered-select-search" hidden>
                    <span class="centered-select-search-icon" aria-hidden="true"></span>
                    <input type="search" class="centered-select-search-input" placeholder="搜索选项" autocomplete="off" spellcheck="false">
                </div>
                <div class="centered-select-list" role="listbox"></div>
                <div class="centered-select-empty" hidden>没有匹配的选项</div>
                <div class="centered-select-custom-host" hidden></div>
                <footer class="centered-select-footer" hidden>
                    <button type="button" class="centered-select-done">完成</button>
                </footer>
            </section>`;
        document.body.appendChild(root);

        root.addEventListener('click', event => {
            if (Date.now() >= ignoreOverlayClickUntil) return;
            event.preventDefault();
            event.stopPropagation();
        }, true);
        root.querySelector('.centered-select-close').addEventListener('click', closeModal);
        root.querySelector('.centered-select-done').addEventListener('click', closeModal);
        root.addEventListener('click', event => {
            if (event.target === root) closeModal();
        });
        root.querySelector('.centered-select-search-input').addEventListener('input', event => {
            filterOptions(event.target.value);
        });
        root.querySelector('.centered-select-list').addEventListener('click', event => {
            const button = event.target.closest('.centered-select-option');
            if (!button || button.disabled || !activeSelect) return;
            chooseOption(Number(button.dataset.optionIndex));
        });
        root.querySelector('.centered-select-custom-host').addEventListener('click', event => {
            event.stopPropagation();
        });
        return root;
    }

    function filterOptions(query) {
        if (!overlay) return;
        const needle = normalizeText(query).toLocaleLowerCase();
        let visibleCount = 0;
        overlay.querySelectorAll('.centered-select-option').forEach(button => {
            const matches = !needle || button.dataset.searchText.includes(needle);
            button.hidden = !matches;
            if (matches) visibleCount += 1;
        });
        overlay.querySelectorAll('.centered-select-group').forEach(group => {
            group.hidden = !group.querySelector('.centered-select-option:not([hidden])');
        });
        overlay.querySelector('.centered-select-empty').hidden = visibleCount !== 0;
    }

    function makeOptionButton(option, optionIndex) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'centered-select-option';
        button.dataset.optionIndex = String(optionIndex);
        button.dataset.searchText = normalizeText(option.textContent).toLocaleLowerCase();
        button.disabled = option.disabled || Boolean(option.parentElement?.disabled);
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', option.selected ? 'true' : 'false');
        if (option.selected) button.classList.add('is-selected');

        const label = document.createElement('span');
        label.className = 'centered-select-option-label';
        label.textContent = normalizeText(option.textContent) || '未命名选项';
        const mark = document.createElement('span');
        mark.className = 'centered-select-option-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = '✓';
        button.append(label, mark);
        return button;
    }

    function renderOptions(select) {
        const list = overlay.querySelector('.centered-select-list');
        list.replaceChildren();
        let optionIndex = 0;

        Array.from(select.children).forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                const group = document.createElement('section');
                group.className = 'centered-select-group';
                const heading = document.createElement('div');
                heading.className = 'centered-select-group-label';
                heading.textContent = normalizeText(child.label);
                group.appendChild(heading);
                Array.from(child.children).forEach(option => {
                    group.appendChild(makeOptionButton(option, optionIndex));
                    optionIndex += 1;
                });
                list.appendChild(group);
                return;
            }
            if (child.tagName === 'OPTION') {
                list.appendChild(makeOptionButton(child, optionIndex));
                optionIndex += 1;
            }
        });

        const searchableCount = select.options.length;
        const search = overlay.querySelector('.centered-select-search');
        const searchInput = overlay.querySelector('.centered-select-search-input');
        search.hidden = searchableCount <= SEARCH_THRESHOLD;
        searchInput.value = '';
        overlay.querySelector('.centered-select-empty').hidden = true;
    }

    function openModal(select, suppressOpeningClick = false) {
        if (!(select instanceof HTMLSelectElement) || select.disabled || select.multiple) return;
        if (!overlay) overlay = createModal();
        restoreCustomDropdown();
        activeSelect = select;
        lastTrigger = select;
        overlay.querySelector('.centered-select-title').textContent = findTitle(select);
        overlay.querySelector('.centered-select-list').hidden = false;
        overlay.querySelector('.centered-select-custom-host').hidden = true;
        overlay.querySelector('.centered-select-footer').hidden = true;
        renderOptions(select);
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('centered-select-open');
        ignoreOverlayClickUntil = suppressOpeningClick ? Date.now() + 450 : 0;

        requestAnimationFrame(() => {
            const selected = overlay.querySelector('.centered-select-option.is-selected');
            const panel = overlay.querySelector('.centered-select-panel');
            panel.focus({ preventScroll: true });
            selected?.scrollIntoView({ block: 'center' });
        });
    }

    function closeModal() {
        if (!overlay || overlay.hidden) return;
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('centered-select-open');
        ignoreOverlayClickUntil = 0;
        activeSelect = null;
        restoreCustomDropdown();
        const trigger = lastTrigger;
        lastTrigger = null;
        if (trigger?.isConnected && !trigger.disabled) {
            requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
        }
    }

    function restoreCustomDropdown() {
        if (!activeCustom) return;
        const { dropdown, parent, nextSibling, className, inlineDisplay } = activeCustom;
        if (parent?.isConnected) parent.insertBefore(dropdown, nextSibling?.parentNode === parent ? nextSibling : null);
        dropdown.className = className;
        dropdown.style.display = inlineDisplay;
        activeCustom = null;
    }

    function openCustomDropdown(display) {
        const wrapper = display.closest('.theater-multiselect-wrapper, .theater-multiselect-container, [id$="-style-wb-container"]') || display.parentElement;
        const dropdown = wrapper?.querySelector('.theater-multiselect-dropdown');
        if (!dropdown) return;
        if (!overlay) overlay = createModal();
        restoreCustomDropdown();
        activeSelect = null;
        activeCustom = {
            dropdown,
            parent: dropdown.parentNode,
            nextSibling: dropdown.nextSibling,
            className: dropdown.className,
            inlineDisplay: dropdown.style.display,
        };
        lastTrigger = display;

        overlay.querySelector('.centered-select-title').textContent = findTitle(display);
        overlay.querySelector('.centered-select-search').hidden = true;
        overlay.querySelector('.centered-select-list').hidden = true;
        overlay.querySelector('.centered-select-empty').hidden = true;
        const host = overlay.querySelector('.centered-select-custom-host');
        host.hidden = false;
        host.appendChild(dropdown);
        dropdown.classList.add('open', 'show');
        dropdown.style.display = 'block';
        overlay.querySelector('.centered-select-footer').hidden = false;
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('centered-select-open');
        requestAnimationFrame(() => overlay.querySelector('.centered-select-panel').focus({ preventScroll: true }));
    }

    function chooseOption(optionIndex) {
        const select = activeSelect;
        if (!select || optionIndex < 0 || optionIndex >= select.options.length) return;
        const option = select.options[optionIndex];
        if (option.disabled || option.parentElement?.disabled) return;
        const changed = select.selectedIndex !== optionIndex;
        select.selectedIndex = optionIndex;
        closeModal();
        if (changed) {
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function selectableFromEvent(event) {
        const select = event.target instanceof Element ? event.target.closest('select') : null;
        if (!select || select.disabled || select.multiple || select.dataset.nativeSelect === 'true') return null;
        return select;
    }

    document.addEventListener('pointerdown', event => {
        const select = selectableFromEvent(event);
        if (!select || event.button > 0) return;
        event.preventDefault();
        openModal(select, true);
    }, true);

    document.addEventListener('click', event => {
        const customDisplay = event.target instanceof Element
            ? event.target.closest('.theater-multiselect-display')
            : null;
        if (customDisplay && !customDisplay.closest('.centered-select-overlay')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            openCustomDropdown(customDisplay);
            return;
        }
        const select = selectableFromEvent(event);
        if (!select) return;
        event.preventDefault();
        if (activeSelect !== select) openModal(select);
    }, true);

    document.addEventListener('keydown', event => {
        if (overlay && !overlay.hidden) {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeModal();
            } else if (event.key === 'Tab') {
                const focusable = Array.from(overlay.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden])'))
                    .filter(element => element.offsetParent !== null);
                if (focusable.length) {
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    }
                }
            }
            return;
        }
        const select = selectableFromEvent(event);
        if (!select || !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        openModal(select);
    }, true);

    window.openCenteredSelect = openModal;
})();
