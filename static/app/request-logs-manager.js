import { t } from './i18n.js';
import { apiClient, authManager } from './auth.js';
import { escapeHtml, showToast } from './utils.js';

const state = {
    initialized: false,
    entries: new Map(),
    debounceTimer: null
};

function escapeSelector(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return String(value).replace(/\"/g, '\\\"');
}

function getElements() {
    return {
        body: document.getElementById('requestLogsBody'),
        empty: document.getElementById('requestLogsEmpty'),
        statusFilter: document.getElementById('requestLogStatusFilter'),
        providerFilter: document.getElementById('requestLogProviderFilter'),
        accountFilter: document.getElementById('requestLogAccountFilter'),
        searchFilter: document.getElementById('requestLogSearchFilter'),
        dateFrom: document.getElementById('requestLogDateFrom'),
        dateTo: document.getElementById('requestLogDateTo'),
        refreshBtn: document.getElementById('refreshRequestLogs'),
        downloadCsvBtn: document.getElementById('downloadRequestLogsCsv'),
        downloadJsonBtn: document.getElementById('downloadRequestLogsJson'),
        statTotal: document.getElementById('requestStatTotal'),
        statSuccess: document.getElementById('requestStatSuccess'),
        statFailed: document.getElementById('requestStatFailed'),
        statRetry: document.getElementById('requestStatRetry'),
        statAvgDuration: document.getElementById('requestStatAvgDuration'),
        statTotalTokens: document.getElementById('requestStatTotalTokens')
    };
}

function parseDateInput(value) {
    if (!value) return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDateTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString();
}

function formatDuration(ms) {
    if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '--';
    const duration = Number(ms);
    if (duration < 1000) return `${duration}ms`;
    return `${(duration / 1000).toFixed(2)}s`;
}

function formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
    return Number(value).toLocaleString();
}

function getStatusText(status) {
    if (status === 'success') return t('logs.request.status.success');
    if (status === 'error') return t('logs.request.status.error');
    if (status === 'running') return t('logs.request.status.running');
    return status || '--';
}

function getFilters() {
    const els = getElements();
    return {
        status: els.statusFilter?.value || 'all',
        provider: (els.providerFilter?.value || '').trim(),
        account: (els.accountFilter?.value || '').trim(),
        q: (els.searchFilter?.value || '').trim(),
        dateFrom: parseDateInput(els.dateFrom?.value || ''),
        dateTo: parseDateInput(els.dateTo?.value || '')
    };
}

function toQueryParams(filters, withPaging = true) {
    const params = new URLSearchParams();

    if (withPaging) {
        params.set('limit', '500');
        params.set('offset', '0');
    }

    if (filters.status && filters.status !== 'all') {
        params.set('status', filters.status);
    }
    if (filters.provider) {
        params.set('provider', filters.provider);
    }
    if (filters.account) {
        params.set('account', filters.account);
    }
    if (filters.q) {
        params.set('q', filters.q);
    }
    if (filters.dateFrom) {
        params.set('dateFrom', new Date(filters.dateFrom).toISOString());
    }
    if (filters.dateTo) {
        params.set('dateTo', new Date(filters.dateTo).toISOString());
    }

    return params;
}

function matchEntry(entry, filters) {
    if (!entry) return false;

    if (filters.status && filters.status !== 'all' && entry.status !== filters.status) {
        return false;
    }

    if (filters.provider) {
        const providerKeyword = filters.provider.toLowerCase();
        const providerText = `${entry.providerActual || ''} ${entry.providerRequested || ''}`.toLowerCase();
        if (!providerText.includes(providerKeyword)) return false;
    }

    if (filters.account) {
        const accountKeyword = filters.account.toLowerCase();
        const accountText = `${entry.accountLabel || ''} ${entry.accountUuid || ''}`.toLowerCase();
        if (!accountText.includes(accountKeyword)) return false;
    }

    if (filters.q) {
        const keyword = filters.q.toLowerCase();
        const haystack = [
            entry.id,
            entry.requestId,
            entry.path,
            entry.modelRequested,
            entry.modelActual,
            entry.errorMessage,
            entry.accountLabel,
            entry.providerActual
        ].map(v => String(v || '').toLowerCase()).join(' ');

        if (!haystack.includes(keyword)) return false;
    }

    const startedAt = new Date(entry.startedAt).getTime();
    if (filters.dateFrom && Number.isFinite(startedAt) && startedAt < filters.dateFrom) {
        return false;
    }
    if (filters.dateTo && Number.isFinite(startedAt) && startedAt > filters.dateTo) {
        return false;
    }

    return true;
}

function sortedEntries() {
    return [...state.entries.values()].sort((a, b) => {
        const at = new Date(a.startedAt).getTime() || 0;
        const bt = new Date(b.startedAt).getTime() || 0;
        return bt - at;
    });
}

function trimState(max = 2500) {
    const entries = sortedEntries();
    if (entries.length <= max) return;

    for (let i = max; i < entries.length; i++) {
        state.entries.delete(entries[i].id);
    }
}

function renderStats(entries) {
    const els = getElements();
    if (!els.statTotal) return;

    const total = entries.length;
    const success = entries.filter(item => item.status === 'success').length;
    const failed = entries.filter(item => item.status === 'error').length;
    const retry = entries.filter(item => Number(item.retryCount || 0) > 0 || (item.attempts || []).length > 1).length;

    const completed = entries.filter(item => item.durationMs !== null && item.durationMs !== undefined);
    const avgDuration = completed.length > 0
        ? Math.round(completed.reduce((sum, item) => sum + Number(item.durationMs || 0), 0) / completed.length)
        : null;

    const totalTokens = entries.reduce((sum, item) => {
        const tokens = Number(item.tokens?.total);
        return Number.isFinite(tokens) ? sum + tokens : sum;
    }, 0);

    els.statTotal.textContent = formatNumber(total);
    els.statSuccess.textContent = formatNumber(success);
    els.statFailed.textContent = formatNumber(failed);
    els.statRetry.textContent = formatNumber(retry);
    els.statAvgDuration.textContent = avgDuration === null ? '--' : formatDuration(avgDuration);
    els.statTotalTokens.textContent = totalTokens > 0 ? formatNumber(totalTokens) : '--';
}

function renderAttempts(entry) {
    const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
    if (attempts.length === 0) {
        return `<div class="request-log-detail-line">${escapeHtml(t('logs.request.detail.noAttempts'))}</div>`;
    }

    const rows = attempts.map((attempt) => {
        return `
            <tr>
                <td>${escapeHtml(String(attempt.attemptNo ?? '--'))}</td>
                <td>${escapeHtml(attempt.accountLabel || attempt.accountUuid || '--')}</td>
                <td>${escapeHtml(attempt.provider || '--')}</td>
                <td>${escapeHtml(getStatusText(attempt.status))}</td>
                <td>${escapeHtml(formatDateTime(attempt.startedAt))}</td>
                <td>${escapeHtml(formatDateTime(attempt.endedAt))}</td>
                <td>${escapeHtml(formatDuration(attempt.durationMs))}</td>
                <td>${escapeHtml(attempt.errorMessage || '--')}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="request-log-attempts">
            <table>
                <thead>
                    <tr>
                        <th>${escapeHtml(t('logs.request.detail.attemptNo'))}</th>
                        <th>${escapeHtml(t('logs.request.table.account'))}</th>
                        <th>${escapeHtml(t('logs.request.table.provider'))}</th>
                        <th>${escapeHtml(t('logs.request.table.status'))}</th>
                        <th>${escapeHtml(t('logs.request.detail.startedAt'))}</th>
                        <th>${escapeHtml(t('logs.request.detail.endedAt'))}</th>
                        <th>${escapeHtml(t('logs.request.table.duration'))}</th>
                        <th>${escapeHtml(t('logs.request.detail.error'))}</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function detailHtml(entry) {
    const tokenText = `${formatNumber(entry.tokens?.input)} / ${formatNumber(entry.tokens?.output)} / ${formatNumber(entry.tokens?.total)}`;

    return `
        <div class="request-log-detail">
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.requestId'))}:</strong> ${escapeHtml(entry.requestId || '--')}</div>
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.path'))}:</strong> ${escapeHtml(entry.path || '--')}</div>
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.clientIp'))}:</strong> ${escapeHtml(entry.clientIp || '--')}</div>
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.modelRequested'))}:</strong> ${escapeHtml(entry.modelRequested || '--')}</div>
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.modelActual'))}:</strong> ${escapeHtml(entry.modelActual || '--')}</div>
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.upstreamStatus'))}:</strong> ${escapeHtml(String(entry.upstreamStatus ?? '--'))}</div>
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.tokens'))}:</strong> ${escapeHtml(tokenText)}</div>
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.bytes'))}:</strong> ${escapeHtml(`${formatNumber(entry.bytes?.request)} / ${formatNumber(entry.bytes?.response)}`)}</div>
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.fallback'))}:</strong> ${entry.isFallback ? escapeHtml(t('logs.request.detail.yes')) : escapeHtml(t('logs.request.detail.no'))}</div>
            <div class="request-log-detail-line"><strong>${escapeHtml(t('logs.request.detail.error'))}:</strong> ${escapeHtml(entry.errorMessage || '--')}</div>
        </div>
        ${renderAttempts(entry)}
    `;
}

function renderTable(entries) {
    const els = getElements();
    if (!els.body) return;

    if (entries.length === 0) {
        els.body.innerHTML = '';
        if (els.empty) {
            els.empty.style.display = 'block';
        }
        return;
    }

    if (els.empty) {
        els.empty.style.display = 'none';
    }

    const rows = entries.map((entry) => {
        const statusClass = entry.status || 'running';
        const tokensText = `${formatNumber(entry.tokens?.input)} / ${formatNumber(entry.tokens?.output)} / ${formatNumber(entry.tokens?.total)}`;
        const detail = detailHtml(entry);

        return `
            <tr class="request-log-main-row" data-id="${escapeHtml(entry.id)}">
                <td><button class="request-detail-toggle" data-id="${escapeHtml(entry.id)}">+</button></td>
                <td><span class="request-log-status ${escapeHtml(statusClass)}">${escapeHtml(getStatusText(entry.status))}</span></td>
                <td>${escapeHtml(entry.accountLabel || '--')}</td>
                <td>${escapeHtml(entry.providerActual || entry.providerRequested || '--')}</td>
                <td>${escapeHtml(entry.modelActual || entry.modelRequested || '--')}</td>
                <td>${escapeHtml(formatDateTime(entry.startedAt))}</td>
                <td>${escapeHtml(formatDateTime(entry.endedAt))}</td>
                <td>${escapeHtml(formatDuration(entry.durationMs))}</td>
                <td>${escapeHtml(tokensText)}</td>
                <td>${escapeHtml(String(entry.retryCount ?? 0))}</td>
            </tr>
            <tr class="request-log-detail-row" data-detail-id="${escapeHtml(entry.id)}" style="display:none;">
                <td colspan="10">${detail}</td>
            </tr>
        `;
    }).join('');

    els.body.innerHTML = rows;
}

function renderRequestLogs() {
    const filters = getFilters();
    const filtered = sortedEntries().filter(entry => matchEntry(entry, filters));
    renderStats(filtered);
    renderTable(filtered);
}

function scheduleReload(delay = 300) {
    if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = setTimeout(() => {
        loadRequestLogs();
    }, delay);
}

async function downloadRequestLogs(format = 'csv') {
    try {
        const token = authManager.getToken();
        if (!token) {
            showToast(t('common.error'), t('logs.request.downloadFailed'), 'error');
            return;
        }

        const filters = getFilters();
        const params = toQueryParams(filters, false);
        params.set('format', format);

        const response = await fetch(`/api/request-logs/export?${params.toString()}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');

        const disposition = response.headers.get('Content-Disposition') || '';
        const matched = disposition.match(/filename="?([^\"]+)"?/i);
        const filename = matched ? matched[1] : `request-logs.${format}`;

        link.href = downloadUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(downloadUrl);
    } catch (error) {
        showToast(t('common.error'), `${t('logs.request.downloadFailed')}: ${error.message}`, 'error');
    }
}

async function loadRequestLogs() {
    try {
        const filters = getFilters();
        const params = toQueryParams(filters, true);
        const result = await apiClient.get('/request-logs', Object.fromEntries(params));

        if (!result || !result.success || !Array.isArray(result.data)) {
            throw new Error('Invalid response');
        }

        state.entries.clear();
        for (const entry of result.data) {
            if (entry && entry.id) {
                state.entries.set(entry.id, entry);
            }
        }

        trimState();
        renderRequestLogs();
    } catch (error) {
        console.error('Failed to load request logs:', error);
        showToast(t('common.error'), `${t('logs.request.loadFailed')}: ${error.message}`, 'error');
    }
}

function handleBodyClick(event) {
    const button = event.target.closest('.request-detail-toggle');
    if (!button) return;

    const id = button.getAttribute('data-id');
    if (!id) return;

    const detailRow = document.querySelector(`.request-log-detail-row[data-detail-id="${escapeSelector(id)}"]`);
    if (!detailRow) return;

    const isHidden = detailRow.style.display === 'none';
    detailRow.style.display = isHidden ? 'table-row' : 'none';
    button.textContent = isHidden ? '-' : '+';
}

function bindEvents() {
    const els = getElements();
    if (!els.body) return;

    els.body.addEventListener('click', handleBodyClick);
    els.statusFilter?.addEventListener('change', () => loadRequestLogs());
    els.providerFilter?.addEventListener('input', () => scheduleReload());
    els.accountFilter?.addEventListener('input', () => scheduleReload());
    els.searchFilter?.addEventListener('input', () => scheduleReload());
    els.dateFrom?.addEventListener('change', () => loadRequestLogs());
    els.dateTo?.addEventListener('change', () => loadRequestLogs());

    els.refreshBtn?.addEventListener('click', () => loadRequestLogs());
    els.downloadCsvBtn?.addEventListener('click', () => downloadRequestLogs('csv'));
    els.downloadJsonBtn?.addEventListener('click', () => downloadRequestLogs('json'));
}

export function upsertRequestLogEntry(entry) {
    if (!entry || !entry.id) return;

    state.entries.set(entry.id, entry);
    trimState();
    renderRequestLogs();
}

export function initRequestLogsManager() {
    if (state.initialized) return;
    const els = getElements();
    if (!els.body) return;

    bindEvents();
    state.initialized = true;
    loadRequestLogs();
}

export { loadRequestLogs };
