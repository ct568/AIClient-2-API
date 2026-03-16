import {
    requestLogStore,
    deriveAccountLabel,
    extractTokenUsage
} from '../src/ui-modules/request-log-store.js';

describe('request-log-store', () => {
    beforeEach(() => {
        requestLogStore.clear();
    });

    test('deriveAccountLabel prefers custom name', () => {
        const label = deriveAccountLabel(
            'claude-kiro-oauth',
            { KIRO_OAUTH_CREDS_FILE_PATH: './configs/kiro/token.json' },
            'Kiro-Account-A',
            'uuid-1'
        );

        expect(label).toBe('Kiro-Account-A');
    });

    test('deriveAccountLabel falls back to credential file basename', () => {
        const label = deriveAccountLabel(
            'claude-kiro-oauth',
            { KIRO_OAUTH_CREDS_FILE_PATH: './configs/kiro/my-token-file.json' },
            '',
            'uuid-1'
        );

        expect(label).toBe('my-token-file.json');
    });

    test('extractTokenUsage supports usage fields', () => {
        const usage = extractTokenUsage({
            usage: {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
                prompt_tokens_details: {
                    cached_tokens: 10
                }
            }
        });

        expect(usage).toEqual({
            input: 100,
            output: 50,
            total: 150,
            cached: 10,
            reasoning: null
        });
    });

    test('extractTokenUsage supports usageMetadata fields', () => {
        const usage = extractTokenUsage({
            usageMetadata: {
                promptTokenCount: 120,
                candidatesTokenCount: 80,
                totalTokenCount: 200,
                thoughtsTokenCount: 20,
                cachedContentTokenCount: 5
            }
        });

        expect(usage).toEqual({
            input: 120,
            output: 80,
            total: 200,
            cached: 5,
            reasoning: 20
        });
    });

    test('store tracks attempts and final status', () => {
        const id = requestLogStore.create({
            requestId: 'req-1',
            path: '/v1/messages',
            method: 'POST',
            status: 'running',
            providerRequested: 'claude-kiro-oauth',
            modelRequested: 'claude-3-7-sonnet'
        });

        const attemptId = requestLogStore.startAttempt(id, {
            attemptNo: 1,
            provider: 'claude-kiro-oauth',
            accountLabel: 'acc-a'
        });

        requestLogStore.addTokenUsage(id, {
            input: 150,
            output: 100,
            total: 250,
            cached: 30,
            reasoning: 10
        });

        requestLogStore.finishAttempt(id, attemptId, {
            status: 'success',
            upstreamStatus: 200
        });

        requestLogStore.finalizeSuccess(id, {
            retryCount: 0,
            upstreamStatus: 200
        });

        const result = requestLogStore.query({ limit: 10, offset: 0 });

        expect(result.total).toBe(1);
        expect(result.data[0].status).toBe('success');
        expect(result.data[0].attempts).toHaveLength(1);
        expect(result.data[0].tokens.total).toBe(250);
    });

    test('query supports status and account filters', () => {
        const id1 = requestLogStore.create({
            requestId: 'req-success',
            status: 'success',
            accountLabel: 'acc-success',
            providerRequested: 'claude-kiro-oauth'
        });
        const id2 = requestLogStore.create({
            requestId: 'req-error',
            status: 'error',
            accountLabel: 'acc-error',
            providerRequested: 'claude-kiro-oauth'
        });

        expect(id1).toBeTruthy();
        expect(id2).toBeTruthy();

        const filtered = requestLogStore.query({
            status: 'error',
            account: 'acc-error',
            limit: 10,
            offset: 0
        });

        expect(filtered.total).toBe(1);
        expect(filtered.data[0].requestId).toBe('req-error');
    });
});
