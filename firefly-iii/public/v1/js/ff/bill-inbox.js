/**
 * bill-inbox.js
 * Progressive-enhancement helpers for the bill inbox task detail page (审阅体验第二期).
 *
 * Plain vanilla JS, no dependencies. Every interception degrades to a normal
 * full-page form submission if fetch() fails, the API returns a non-2xx status,
 * or this script errors out during initialisation.
 */
(function () {
    'use strict';

    var config = window.billInboxConfig || {};
    config.statusLabels = config.statusLabels || {};
    config.statusClasses = config.statusClasses || {};
    config.fireflyTypeLabels = config.fireflyTypeLabels || {};

    var DRAFT_FIELDS = [
        'firefly_type',
        'firefly_date',
        'firefly_amount',
        'source_name',
        'destination_name',
        'category_name',
        'firefly_description',
        'notes'
    ];

    function csrfToken() {
        var meta = document.querySelector('meta[name="csrf-token"]');

        return meta ? meta.getAttribute('content') : '';
    }

    function apiUrl(path) {
        var baseTag = document.getElementsByTagName('base')[0];
        var base    = baseTag && baseTag.href ? baseTag.href : (window.location.origin + '/');
        if (0 === base.indexOf('/')) {
            base = window.location.origin + base;
        }

        return base + path;
    }

    /**
     * Fetch wrapper: same-origin credentials, CSRF + Accept headers, JSON body support.
     * Rejects with an Error carrying `.status` and `.payload` (parsed JSON body, if any)
     * whenever the response is not ok, so callers can branch on 422 vs other failures.
     */
    function apiFetch(url, options) {
        options = options || {};
        var headers = {
            'Accept': 'application/json',
            'X-CSRF-TOKEN': csrfToken()
        };
        if (undefined !== options.body) {
            headers['Content-Type'] = 'application/json';
        }
        if (options.headers) {
            for (var key in options.headers) {
                if (Object.prototype.hasOwnProperty.call(options.headers, key)) {
                    headers[key] = options.headers[key];
                }
            }
        }

        return fetch(url, {
            method: options.method || 'GET',
            credentials: 'same-origin',
            headers: headers,
            body: options.body
        }).then(function (response) {
            return response.text().then(function (text) {
                var data = {};
                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch (parseError) {
                        data = {};
                    }
                }
                if (!response.ok) {
                    var error = new Error(data && data.message ? data.message : ('请求失败（' + response.status + '）'));
                    error.status  = response.status;
                    error.payload = data;
                    throw error;
                }

                return data;
            });
        });
    }

    function flashAlert(message, type) {
        var box = document.getElementById('bill-row-ajax-alert');
        if (!box) {
            return;
        }
        var alertClass = 'alert-success';
        if ('danger' === type) {
            alertClass = 'alert-danger';
        } else if ('warning' === type) {
            alertClass = 'alert-warning';
        }
        box.className   = 'alert ' + alertClass;
        box.textContent = message;
        box.style.display = 'block';

        if (box.hideTimer) {
            window.clearTimeout(box.hideTimer);
        }
        box.hideTimer = window.setTimeout(function () {
            box.style.display = 'none';
        }, 5000);
    }

    function summaryRowFor(rowId) {
        return document.querySelector('tr[data-row-id="' + rowId + '"][data-role="summary"]');
    }

    function setDisplay(summaryRow, field, text) {
        var el = summaryRow.querySelector('[data-field-display="' + field + '"]');
        if (el) {
            el.textContent = text;
        }
    }

    function fireflyTypeLabel(type) {
        if (!type) {
            return '-';
        }

        return config.fireflyTypeLabels[type] || type;
    }

    function setStatusBadge(summaryRow, status) {
        var el = summaryRow.querySelector('[data-field-display="status-badge"]');
        if (!el) {
            return;
        }
        el.textContent = config.statusLabels[status] || status;
        el.className   = 'label ' + (config.statusClasses[status] || 'label-info');
    }

    function setDuplicateBadges(summaryRow, duplicateState) {
        var duplicateEl = summaryRow.querySelector('[data-field-display="duplicate-badge"]');
        var conflictEl  = summaryRow.querySelector('[data-field-display="conflict-badge"]');
        if (duplicateEl) {
            duplicateEl.style.display = 'duplicate' === duplicateState ? '' : 'none';
        }
        if (conflictEl) {
            conflictEl.style.display = 'conflict' === duplicateState ? '' : 'none';
        }
    }

    function applyRowUpdate(rowId, resource) {
        if (!resource || !resource.attributes) {
            return;
        }
        var attrs      = resource.attributes;
        var summaryRow = summaryRowFor(rowId);
        if (!summaryRow) {
            return;
        }

        var amountText = (null === attrs.firefly_amount || undefined === attrs.firefly_amount || '' === attrs.firefly_amount) ? '-' : attrs.firefly_amount;

        setDisplay(summaryRow, 'firefly_description', attrs.firefly_description || '-');
        setDisplay(summaryRow, 'source_name_line', '来源：' + (attrs.source_name || '-'));
        setDisplay(summaryRow, 'destination_name_line', '目标：' + (attrs.destination_name || '-'));
        setDisplay(summaryRow, 'category_name_line', '分类：' + (attrs.category_name || '-'));
        setDisplay(summaryRow, 'firefly_description_line', '描述：' + (attrs.firefly_description || '-'));
        setDisplay(summaryRow, 'firefly_type_line', '类型：' + fireflyTypeLabel(attrs.firefly_type));
        setDisplay(summaryRow, 'firefly_amount_line', '/ 金额：' + amountText);
        setStatusBadge(summaryRow, attrs.status);
        setDuplicateBadges(summaryRow, attrs.duplicate_state);
    }

    function collapseRow(rowId) {
        var collapseEl = document.getElementById('bill-row-' + rowId);
        if (!collapseEl) {
            return;
        }
        if (window.jQuery) {
            try {
                window.jQuery(collapseEl).collapse('hide');

                return;
            } catch (jqError) {
                // fall through to manual toggling below.
            }
        }
        collapseEl.className = collapseEl.className.replace(/\bin\b/, '').trim();
    }

    function clearFieldErrors(form) {
        var nodes = form.querySelectorAll('[data-error-for]');
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].textContent = '';
        }
    }

    function renderFieldErrors(form, errors) {
        for (var field in errors) {
            if (!Object.prototype.hasOwnProperty.call(errors, field)) {
                continue;
            }
            var el = form.querySelector('[data-error-for="' + field + '"]');
            if (el) {
                var messages = errors[field];
                el.textContent = Array.isArray(messages) ? messages.join('; ') : String(messages);
            }
        }
    }

    function collectDraftPayload(form) {
        var payload = {};
        DRAFT_FIELDS.forEach(function (field) {
            var input = form.querySelector('[data-field="' + field + '"]');
            if (!input) {
                return;
            }
            var value = input.value;
            if ('firefly_date' === field && value) {
                value = value.replace('T', ' ');
                if (16 === value.length) {
                    value += ':00';
                }
            }
            payload[field] = '' === value ? null : value;
        });

        return payload;
    }

    function showSaveFeedback(form, message) {
        var feedback = form.querySelector('.bill-row-save-feedback');
        if (!feedback) {
            return;
        }
        feedback.textContent   = message;
        feedback.style.display = 'inline';
        window.setTimeout(function () {
            feedback.style.display = 'none';
        }, 4000);
    }

    function initRowUpdateForms() {
        var forms = document.querySelectorAll('.bill-row-update-form');
        forms.forEach(function (form) {
            var rowId = form.getAttribute('data-row-id');
            if (!rowId) {
                return;
            }

            form.addEventListener('submit', function (event) {
                event.preventDefault();
                clearFieldErrors(form);

                var submitBtn = form.querySelector('button[type="submit"]');
                if (submitBtn) {
                    submitBtn.disabled = true;
                }

                apiFetch(apiUrl('api/v1/bill-statement-rows/' + encodeURIComponent(rowId)), {
                    method: 'PATCH',
                    body: JSON.stringify(collectDraftPayload(form))
                }).then(function (json) {
                    applyRowUpdate(rowId, json.data);
                    showSaveFeedback(form, '已保存');
                    collapseRow(rowId);
                    flashAlert('第 ' + rowId + ' 行流水草稿已保存。', 'success');
                }).catch(function (error) {
                    if (422 === error.status && error.payload && error.payload.errors) {
                        renderFieldErrors(form, error.payload.errors);
                        flashAlert('保存失败：请检查标红的字段。', 'danger');
                    } else {
                        flashAlert('保存失败：' + error.message + '。可以再次点击“保存”重试，或整页提交表单。', 'danger');
                    }
                }).then(function () {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                    }
                }, function () {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                    }
                });
            });
        });
    }

    function accountAutocompleteUrl(query) {
        return apiUrl('api/v1/autocomplete/accounts')
            + '?types=' + encodeURIComponent('asset,expense,revenue')
            + '&query=' + encodeURIComponent(query)
            + '&limit=15';
    }

    function categoryAutocompleteUrl(query) {
        return apiUrl('api/v1/autocomplete/categories')
            + '?query=' + encodeURIComponent(query)
            + '&limit=15';
    }

    function initAutocomplete() {
        var wrappers = document.querySelectorAll('.bill-autocomplete');
        wrappers.forEach(function (wrapper) {
            var input = wrapper.querySelector('input');
            var menu  = wrapper.querySelector('.bill-autocomplete-menu');
            if (!input || !menu) {
                return;
            }
            var type          = wrapper.getAttribute('data-autocomplete-type');
            var debounceTimer = null;
            var items         = [];
            var activeIndex   = -1;

            function hideMenu() {
                menu.style.display = 'none';
                activeIndex         = -1;
            }

            function showMenu() {
                menu.style.display = 'block';
            }

            function highlight(index) {
                var children = menu.children;
                for (var i = 0; i < children.length; i++) {
                    children[i].className = i === index ? 'active' : '';
                }
                activeIndex = index;
            }

            function selectItem(index) {
                var item = items[index];
                if (!item) {
                    return;
                }
                input.value = item.name;
                hideMenu();
            }

            function renderItems(list) {
                items = list;
                menu.innerHTML = '';
                activeIndex     = -1;
                if (0 === list.length) {
                    hideMenu();

                    return;
                }
                list.forEach(function (item, index) {
                    var li = document.createElement('li');
                    li.textContent = item.name;
                    li.addEventListener('mousedown', function (event) {
                        event.preventDefault();
                        selectItem(index);
                    });
                    menu.appendChild(li);
                });
                showMenu();
            }

            function fetchSuggestions(query) {
                var url = 'category' === type ? categoryAutocompleteUrl(query) : accountAutocompleteUrl(query);
                apiFetch(url).then(function (list) {
                    renderItems(Array.isArray(list) ? list : []);
                }).catch(function () {
                    hideMenu();
                });
            }

            input.addEventListener('input', function () {
                var value = input.value.trim();
                if (debounceTimer) {
                    window.clearTimeout(debounceTimer);
                }
                if ('' === value) {
                    hideMenu();

                    return;
                }
                debounceTimer = window.setTimeout(function () {
                    fetchSuggestions(value);
                }, 250);
            });

            input.addEventListener('keydown', function (event) {
                if ('ArrowDown' === event.key) {
                    if (items.length > 0) {
                        event.preventDefault();
                        highlight(Math.min(items.length - 1, activeIndex + 1));
                    }
                } else if ('ArrowUp' === event.key) {
                    if (items.length > 0) {
                        event.preventDefault();
                        highlight(Math.max(0, activeIndex - 1));
                    }
                } else if ('Enter' === event.key) {
                    if (activeIndex >= 0) {
                        event.preventDefault();
                        selectItem(activeIndex);
                    }
                } else if ('Escape' === event.key) {
                    hideMenu();
                }
            });

            input.addEventListener('blur', function () {
                window.setTimeout(hideMenu, 150);
            });
        });
    }

    function rowCheckboxes() {
        return Array.prototype.slice.call(document.querySelectorAll('.bill-row-checkbox'));
    }

    function importRows(ids) {
        return apiFetch(apiUrl('api/v1/bill-tasks/' + config.taskId + '/import'), {
            method: 'POST',
            body: JSON.stringify({
                row_ids: ids.map(function (id) {
                    return parseInt(id, 10);
                }),
                confirm: true
            })
        });
    }

    function markRowImported(rowId) {
        var summaryRow = summaryRowFor(rowId);
        if (!summaryRow) {
            return;
        }
        setStatusBadge(summaryRow, 'imported');
        setDuplicateBadges(summaryRow, 'unique');

        var checkbox = summaryRow.querySelector('.bill-row-checkbox');
        if (checkbox && checkbox.parentNode) {
            checkbox.parentNode.removeChild(checkbox);
        }
        var importForm = summaryRow.querySelector('.bill-row-import-form');
        if (importForm && importForm.parentNode) {
            importForm.parentNode.removeChild(importForm);
        }
    }

    function applyImportResult(result) {
        var summary = result.summary || {};
        var reports  = result.rows || [];
        reports.forEach(function (report) {
            if (report && 'imported' === report.status && report.row_id) {
                markRowImported(report.row_id);
            }
        });

        var failed = summary.failed || 0;
        flashAlert(
            '存入完成：成功 ' + (summary.imported || 0) + ' 条，跳过 ' + (summary.skipped || 0) + ' 条，失败 ' + failed + ' 条。',
            failed > 0 ? 'warning' : 'success'
        );
    }

    function initBatchImport() {
        var form        = document.getElementById('bill-row-batch-import');
        var selectAll   = document.getElementById('bill-row-select-all');
        var submitBtn   = document.getElementById('bill-row-batch-import-submit');
        var countLabel  = document.getElementById('bill-row-batch-import-count');
        if (!form) {
            return;
        }

        function updateCount() {
            var checked = rowCheckboxes().filter(function (checkbox) {
                return checkbox.checked;
            });
            if (countLabel) {
                countLabel.textContent = String(checked.length);
            }
            if (submitBtn) {
                submitBtn.disabled = 0 === checked.length;
            }

            return checked;
        }

        rowCheckboxes().forEach(function (checkbox) {
            checkbox.addEventListener('change', updateCount);
        });

        if (selectAll) {
            selectAll.addEventListener('change', function () {
                rowCheckboxes().forEach(function (checkbox) {
                    checkbox.checked = selectAll.checked;
                });
                updateCount();
            });
        }

        form.addEventListener('submit', function (event) {
            var checked = updateCount();
            if (0 === checked.length) {
                event.preventDefault();
                window.alert('请先勾选需要存入的流水。');

                return;
            }
            if (!window.confirm('确认存入选中的 ' + checked.length + ' 条流水？')) {
                event.preventDefault();

                return;
            }
            // From here on we take over: AJAX-submit, falling back to a plain
            // page reload message on failure rather than a native re-submit
            // (to avoid double-importing rows that already succeeded).
            event.preventDefault();

            var ids = checked.map(function (checkbox) {
                return checkbox.value;
            });
            if (submitBtn) {
                submitBtn.disabled = true;
            }

            importRows(ids).then(function (result) {
                applyImportResult(result);
            }).catch(function (error) {
                flashAlert('批量存入失败：' + error.message + '。请刷新页面重试，或使用整页提交。', 'danger');
            }).then(function () {
                updateCount();
            }, function () {
                updateCount();
            });
        });

        updateCount();
    }

    function initSingleImportForms() {
        var forms = document.querySelectorAll('.bill-row-import-form');
        forms.forEach(function (form) {
            var rowId = form.getAttribute('data-row-id');
            if (!rowId) {
                return;
            }

            form.addEventListener('submit', function (event) {
                event.preventDefault();
                var button = form.querySelector('button[type="submit"]');
                if (button) {
                    button.disabled = true;
                }

                importRows([rowId]).then(function (result) {
                    applyImportResult(result);
                    // the form is removed when the row was imported; if it is still
                    // around (row skipped/failed) the user must be able to retry.
                    if (button && document.body.contains(button)) {
                        button.disabled = false;
                    }
                }).catch(function (error) {
                    flashAlert('存入失败：' + error.message + '。可以再次点击“存入”重试，或整页提交。', 'danger');
                    if (button) {
                        button.disabled = false;
                    }
                });
            });
        });
    }

    function safeInit(fn, label) {
        try {
            fn();
        } catch (error) {
            if (window.console && window.console.error) {
                window.console.error('bill-inbox.js: failed to initialise ' + label, error);
            }
        }
    }

    function boot() {
        safeInit(initRowUpdateForms, 'row-update-forms');
        safeInit(initAutocomplete, 'autocomplete');
        safeInit(initBatchImport, 'batch-import');
        safeInit(initSingleImportForms, 'single-import-forms');
    }

    if ('loading' === document.readyState) {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
