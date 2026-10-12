import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => undefined),
}));

import {
	createFolder,
	createShareLink,
	downloadFile,
	folderNameFor,
	idempotencyKey,
	listFiles,
	resolveFileName,
	uploadFile,
} from '../nodes/Dosya/actions';
import { Dosya } from '../nodes/Dosya/Dosya.node';
import { collect, fakeContext, streamOf } from './fake-context';

const MB = 1024 * 1024;
const UNICODE_NAME = 'Rapor ğüşİ é + & #1 (final) 東京 %20.pdf';

function bytes(n: number, seed = 1): Buffer {
	const b = Buffer.alloc(n);
	let x = seed;
	for (let i = 0; i < n; i++) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		b[i] = x & 0xff;
	}
	return b;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function inlineBinary(data: Buffer, fileName = UNICODE_NAME, mimeType = 'application/pdf') {
	return { data: data.toString('base64'), fileName, mimeType, fileExtension: 'pdf' };
}

const uploadParams = (extra = {}) => ({
	workspace: 'ws_test',
	folder: '',
	binaryPropertyName: 'data',
	fileName: '',
	...extra,
});

const created = (file: object) => ({ status: 201, body: { ok: true, file } });

describe('Upload', () => {
	it('sends a small file in one request, byte for byte, with its name untouched', async () => {
		const data = bytes(150_000);
		const { context, calls } = fakeContext({
			params: uploadParams({ folder: 'fld_target' }),
			binary: { data: inlineBinary(data) },
			api: [created({ id: 'file_1', name: UNICODE_NAME, size_bytes: data.length, mime_type: 'application/pdf', version: 1, created_at: 1791000000, hash_verified: true })],
		});
		const out = await uploadFile.call(context, 0);

		expect(calls).toHaveLength(1);
		const [put] = calls;
		expect(put.method).toBe('PUT');
		expect(put.url).toBe('https://api.dosya.dev/api/upload/file');
		// Names travel as query values and are encoded by the HTTP client, not by us.
		expect(put.qs).toEqual({ workspace_id: 'ws_test', file_name: UNICODE_NAME, folder_id: 'fld_target' });
		expect(Buffer.compare(put.body as Buffer, data)).toBe(0);
		expect(put.headers['Content-Length']).toBe(String(data.length));
		expect(put.headers['X-Dosya-Sha256']).toBe(sha256(data));
		expect(put.headers['X-Dosya-Idempotency-Key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

		expect(out.json).toMatchObject({
			id: 'file_1',
			name: UNICODE_NAME,
			size: data.length,
			version: 1,
			is_new_version: false,
			workspace_id: 'ws_test',
			folder_id: 'fld_target',
			hash_verified: true,
			deduplicated: false,
			created_at: '2026-10-03T04:00:00.000Z',
		});
		expect(out.pairedItem).toEqual({ item: 0 });
	});

	it('uploads to the workspace root when no folder or "Workspace Root" is chosen', async () => {
		for (const folder of ['', 'root']) {
			const { context, calls } = fakeContext({
				params: uploadParams({ folder }),
				binary: { data: inlineBinary(bytes(10)) },
				api: [created({ id: 'file_1', version: 1 })],
			});
			const out = await uploadFile.call(context, 0);
			expect(calls[0].qs).not.toHaveProperty('folder_id');
			expect(out.json.folder_id).toBeNull();
		}
	});

	it('sends the same idempotency key when the same item is retried, so no duplicate is created', async () => {
		const data = bytes(1000);
		const keyOf = async (executionId: string) => {
			const { context, calls } = fakeContext({
				params: uploadParams(),
				binary: { data: inlineBinary(data) },
				executionId,
				api: [created({ id: 'file_1', version: 1 })],
			});
			await uploadFile.call(context, 0);
			return calls[0].headers['X-Dosya-Idempotency-Key'];
		};
		expect(await keyOf('exec-9')).toBe(await keyOf('exec-9'));
		expect(await keyOf('exec-9')).not.toBe(await keyOf('exec-10'));
	});

	it('gives different files in the same run different keys', () => {
		const base = { executionId: 'e', nodeId: 'n', workspaceId: 'w', folderId: null, fileName: 'a.pdf', sha256: 'x', itemIndex: 0 };
		const key = idempotencyKey(base);
		expect(idempotencyKey({ ...base, sha256: 'y' })).not.toBe(key);
		expect(idempotencyKey({ ...base, itemIndex: 1 })).not.toBe(key);
		expect(idempotencyKey({ ...base, fileName: 'b.pdf' })).not.toBe(key);
		expect(idempotencyKey({ ...base, folderId: 'fld_1' })).not.toBe(key);
	});

	it('reports a replayed upload as deduplicated', async () => {
		const { context } = fakeContext({
			params: uploadParams(),
			binary: { data: inlineBinary(bytes(10)) },
			api: [{ status: 200, body: { ok: true, file: { id: 'file_1', version: 1 } }, headers: { 'X-Dosya-Idempotent-Replay': 'true' } }],
		});
		const out = await uploadFile.call(context, 0);
		expect(out.json.deduplicated).toBe(true);
	});

	it('reports a same-name upload as a new version', async () => {
		const { context } = fakeContext({
			params: uploadParams(),
			binary: { data: inlineBinary(bytes(10)) },
			api: [created({ id: 'file_1', version: 3 })],
		});
		const out = await uploadFile.call(context, 0);
		expect(out.json).toMatchObject({ version: 3, is_new_version: true });
	});

	it('uses the File Name override', async () => {
		const { context, calls } = fakeContext({
			params: uploadParams({ fileName: 'Invoice 2026/10.pdf' }),
			binary: { data: inlineBinary(bytes(10)) },
			api: [created({ id: 'file_1', version: 1 })],
		});
		await uploadFile.call(context, 0);
		expect(calls[0].qs?.file_name).toBe('Invoice 2026/10.pdf');
	});

	it('streams a large stored binary in parts and reassembles to the same bytes', async () => {
		const size = 55 * MB + 12345;
		const data = bytes(size, 7);
		const partSize = 10 * MB;
		const parts = Math.ceil(size / partSize);
		const { context, calls, helpers } = fakeContext({
			params: uploadParams({ folder: 'fld_big' }),
			binary: { data: { data: '', id: 'filesystem-v2:big', fileName: 'backup.tar', mimeType: 'application/x-tar', fileExtension: 'tar' } },
			stored: { 'filesystem-v2:big': data },
			api: [
				{ status: 201, body: { ok: true, session_id: 'upl_1', resumable: { part_size: partSize, total_parts: parts } } },
				...Array.from({ length: parts }, (_, n) => ({ status: 201, body: { ok: true, part_number: n + 1 } })),
				{ status: 200, body: { ok: true, file: { id: 'file_big', name: 'backup.tar', size_bytes: size, version: 1 } } },
			],
		});
		const getBuffer = vi.spyOn(helpers, 'getBinaryDataBuffer');
		const out = await uploadFile.call(context, 0);

		expect(getBuffer).not.toHaveBeenCalled(); // never held whole in memory
		const [init, ...rest] = calls;
		expect(init.url).toBe('https://api.dosya.dev/api/upload/init');
		expect(init.body).toMatchObject({ workspace_id: 'ws_test', folder_id: 'fld_big', file_name: 'backup.tar', file_size: size });
		const partCalls = rest.slice(0, parts);
		expect(partCalls.map((c) => c.url)).toEqual(
			Array.from({ length: parts }, (_, n) => `https://api.dosya.dev/api/upload/upl_1/part/${n + 1}`),
		);
		for (const c of partCalls.slice(0, -1)) expect((c.body as Buffer).length).toBe(partSize);
		expect(Buffer.compare(Buffer.concat(partCalls.map((c) => c.body as Buffer)), data)).toBe(0);
		expect(rest[parts].url).toBe('https://api.dosya.dev/api/upload/upl_1/complete');
		expect(out.json).toMatchObject({ id: 'file_big', size, upload_method: 'multi-part' });
	});

	it('retries a failed part and abandons the session if the upload cannot finish', async () => {
		const size = 51 * MB;
		const data = bytes(size, 3);
		const { context, calls } = fakeContext({
			params: uploadParams(),
			binary: { data: inlineBinary(data, 'big.bin', 'application/octet-stream') },
			api: [
				{ status: 201, body: { ok: true, session_id: 'upl_2', resumable: { part_size: 10 * MB, total_parts: 6 } } },
				{ status: 503, body: { ok: false, error: 'busy' } },
				{ status: 201, body: { ok: true } }, // part 1 on retry
				{ status: 400, body: { ok: false, error: 'Storage limit reached', upgrade: { plan_id: 'starter' } } }, // part 2
				{ status: 200, body: { ok: true } }, // DELETE session
			],
		});
		await expect(uploadFile.call(context, 0)).rejects.toMatchObject({ message: 'Storage limit reached' });
		expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.dosya.dev', '')}`)).toEqual([
			'POST /api/upload/init',
			'PUT /api/upload/upl_2/part/1',
			'PUT /api/upload/upl_2/part/1',
			'PUT /api/upload/upl_2/part/2',
			'DELETE /api/upload/upl_2',
		]);
	});

	it('names a missing binary field clearly', async () => {
		const { context } = fakeContext({ params: uploadParams({ binaryPropertyName: 'attachment_0' }), binary: {} });
		await expect(uploadFile.call(context, 0)).rejects.toThrow('attachment_0');
	});
});

describe('resolveFileName', () => {
	it('keeps the incoming name and adds a missing extension', () => {
		expect(resolveFileName('', { fileName: UNICODE_NAME, fileExtension: 'pdf' })).toBe(UNICODE_NAME);
		expect(resolveFileName('', { fileName: 'report', fileExtension: 'pdf' })).toBe('report.pdf');
		expect(resolveFileName('  Q3 summary  ', { fileName: 'x.pdf', fileExtension: 'pdf' })).toBe('Q3 summary.pdf');
		expect(resolveFileName('', { fileExtension: 'png' })).toBe('file.png');
		expect(resolveFileName('', { fileName: '.env' })).toBe('.env');
	});
});

describe('Download', () => {
	it('fetches the bytes from the signed link without the API key and keeps name and type', async () => {
		const data = bytes(300_000, 5);
		const { context, calls, prepared } = fakeContext({
			params: { file: 'file_1', binaryPropertyName: 'data' },
			api: [{ status: 200, body: { url: 'https://storage.example/signed?sig=abc', size: data.length, name: UNICODE_NAME, region: 'eu' } }],
			download: { status: 200, headers: { 'content-type': 'application/pdf; charset=binary' }, stream: streamOf(data, 4096) },
		});
		const out = await downloadFile.call(context, 0);

		expect(calls[0]).toMatchObject({ url: 'https://api.dosya.dev/api/files/file_1/download-url', authenticated: true });
		expect(calls[1]).toMatchObject({ url: 'https://storage.example/signed?sig=abc', authenticated: false });
		expect(calls[1].headers.Authorization).toBeUndefined();
		expect(Buffer.compare(prepared[0].data, data)).toBe(0);
		expect(prepared[0]).toMatchObject({ fileName: UNICODE_NAME, mimeType: 'application/pdf' });
		expect(out.json).toEqual({ id: 'file_1', name: UNICODE_NAME, size: data.length, mime_type: 'application/pdf' });
		expect(Object.keys(out.binary!)).toEqual(['data']);
	});

	it('lets n8n pick the type from the name when the link only says octet-stream', async () => {
		const { context, prepared } = fakeContext({
			params: { file: 'file_1', binaryPropertyName: 'data' },
			api: [{ status: 200, body: { url: 'https://storage.example/x', size: 3, name: 'scan.pdf' } }],
			download: { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, stream: streamOf(Buffer.from('pdf'), 2) },
		});
		await downloadFile.call(context, 0);
		expect(prepared[0].mimeType).toBeUndefined();
		expect(prepared[0].fileName).toBe('scan.pdf');
	});

	it('reports an unavailable file', async () => {
		const { context } = fakeContext({
			params: { file: 'file_gone', binaryPropertyName: 'data' },
			api: [{ status: 404, body: { ok: false, error: 'File not found' } }],
		});
		await expect(downloadFile.call(context, 0)).rejects.toMatchObject({ message: 'File not found' });
	});
});

describe('Get Many', () => {
	const file = (n: number) => ({ id: `file_${n}`, name: `f${n}.txt`, size_bytes: n, mime_type: 'text/plain', extension: '.txt', current_version: 1, created_at: 1791000000, updated_at: 1791000000 });
	const page = (n: number, ids: number[], totalPages: number) => ({
		status: 200,
		body: { ok: true, folders: [{ id: 'fld_a', name: 'A', total_size_bytes: 5, file_count: 2 }], files: ids.map(file), pagination: { page: n, per_page: 500, total_files: 1001, total_pages: totalPages } },
	});

	it('follows every page when Return All is on, listing subfolders once', async () => {
		const { context, calls } = fakeContext({
			params: { workspace: 'ws_test', folder: 'fld_x', returnAll: true, options: { includeFolders: true } },
			api: [page(1, [1, 2], 3), page(2, [3, 4], 3), page(3, [5], 3)],
		});
		const out = await listFiles.call(context, 0);
		expect(calls.map((c) => c.qs?.page)).toEqual([1, 2, 3]);
		expect(calls[0].qs).toMatchObject({ workspace_id: 'ws_test', folder_id: 'fld_x', per_page: 500, sort: 'newest' });
		expect(out.map((i) => i.json.id)).toEqual(['fld_a', 'file_1', 'file_2', 'file_3', 'file_4', 'file_5']);
		expect(out[1].json).toMatchObject({ type: 'file', size: 1, version: 1, folder_id: 'fld_x', workspace_id: 'ws_test' });
		expect(out[0].json.type).toBe('folder');
	});

	it('stops at the limit without fetching further pages', async () => {
		const { context, calls } = fakeContext({
			params: { workspace: 'ws_test', folder: '', returnAll: false, limit: 3, options: {} },
			api: [page(1, [1, 2], 3), page(2, [3, 4], 3)],
		});
		const out = await listFiles.call(context, 0);
		expect(out).toHaveLength(3);
		expect(calls).toHaveLength(2);
		expect(calls[0].qs).not.toHaveProperty('folder_id');
		expect(calls[0].qs?.per_page).toBe(10); // the API's minimum page size
	});

	it('returns nothing for an empty folder', async () => {
		const { context } = fakeContext({
			params: { workspace: 'ws_test', folder: '', returnAll: true, options: {} },
			api: [{ status: 200, body: { ok: true, folders: [], files: [], pagination: { total_pages: 1 } } }],
		});
		expect(await listFiles.call(context, 0)).toEqual([]);
	});
});

describe('Create Folder', () => {
	it('reports a reused folder as not created', async () => {
		const { context, calls } = fakeContext({
			params: { workspace: 'ws_test', folder: 'fld_clients', name: 'Acme Ltd', options: {} },
			api: [{ status: 201, body: { ok: true, folder: { id: 'fld_acme', name: 'Acme Ltd', parent_id: 'fld_clients' }, created_count: 0 } }],
		});
		const out = await createFolder.call(context, 0);
		expect(calls[0].body).toEqual({ workspace_id: 'ws_test', name: 'Acme Ltd', parent_id: 'fld_clients' });
		expect(out.json).toMatchObject({ id: 'fld_acme', created: false, parent_id: 'fld_clients' });
	});

	it('can keep a customer name with slashes as one folder', () => {
		expect(folderNameFor(' A/B Trading\\Ltd ', true)).toBe('A-B Trading-Ltd');
		expect(folderNameFor('Clients/Acme', false)).toBe('Clients/Acme');
	});

	it('refuses an empty name before calling the API', async () => {
		for (const name of ['', '   ', '/', ' / \\ ']) {
			const { context, calls } = fakeContext({ params: { workspace: 'ws_test', folder: '', name, options: {} } });
			await expect(createFolder.call(context, 0)).rejects.toThrow('The folder name is empty');
			expect(calls).toHaveLength(0);
		}
	});
});

describe('Create Share Link', () => {
	const link = { status: 201, body: { ok: true, link: { id: 'lnk_1', url: 'https://dosya.dev/s/abc', lock_mode: 'view_only', access_mode: 'public', expires_at: 1791604800, created_at: 1791000000 } } };

	it('shares a file with options mapped to the API', async () => {
		const { context, calls } = fakeContext({
			params: { shareTarget: 'file', file: 'file_1', options: { expiresInDays: 7, accessCode: 'correct-horse', viewOnly: true } },
			api: [link],
		});
		const out = await createShareLink.call(context, 0);
		expect(calls[0].url).toBe('https://api.dosya.dev/api/files/file_1/share');
		expect(calls[0].body).toEqual({ expires_in_days: 7, password: 'correct-horse', lock_mode: 'view_only' });
		expect(out.json).toMatchObject({ id: 'lnk_1', url: 'https://dosya.dev/s/abc', target_type: 'file', view_only: true, access_code_required: true });
		expect(JSON.stringify(out.json)).not.toContain('correct-horse');
	});

	it('shares a folder', async () => {
		const { context, calls } = fakeContext({ params: { shareTarget: 'folder', shareFolder: 'fld_1', options: {} }, api: [link] });
		await createShareLink.call(context, 0);
		expect(calls[0].url).toBe('https://api.dosya.dev/api/folders/fld_1/share');
		expect(calls[0].body).toEqual({});
	});

	it('is never sent twice after an ambiguous failure', async () => {
		const { context, calls } = fakeContext({
			params: { shareTarget: 'file', file: 'file_1', options: {} },
			api: [{ throw: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }, link],
		});
		await expect(createShareLink.call(context, 0)).rejects.toThrow('Could not reach dosya.dev');
		expect(calls).toHaveLength(1);
	});

	it('checks the access code length before calling the API', async () => {
		const { context, calls } = fakeContext({ params: { shareTarget: 'file', file: 'file_1', options: { accessCode: 'short' } } });
		await expect(createShareLink.call(context, 0)).rejects.toThrow('shorter than 8');
		expect(calls).toHaveLength(0);
	});

	it('refuses to share the workspace root as a folder', async () => {
		const { context } = fakeContext({ params: { shareTarget: 'folder', shareFolder: 'root', options: {} } });
		await expect(createShareLink.call(context, 0)).rejects.toThrow('No folder selected');
	});
});

describe('execute', () => {
	it('keeps going with an error item per failed input when Continue On Fail is on', async () => {
		const { context } = fakeContext({
			params: { resource: 'folder', operation: 'create', workspace: 'ws_test', folder: '', name: 'Acme', options: {} },
			items: 2,
			continueOnFail: true,
			api: [
				{ status: 403, body: { ok: false, error: "You don't have permission to create folders" } },
				{ status: 201, body: { ok: true, folder: { id: 'fld_1', name: 'Acme' }, created_count: 1 } },
			],
		});
		const [out] = await new Dosya().execute.call(context);
		expect(out[0]).toEqual({ json: { error: "You don't have permission to create folders" }, pairedItem: { item: 0 } });
		expect(out[1].json).toMatchObject({ id: 'fld_1', created: true });
	});
});
