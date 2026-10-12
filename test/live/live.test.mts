/**
 * LIVE checks against the real dosya.dev API. Skipped unless
 * DOSYA_LIVE_API_KEY and DOSYA_LIVE_WORKSPACE are set; run with
 * `npm run test:live`. Use a dedicated test account: this creates a folder
 * named "n8n-live-<timestamp>", files and share links inside it, and removes
 * them again at the end.
 *
 * The HTTP layer here is a small fetch-based stand-in for n8n's helpers, so
 * this proves the API contracts. Running the example workflows in a real n8n
 * instance is the separate end-to-end check described in the README.
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';

import { createFolder, createShareLink, downloadFile, listFiles, uploadFile } from '../../nodes/Dosya/actions';
import { searchFiles, searchFolders, searchWorkspaces } from '../../nodes/Dosya/methods';
import { API_BASE, USER_AGENT } from '../../nodes/Dosya/transport';
import { collect, NODE, streamOf } from '../fake-context';

const KEY = process.env.DOSYA_LIVE_API_KEY ?? '';
const WORKSPACE = process.env.DOSYA_LIVE_WORKSPACE ?? '';
const live = KEY && WORKSPACE ? describe : describe.skip;

const MB = 1024 * 1024;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function http(request: IDataObject, key?: string) {
	const url = new URL(String(request.url));
	for (const [k, v] of Object.entries((request.qs as IDataObject) ?? {})) {
		if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
	}
	const headers: Record<string, string> = { ...((request.headers as Record<string, string>) ?? {}) };
	if (key) headers.Authorization = `Bearer ${key}`;
	let body: BodyInit | undefined;
	if (Buffer.isBuffer(request.body)) body = request.body;
	else if (request.body !== undefined) {
		body = JSON.stringify(request.body);
		headers['Content-Type'] = 'application/json';
	}
	delete headers['Content-Length']; // fetch frames the body itself
	const res = await fetch(url, {
		method: String(request.method ?? 'GET'),
		headers,
		body,
		redirect: request.disableFollowRedirect ? 'manual' : 'follow',
	});
	const responseHeaders: Record<string, string> = {};
	res.headers.forEach((v, k) => (responseHeaders[k] = v));
	const out =
		request.encoding === 'stream'
			? streamOf(Buffer.from(await res.arrayBuffer()), 64 * 1024)
			: await res.text();
	return { statusCode: res.status, headers: responseHeaders, body: out };
}

function context(params: IDataObject, opts: { key?: string; binary?: IDataObject; executionId?: string } = {}) {
	const prepared: Buffer[] = [];
	const ctx = {
		getNode: () => NODE,
		getExecutionId: () => opts.executionId ?? `live-${Date.now()}-${Math.random()}`,
		continueOnFail: () => false,
		getNodeParameter: (name: string, _i: number, fallback?: unknown) => (name in params ? params[name] : fallback),
		getCurrentNodeParameter: (name: string) => params[name],
		helpers: {
			httpRequestWithAuthentication: (_c: string, r: IDataObject) => http(r, opts.key ?? KEY),
			httpRequest: (r: IDataObject) => http(r),
			assertBinaryData: (_i: number, field: string) => {
				const b = opts.binary?.[field];
				if (!b) throw new Error(`no binary ${field}`);
				return b;
			},
			getBinaryDataBuffer: async (_i: number, field: string) =>
				Buffer.from(String((opts.binary![field] as IDataObject).data), 'base64'),
			getBinaryMetadata: async () => ({ fileSize: 0 }),
			getBinaryStream: async () => {
				throw new Error('not used');
			},
			prepareBinaryData: async (data: unknown, fileName?: string, mimeType?: string) => {
				const bytes = Buffer.isBuffer(data) ? data : await collect(data);
				prepared.push(bytes);
				return { data: '', fileName, mimeType };
			},
		},
	};
	return { ctx: ctx as unknown as IExecuteFunctions & ILoadOptionsFunctions, prepared };
}

function binary(data: Buffer, fileName: string, mimeType = 'application/octet-stream') {
	return { data: { data: data.toString('base64'), fileName, mimeType } };
}

async function api(method: string, path: string, body?: IDataObject) {
	const res = await http({ method, url: `${API_BASE}${path}`, body, headers: { 'User-Agent': USER_AGENT } }, KEY);
	return { status: res.statusCode, body: JSON.parse(String(res.body) || '{}') };
}

live('live dosya.dev API', () => {
	let folderId = '';
	const linkIds: string[] = [];
	const names = {
		unicode: 'Rapor ğüşİ é + & #1 (final) 東京 %20.pdf',
	};

	beforeAll(async () => {
		const { ctx } = context({ workspace: WORKSPACE, folder: '', name: `n8n-live-${Date.now()}`, options: {} });
		const out = await createFolder.call(ctx, 0);
		folderId = String(out.json.id);
	});

	afterAll(async () => {
		for (const id of linkIds) await api('POST', `/api/shares/${id}/revoke`).catch(() => undefined);
		if (folderId) await api('DELETE', `/api/folders/${folderId}`).catch(() => undefined);
	});

	it('rejects a wrong API key with the credential message', async () => {
		const { ctx } = context({ workspace: WORKSPACE, folder: '', returnAll: false, limit: 1, options: {} }, { key: 'dk_not_a_real_key' });
		await expect(listFiles.call(ctx, 0)).rejects.toMatchObject({ message: 'dosya.dev did not accept the API key' });
	});

	it('lists workspaces and folders for the pickers', async () => {
		const { ctx } = context({ workspace: WORKSPACE });
		const ws = await searchWorkspaces.call(ctx);
		expect(ws.results.map((r) => r.value)).toContain(WORKSPACE);
		const folders = await searchFolders.call(ctx);
		expect(folders.results[0]).toEqual({ name: 'Workspace Root', value: 'root' });
		expect(folders.results.map((r) => r.value)).toContain(folderId);
	});

	it('creating the same folder twice reuses it', async () => {
		const params = { workspace: WORKSPACE, folder: folderId, name: 'Clients', options: {} };
		const first = await createFolder.call(context(params).ctx, 0);
		const second = await createFolder.call(context(params).ctx, 0);
		expect(first.json.created).toBe(true);
		expect(second.json).toMatchObject({ id: first.json.id, created: false });
		const slashed = await createFolder.call(
			context({ ...params, name: 'A/B Trading', options: { slashesInName: true } }).ctx,
			0,
		);
		expect(slashed.json.name).toBe('A-B Trading');
	});

	it('round-trips a small file with a Unicode name byte for byte', async () => {
		const data = Buffer.from(`%PDF-1.4 live check ${Date.now()}\n`.repeat(2000));
		const up = await uploadFile.call(
			context({ workspace: WORKSPACE, folder: folderId, binaryPropertyName: 'data', fileName: '' }, { binary: binary(data, names.unicode, 'application/pdf') }).ctx,
			0,
		);
		expect(up.json).toMatchObject({ name: names.unicode, size: data.length, hash_verified: true, upload_method: 'single request', mime_type: 'application/pdf' });

		const { ctx, prepared } = context({ file: up.json.id, binaryPropertyName: 'data' });
		const down = await downloadFile.call(ctx, 0);
		expect(down.json).toMatchObject({ name: names.unicode });
		expect(sha256(prepared[0])).toBe(sha256(data));
	});

	it('a retried upload in the same execution does not create a second file or version', async () => {
		const data = Buffer.from(`dedupe ${Date.now()}`);
		const run = () =>
			uploadFile.call(
				context(
					{ workspace: WORKSPACE, folder: folderId, binaryPropertyName: 'data', fileName: 'dedupe.txt' },
					{ binary: binary(data, 'x.txt', 'text/plain'), executionId: 'live-dedupe-exec' },
				).ctx,
				0,
			);
		const first = await run();
		const second = await run();
		expect(second.json).toMatchObject({ id: first.json.id, version: 1, deduplicated: true });
	});

	it('uploads above 50 MB in parts and downloads the same bytes', async () => {
		const data = Buffer.alloc(52 * MB + 777);
		for (let i = 0; i < data.length; i += 4096) data.writeUInt32LE(i, i);
		const up = await uploadFile.call(
			context({ workspace: WORKSPACE, folder: folderId, binaryPropertyName: 'data', fileName: 'big file ü.bin' }, { binary: binary(data, 'big.bin') }).ctx,
			0,
		);
		expect(up.json).toMatchObject({ size: data.length, upload_method: 'multi-part', name: 'big file ü.bin' });
		const { ctx, prepared } = context({ file: up.json.id, binaryPropertyName: 'data' });
		await downloadFile.call(ctx, 0);
		expect(sha256(prepared[0])).toBe(sha256(data));
	}, 300_000);

	it('lists the folder, and the API pages without gaps or repeats', async () => {
		for (let n = 0; n < 11; n++) {
			await uploadFile.call(
				context({ workspace: WORKSPACE, folder: folderId, binaryPropertyName: 'data', fileName: `page-${n}.txt` }, { binary: binary(Buffer.from(`p${n}`), 'p.txt', 'text/plain') }).ctx,
				0,
			);
		}
		const all = await listFiles.call(context({ workspace: WORKSPACE, folder: folderId, returnAll: true, options: { includeFolders: true } }).ctx, 0);
		const files = all.filter((i) => i.json.type === 'file');
		const folders = all.filter((i) => i.json.type === 'folder');
		expect(files.length).toBeGreaterThanOrEqual(14);
		expect(folders.map((f) => f.json.name)).toEqual(expect.arrayContaining(['Clients', 'A-B Trading']));

		// The contract listFiles relies on: page 2 continues page 1 exactly.
		const page = async (n: number) =>
			(await api('GET', `/api/files?workspace_id=${WORKSPACE}&folder_id=${folderId}&sort=name&per_page=10&page=${n}`)).body;
		const p1 = await page(1);
		const p2 = await page(2);
		const ids = [...p1.files, ...p2.files].map((f: IDataObject) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(p1.pagination.total_pages).toBeGreaterThanOrEqual(2);
		expect(ids.length).toBe(p1.pagination.total_files);

		const limited = await listFiles.call(context({ workspace: WORKSPACE, folder: folderId, returnAll: false, limit: 3, options: {} }).ctx, 0);
		expect(limited).toHaveLength(3);

		const search = await searchFiles.call(context({ workspace: WORKSPACE }).ctx, 'page-1');
		expect(search.results.map((r) => r.name)).toContain('page-1.txt');
	});

	it('creates a share link for a file and a folder', async () => {
		const up = await uploadFile.call(
			context({ workspace: WORKSPACE, folder: folderId, binaryPropertyName: 'data', fileName: 'share-me.txt' }, { binary: binary(Buffer.from('share'), 's.txt', 'text/plain') }).ctx,
			0,
		);
		const fileLink = await createShareLink.call(
			context({ shareTarget: 'file', file: up.json.id, options: { expiresInDays: 1, viewOnly: true } }).ctx,
			0,
		);
		linkIds.push(String(fileLink.json.id));
		expect(String(fileLink.json.url)).toMatch(/^https:\/\//);
		expect(fileLink.json).toMatchObject({ target_type: 'file', view_only: true });
		expect(fileLink.json.expires_at).not.toBeNull();

		const page = await fetch(String(fileLink.json.url), { headers: { 'User-Agent': 'curl/8.7.1' } });
		expect(page.status).toBe(200);

		const folderLink = await createShareLink.call(context({ shareTarget: 'folder', shareFolder: folderId, options: {} }).ctx, 0);
		linkIds.push(String(folderLink.json.id));
		expect(folderLink.json.target_type).toBe('folder');
	});

	it('reports a missing file as unavailable', async () => {
		const { ctx } = context({ file: 'file_doesnotexist000000', binaryPropertyName: 'data' });
		await expect(downloadFile.call(ctx, 0)).rejects.toMatchObject({ message: 'File not found' });
	});
});
