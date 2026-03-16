import { requestLogStore } from './request-log-store.js';

function parseDateParam(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
}

function parseInteger(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.floor(num);
}

function escapeCsv(value) {
    const str = String(value ?? '');
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function buildAttemptsSummary(attempts = []) {
    return attempts.map((attempt) => {
        const no = attempt.attemptNo ?? '-';
        const status = attempt.status || 'unknown';
        const account = attempt.accountLabel || attempt.accountUuid || '--';
        const duration = attempt.durationMs ?? '--';
        const error = attempt.errorMessage || '';
        return `#${no} ${status} ${account} ${duration}ms ${error}`.trim();
    }).join(' | ');
}

function buildCsv(entries) {
    const headers = [
        'id',
        'requestId',
        'status',
        'retryCount',
        'isFallback',
        'providerRequested',
        'providerActual',
        'accountUuid',
        'accountLabel',
        'method',
        'path',
        'endpointType',
        'clientProtocol',
        'stream',
        'clientIp',
        'modelRequested',
        'modelActual',
        'startedAt',
        'endedAt',
        'durationMs',
        'upstreamStatus',
        'errorCode',
        'errorMessage',
        'tokenInput',
        'tokenOutput',
        'tokenTotal',
        'tokenCached',
        'tokenReasoning',
        'requestBytes',
        'responseBytes',
        'attemptsSummary'
    ];

    const rows = entries.map((entry) => {
        const fields = [
            entry.id,
            entry.requestId,
            entry.status,
            entry.retryCount,
            entry.isFallback,
            entry.providerRequested,
            entry.providerActual,
            entry.accountUuid,
            entry.accountLabel,
            entry.method,
            entry.path,
            entry.endpointType,
            entry.clientProtocol,
            entry.stream,
            entry.clientIp,
            entry.modelRequested,
            entry.modelActual,
            entry.startedAt,
            entry.endedAt,
            entry.durationMs,
            entry.upstreamStatus,
            entry.errorCode,
            entry.errorMessage,
            entry.tokens?.input,
            entry.tokens?.output,
            entry.tokens?.total,
            entry.tokens?.cached,
            entry.tokens?.reasoning,
            entry.bytes?.request,
            entry.bytes?.response,
            buildAttemptsSummary(entry.attempts)
        ];

        return fields.map(escapeCsv).join(',');
    });

    return `${headers.join(',')}\n${rows.join('\n')}`;
}

function buildQueryOptions(req, maxLimit = 500) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const limit = Math.max(1, Math.min(maxLimit, parseInteger(requestUrl.searchParams.get('limit'), 200)));
    const offset = Math.max(0, parseInteger(requestUrl.searchParams.get('offset'), 0));

    return {
        limit,
        offset,
        status: requestUrl.searchParams.get('status') || null,
        provider: requestUrl.searchParams.get('provider') || null,
        account: requestUrl.searchParams.get('account') || null,
        q: requestUrl.searchParams.get('q') || null,
        dateFrom: parseDateParam(requestUrl.searchParams.get('dateFrom')),
        dateTo: parseDateParam(requestUrl.searchParams.get('dateTo'))
    };
}

export async function handleGetRequestLogs(req, res) {
    const query = buildQueryOptions(req, 500);
    const result = requestLogStore.query(query);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        success: true,
        ...result
    }));

    return true;
}

export async function handleExportRequestLogs(req, res) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const format = (requestUrl.searchParams.get('format') || 'csv').toLowerCase();

    const query = buildQueryOptions(req, 5000);
    query.limit = 5000;
    query.offset = 0;

    const result = requestLogStore.query(query);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'json') {
        const filename = `request-logs-${timestamp}.json`;
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`
        });
        res.end(JSON.stringify({
            exportedAt: new Date().toISOString(),
            total: result.total,
            data: result.data
        }, null, 2));
        return true;
    }

    const csv = buildCsv(result.data);
    const filename = `request-logs-${timestamp}.csv`;

    res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
    });
    res.end(csv);

    return true;
}
