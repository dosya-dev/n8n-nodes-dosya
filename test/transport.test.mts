import { describe, expect, it, vi } from 'vitest';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => undefined),
}));

import { sleep } from 'n8n-workflow';
import { dosyaRequest, IDEMPOTENCY_HEADER, parseRetryAfter, USER_AGENT } from '../nodes/Dosya/transport';
import { fakeContext } from './fake-context';

const sleepMock = vi.mocked(sleep);

async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return error as { message: string; description?: string; httpCode?: string };
	}
	throw new Error('expected the request to fail');
}

describe('parseRetryAfter', () => {
	it('reads seconds and HTTP dates', () => {
		expect(parseRetryAfter('5')).toBe(5);
		const now = Date.parse('2026-10-12T10:00:00Z');
		expect(parseRetryAfter('Mon, 12 Oct 2026 10:00:30 GMT', now)).toBe(30);
		expect(parseRetryAfter(undefined)).toBeUndefined();
		expect(parseRetryAfter('soon')).toBeUndefined();
	});
});

describe('dosyaRequest', () => {
	it('authenticates through the credential, identifies itself and never follows redirects', async () => {
		const { context, helpers } = fakeContext({ params: {}, api: [{ status: 200, body: { ok: true } }] });
		await dosyaRequest.call(context, { method: 'GET', path: '/api/me', idempotent: true });
		const [credential, options] = helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(credential).toBe('dosyaApi');
		expect(options.url).toBe('https://api.dosya.dev/api/me');
		expect(options.headers['User-Agent']).toBe(USER_AGENT);
		expect(options.disableFollowRedirect).toBe(true);
		expect(options.headers.Authorization).toBeUndefined();
	});

	it('waits for Retry-After on a 429 and then succeeds', async () => {
		sleepMock.mockClear();
		const { context, calls } = fakeContext({
			params: {},
			api: [
				{ status: 429, body: { ok: false, error: 'Too many requests' }, headers: { 'Retry-After': '7' } },
				{ status: 201, body: { ok: true, link: { id: 'lnk_1' } } },
			],
		});
		// Even a non-idempotent call: dosya.dev refuses a rate-limited request before doing anything.
		const res = await dosyaRequest.call(context, { method: 'POST', path: '/api/files/file_1/share', idempotent: false });
		expect(res.statusCode).toBe(201);
		expect(calls).toHaveLength(2);
		expect(sleepMock).toHaveBeenCalledWith(7000);
	});

	it('does not sleep through a long Retry-After and explains the wait', async () => {
		sleepMock.mockClear();
		const { context, calls } = fakeContext({
			params: {},
			api: [{ status: 429, body: { ok: false, error: 'Daily transfer limit reached' }, headers: { 'retry-after': '7200' } }],
		});
		const error = await failure(dosyaRequest.call(context, { method: 'GET', path: '/api/files', idempotent: true }));
		expect(calls).toHaveLength(1);
		expect(sleepMock).not.toHaveBeenCalled();
		expect(error.message).toContain('Daily transfer limit reached');
		expect(error.description).toContain('2 hours');
	});

	it('gives up after three rate-limited attempts', async () => {
		const limited = { status: 429, body: { ok: false, error: 'slow down' }, headers: { 'Retry-After': '1' } };
		const { context, calls } = fakeContext({ params: {}, api: [limited, limited, limited] });
		await failure(dosyaRequest.call(context, { method: 'GET', path: '/api/files', idempotent: true }));
		expect(calls).toHaveLength(3);
	});

	it('retries a 503 only when repeating cannot duplicate anything', async () => {
		const unavailable = { status: 503, body: { ok: false, error: 'busy' } };
		const ok = { status: 200, body: { ok: true } };

		const safe = fakeContext({ params: {}, api: [unavailable, ok] });
		await dosyaRequest.call(safe.context, { method: 'GET', path: '/api/files', idempotent: true });
		expect(safe.calls).toHaveLength(2);

		const unsafe = fakeContext({ params: {}, api: [unavailable, ok] });
		await failure(dosyaRequest.call(unsafe.context, { method: 'POST', path: '/api/files/f/share', idempotent: false }));
		expect(unsafe.calls).toHaveLength(1);
	});

	it('retries a dropped connection only for safe requests', async () => {
		const reset = { throw: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) };
		const ok = { status: 200, body: { ok: true } };

		const safe = fakeContext({ params: {}, api: [reset, ok] });
		await dosyaRequest.call(safe.context, { method: 'GET', path: '/api/files', idempotent: true });
		expect(safe.calls).toHaveLength(2);

		const unsafe = fakeContext({ params: {}, api: [reset, ok] });
		const error = await failure(
			dosyaRequest.call(unsafe.context, { method: 'POST', path: '/api/files/f/share', idempotent: false }),
		);
		expect(unsafe.calls).toHaveLength(1);
		expect(error.message).toBe('Could not reach dosya.dev');
		// Never the platform's "consider Retry on Fail": that would risk a duplicate link.
		expect(error.description).toContain('so you do not create a duplicate');
		expect(error.description).not.toContain('Retry on Fail');
	});

	it('treats a request carrying an idempotency key as safe to repeat', async () => {
		const { context, calls } = fakeContext({
			params: {},
			api: [
				{ throw: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
				// Our first attempt is still being processed on the server.
				{ status: 409, body: { ok: false, error: 'in progress' }, headers: { 'Retry-After': '5' } },
				{ status: 200, body: { ok: true, file: { id: 'file_1' } } },
			],
		});
		const res = await dosyaRequest.call(context, {
			method: 'PUT',
			path: '/api/upload/file',
			headers: { [IDEMPOTENCY_HEADER]: 'k' },
			idempotent: false,
		});
		expect(res.body.file).toEqual({ id: 'file_1' });
		expect(calls).toHaveLength(3);
	});

	it('does not retry a 409 name conflict', async () => {
		const { context, calls } = fakeContext({
			params: {},
			api: [{ status: 409, body: { ok: false, error: 'A file with this name already exists in this folder' } }],
		});
		await failure(dosyaRequest.call(context, { method: 'POST', path: '/api/upload/x/complete', idempotent: false }));
		expect(calls).toHaveLength(1);
	});

	describe('error messages', () => {
		const run = async (status: number, body: object) => {
			const { context } = fakeContext({ params: {}, api: [{ status, body }] });
			return failure(dosyaRequest.call(context, { method: 'GET', path: '/api/x', idempotent: false, itemIndex: 2 }));
		};

		it('invalid credentials point at the API keys page', async () => {
			const e = await run(401, { ok: false, error: 'Invalid or expired API key' });
			expect(e.message).toBe('dosya.dev did not accept the API key');
			expect(e.description).toContain('https://app.dosya.dev/profile/api');
			expect(e.httpCode).toBe('401');
		});

		it('a key with the wrong scope is told to use Full access', async () => {
			const e = await run(403, { ok: false, error: "This credential's scope is 'read' and cannot perform POST /api/folders" });
			expect(e.message).toContain("scope is 'read'");
			expect(e.description).toContain('Full access');
		});

		it('a folder-anchored key is explained', async () => {
			const e = await run(403, {
				ok: false,
				error: 'This API key is anchored at a folder and can only be used over WebDAV or the S3 gateway',
			});
			expect(e.description).toContain('without a folder anchor');
		});

		it('a missing permission keeps the server sentence', async () => {
			const e = await run(403, { ok: false, error: "You don't have permission to create share links" });
			expect(e.message).toBe("You don't have permission to create share links");
			expect(e.description).toContain('permission');
		});

		it('an unavailable file says why it may be missing', async () => {
			const e = await run(404, { ok: false, error: 'File not found' });
			expect(e.message).toBe('File not found');
			expect(e.description).toContain('trash');
		});

		it('insufficient storage points at billing', async () => {
			// The server's own sentences (apps/api src/lib/quota.ts).
			const withSuggestion = await run(400, {
				ok: false,
				error: "You've used 4.9 GB of 5 GB across all your workspaces. Empty the trash to free up space, or upgrade - Starter ($3.99/mo) gives you 100 GB.",
				upgrade: { plan_id: 'starter' },
			});
			expect(withSuggestion.message).toContain("You've used 4.9 GB of 5 GB");
			expect(withSuggestion.description).toContain('https://app.dosya.dev/billing');

			const largestPlan = await run(400, {
				ok: false,
				error: "You've used 2 TB of 2 TB across all your workspaces. Empty the trash to free up space, or upgrade.",
			});
			expect(largestPlan.description).toContain('https://app.dosya.dev/billing');
		});

		it('a workspace storage cap points at the workspace admin, not billing', async () => {
			for (const error of [
				"This workspace has a 10 GB storage limit and this doesn't fit. Empty the trash here or raise the limit in workspace settings.",
				"You've reached your 2 GB per-member storage limit",
			]) {
				const e = await run(400, { ok: false, error });
				expect(e.message).toBe(error);
				expect(e.description).toContain('admin');
				expect(e.description).not.toContain('billing');
			}
		});

		it('the free share-link limit points at billing', async () => {
			const e = await run(403, {
				ok: false,
				error: 'The free plan allows 5 active share links at a time.',
				code: 'share_free_link_limit',
			});
			expect(e.description).toContain('https://app.dosya.dev/billing');
		});
	});
});
