import path from 'path';
import { broadcastEvent } from './event-broadcast.js';

const DEFAULT_MAX_ENTRIES = 2000;

const PROVIDER_CRED_PATH_KEYS = {
    'claude-kiro-oauth': 'KIRO_OAUTH_CREDS_FILE_PATH',
    'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
    'openai-qwen-oauth': 'QWEN_OAUTH_CREDS_FILE_PATH',
    'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
    'openai-iflow': 'IFLOW_TOKEN_FILE_PATH',
    'openai-codex-oauth': 'CODEX_OAUTH_CREDS_FILE_PATH'
};

function safeNumber(value) {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function nowIso() {
    return new Date().toISOString();
}

function createTokenUsage() {
    return {
        input: null,
        output: null,
        total: null,
        cached: null,
        reasoning: null
    };
}

function createByteUsage() {
    return {
        request: null,
        response: null
    };
}

function cloneEntry(entry) {
    return JSON.parse(JSON.stringify(entry));
}

function pickFirst(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null) {
            return value;
        }
    }
    return null;
}

export function deriveAccountLabel(providerType, serviceConfig, customName, uuid) {
    if (customName && String(customName).trim()) {
        return String(customName).trim();
    }

    const credKey = PROVIDER_CRED_PATH_KEYS[providerType];
    if (credKey && serviceConfig && serviceConfig[credKey]) {
        const filePath = String(serviceConfig[credKey]);
        const base = path.basename(filePath);
        if (base && base !== '.' && base !== path.sep) {
            return base;
        }
    }

    if (uuid) {
        return String(uuid);
    }

    return '--';
}

function normalizeTokenUsage(rawUsage = {}) {
    const input = safeNumber(pickFirst(
        rawUsage.input,
        rawUsage.input_tokens,
        rawUsage.prompt_tokens,
        rawUsage.promptTokenCount,
        rawUsage.prompt
    ));

    const output = safeNumber(pickFirst(
        rawUsage.output,
        rawUsage.output_tokens,
        rawUsage.completion_tokens,
        rawUsage.candidatesTokenCount,
        rawUsage.completion
    ));

    const total = safeNumber(pickFirst(
        rawUsage.total,
        rawUsage.total_tokens,
        rawUsage.totalTokenCount
    ));

    const cached = safeNumber(pickFirst(
        rawUsage.cached,
        rawUsage.cached_tokens,
        rawUsage.cachedContentTokenCount,
        rawUsage.prompt_tokens_details?.cached_tokens,
        rawUsage.input_tokens_details?.cached_tokens,
        rawUsage.cache_read_input_tokens
    ));

    const reasoning = safeNumber(pickFirst(
        rawUsage.reasoning,
        rawUsage.reasoning_tokens,
        rawUsage.output_tokens_details?.reasoning_tokens,
        rawUsage.thoughtsTokenCount
    ));

    const mergedTotal = total !== null ? total : (input !== null && output !== null ? input + output : null);

    if (
        input === null &&
        output === null &&
        mergedTotal === null &&
        cached === null &&
        reasoning === null
    ) {
        return null;
    }

    return {
        input,
        output,
        total: mergedTotal,
        cached,
        reasoning
    };
}

function collectTokenCandidates(payload) {
    if (!payload || typeof payload !== 'object') {
        return [];
    }

    const candidates = [];
    const visited = new Set();
    const queue = [payload];

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') continue;
        if (visited.has(current)) continue;
        visited.add(current);

        if (current.usage && typeof current.usage === 'object') {
            candidates.push(current.usage);
        }

        if (current.usageMetadata && typeof current.usageMetadata === 'object') {
            candidates.push(current.usageMetadata);
        }

        if (Array.isArray(current)) {
            for (const item of current) {
                if (item && typeof item === 'object') queue.push(item);
            }
            continue;
        }

        for (const value of Object.values(current)) {
            if (value && typeof value === 'object') {
                queue.push(value);
            }
        }
    }

    return candidates;
}

export function extractTokenUsage(payload) {
    const candidates = collectTokenCandidates(payload);
    let merged = createTokenUsage();
    let hasAny = false;

    for (const candidate of candidates) {
        const normalized = normalizeTokenUsage(candidate);
        if (!normalized) continue;

        hasAny = true;
        merged.input = normalized.input !== null ? Math.max(merged.input ?? 0, normalized.input) : merged.input;
        merged.output = normalized.output !== null ? Math.max(merged.output ?? 0, normalized.output) : merged.output;
        merged.total = normalized.total !== null ? Math.max(merged.total ?? 0, normalized.total) : merged.total;
        merged.cached = normalized.cached !== null ? Math.max(merged.cached ?? 0, normalized.cached) : merged.cached;
        merged.reasoning = normalized.reasoning !== null ? Math.max(merged.reasoning ?? 0, normalized.reasoning) : merged.reasoning;
    }

    if (!hasAny) return null;

    if (merged.total === null && merged.input !== null && merged.output !== null) {
        merged.total = merged.input + merged.output;
    }

    return merged;
}

function mergeTokenUsage(existing, incoming) {
    if (!incoming) {
        return { changed: false, value: existing };
    }

    let changed = false;
    const merged = { ...existing };

    for (const key of ['input', 'output', 'total', 'cached', 'reasoning']) {
        const nextValue = incoming[key];
        if (nextValue === null || nextValue === undefined) continue;

        const currentValue = merged[key];
        const computed = currentValue === null || currentValue === undefined
            ? nextValue
            : Math.max(currentValue, nextValue);

        if (computed !== currentValue) {
            merged[key] = computed;
            changed = true;
        }
    }

    if ((merged.total === null || merged.total === undefined) && merged.input !== null && merged.output !== null) {
        merged.total = merged.input + merged.output;
        changed = true;
    }

    return { changed, value: merged };
}

class RequestLogStore {
    constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
        this.maxEntries = maxEntries;
        this.entries = [];
        this.indexById = new Map();
    }

    _emit(entry) {
        broadcastEvent('request_log', {
            op: 'upsert',
            entry: cloneEntry(entry)
        });
    }

    _pruneIfNeeded() {
        while (this.entries.length > this.maxEntries) {
            const removed = this.entries.shift();
            if (removed) {
                this.indexById.delete(removed.id);
            }
        }

        for (let i = 0; i < this.entries.length; i++) {
            this.indexById.set(this.entries[i].id, i);
        }
    }

    _applyPatch(entry, patch = {}) {
        const next = { ...entry, ...patch };

        if (patch.tokens) {
            next.tokens = { ...entry.tokens, ...patch.tokens };
        }

        if (patch.bytes) {
            next.bytes = { ...entry.bytes, ...patch.bytes };
        }

        if (patch.attempts) {
            next.attempts = patch.attempts;
        }

        next.updatedAt = nowIso();
        if (next.endedAt && !next.durationMs) {
            const started = new Date(next.startedAt).getTime();
            const ended = new Date(next.endedAt).getTime();
            if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
                next.durationMs = ended - started;
            }
        }

        return next;
    }

    create(entry) {
        const id = entry.id || `reqlog_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const timestamp = nowIso();

        const normalized = {
            id,
            requestId: entry.requestId || '--',
            monitorRequestId: entry.monitorRequestId || null,
            startedAt: entry.startedAt || timestamp,
            endedAt: entry.endedAt || null,
            durationMs: entry.durationMs || null,
            updatedAt: timestamp,
            method: entry.method || '--',
            path: entry.path || '--',
            endpointType: entry.endpointType || '--',
            clientProtocol: entry.clientProtocol || '--',
            stream: Boolean(entry.stream),
            clientIp: entry.clientIp || '--',
            modelRequested: entry.modelRequested || '--',
            modelActual: entry.modelActual || entry.modelRequested || '--',
            providerRequested: entry.providerRequested || '--',
            providerActual: entry.providerActual || entry.providerRequested || '--',
            accountUuid: entry.accountUuid || null,
            accountLabel: entry.accountLabel || '--',
            isFallback: Boolean(entry.isFallback),
            retryCount: safeNumber(entry.retryCount) || 0,
            status: entry.status || 'running',
            upstreamStatus: safeNumber(entry.upstreamStatus),
            errorCode: entry.errorCode || null,
            errorMessage: entry.errorMessage || null,
            tokens: createTokenUsage(),
            bytes: createByteUsage(),
            attempts: Array.isArray(entry.attempts) ? entry.attempts : []
        };

        if (entry.tokens) {
            normalized.tokens = { ...normalized.tokens, ...entry.tokens };
        }

        if (entry.bytes) {
            normalized.bytes = { ...normalized.bytes, ...entry.bytes };
        }

        this.entries.push(normalized);
        this.indexById.set(id, this.entries.length - 1);
        this._pruneIfNeeded();
        this._emit(normalized);

        return id;
    }

    get(id) {
        const index = this.indexById.get(id);
        if (index === undefined) return null;
        return this.entries[index];
    }

    update(id, patch = {}) {
        const entry = this.get(id);
        if (!entry) return null;

        const next = this._applyPatch(entry, patch);
        const index = this.indexById.get(id);
        this.entries[index] = next;
        this._emit(next);
        return next;
    }

    startAttempt(id, attempt = {}) {
        const entry = this.get(id);
        if (!entry) return null;

        const attemptId = attempt.id || `attempt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const nextAttempt = {
            id: attemptId,
            attemptNo: safeNumber(attempt.attemptNo) || (entry.attempts.length + 1),
            provider: attempt.provider || entry.providerActual || '--',
            accountUuid: attempt.accountUuid || null,
            accountLabel: attempt.accountLabel || entry.accountLabel || '--',
            startedAt: attempt.startedAt || nowIso(),
            endedAt: null,
            durationMs: null,
            status: attempt.status || 'running',
            upstreamStatus: safeNumber(attempt.upstreamStatus),
            errorCode: attempt.errorCode || null,
            errorMessage: attempt.errorMessage || null,
            retry: Boolean(attempt.retry)
        };

        const attempts = [...entry.attempts, nextAttempt];
        const retryCount = Math.max(entry.retryCount || 0, Math.max(0, (nextAttempt.attemptNo || 1) - 1));

        this.update(id, {
            attempts,
            retryCount,
            providerActual: nextAttempt.provider,
            accountUuid: nextAttempt.accountUuid,
            accountLabel: nextAttempt.accountLabel
        });

        return attemptId;
    }

    finishAttempt(id, attemptId, patch = {}) {
        const entry = this.get(id);
        if (!entry) return null;

        const attempts = entry.attempts.map((attempt) => {
            if (attempt.id !== attemptId) return attempt;

            const endedAt = patch.endedAt || nowIso();
            const started = new Date(attempt.startedAt).getTime();
            const ended = new Date(endedAt).getTime();
            const durationMs = Number.isFinite(started) && Number.isFinite(ended) && ended >= started
                ? ended - started
                : null;

            return {
                ...attempt,
                ...patch,
                endedAt,
                durationMs,
                status: patch.status || attempt.status || 'running',
                upstreamStatus: safeNumber(patch.upstreamStatus ?? attempt.upstreamStatus),
                errorCode: patch.errorCode ?? attempt.errorCode ?? null,
                errorMessage: patch.errorMessage ?? attempt.errorMessage ?? null
            };
        });

        return this.update(id, { attempts });
    }

    addTokenUsage(id, usage) {
        const entry = this.get(id);
        if (!entry) return null;

        const { changed, value } = mergeTokenUsage(entry.tokens, usage);
        if (!changed) return entry;

        return this.update(id, { tokens: value });
    }

    addResponseBytes(id, size) {
        const entry = this.get(id);
        if (!entry) return null;

        const increment = safeNumber(size);
        if (increment === null || increment <= 0) return entry;

        const currentResponse = safeNumber(entry.bytes.response) || 0;
        return this.update(id, {
            bytes: {
                ...entry.bytes,
                response: currentResponse + increment
            }
        });
    }

    finalizeSuccess(id, patch = {}) {
        const entry = this.get(id);
        if (!entry) return null;

        return this.update(id, {
            ...patch,
            status: 'success',
            endedAt: patch.endedAt || nowIso(),
            errorCode: null,
            errorMessage: null,
            upstreamStatus: safeNumber(patch.upstreamStatus) ?? entry.upstreamStatus ?? 200
        });
    }

    finalizeError(id, patch = {}) {
        const entry = this.get(id);
        if (!entry) return null;

        return this.update(id, {
            ...patch,
            status: 'error',
            endedAt: patch.endedAt || nowIso(),
            upstreamStatus: safeNumber(patch.upstreamStatus ?? entry.upstreamStatus),
            errorCode: patch.errorCode || entry.errorCode || 'request_error',
            errorMessage: patch.errorMessage || entry.errorMessage || 'Unknown request error'
        });
    }

    _matchDateRange(entry, dateFrom, dateTo) {
        const started = new Date(entry.startedAt).getTime();
        if (!Number.isFinite(started)) return false;

        if (dateFrom && started < dateFrom) return false;
        if (dateTo && started > dateTo) return false;
        return true;
    }

    query(options = {}) {
        const {
            limit = 200,
            offset = 0,
            status,
            provider,
            account,
            q,
            dateFrom,
            dateTo
        } = options;

        let items = [...this.entries].sort((a, b) => {
            const at = new Date(a.startedAt).getTime() || 0;
            const bt = new Date(b.startedAt).getTime() || 0;
            return bt - at;
        });

        if (status && status !== 'all') {
            items = items.filter(item => item.status === status);
        }

        if (provider) {
            const providerLower = provider.toLowerCase();
            items = items.filter((item) =>
                String(item.providerActual || '').toLowerCase().includes(providerLower) ||
                String(item.providerRequested || '').toLowerCase().includes(providerLower)
            );
        }

        if (account) {
            const accountLower = account.toLowerCase();
            items = items.filter((item) =>
                String(item.accountLabel || '').toLowerCase().includes(accountLower) ||
                String(item.accountUuid || '').toLowerCase().includes(accountLower)
            );
        }

        if (q) {
            const qLower = q.toLowerCase();
            items = items.filter((item) => {
                const haystack = [
                    item.id,
                    item.requestId,
                    item.monitorRequestId,
                    item.path,
                    item.modelRequested,
                    item.modelActual,
                    item.providerRequested,
                    item.providerActual,
                    item.accountLabel,
                    item.errorMessage
                ].map(v => String(v || '').toLowerCase()).join(' ');
                return haystack.includes(qLower);
            });
        }

        if (dateFrom || dateTo) {
            items = items.filter((item) => this._matchDateRange(item, dateFrom, dateTo));
        }

        const total = items.length;
        const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 200));
        const safeOffset = Math.max(0, Number(offset) || 0);
        const paged = items.slice(safeOffset, safeOffset + safeLimit);

        return {
            data: paged.map(cloneEntry),
            total,
            limit: safeLimit,
            offset: safeOffset
        };
    }

    clear() {
        this.entries = [];
        this.indexById.clear();
    }
}

export const requestLogStore = new RequestLogStore();
