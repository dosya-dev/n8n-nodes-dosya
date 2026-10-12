import { createHash } from 'crypto';
import type { IBinaryData, IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	dosyaRequest,
	getHeader,
	IDEMPOTENCY_HEADER,
	ONE_SHOT_MAX_BYTES,
	REPLAY_HEADER,
	USER_AGENT,
} from './transport';

const UPLOAD_TIMEOUT_MS = 10 * 60_000;
/** The page size dosya.dev allows at most for GET /api/files. */
const LIST_PAGE_SIZE = 500;

type BinaryStream = Awaited<ReturnType<IExecuteFunctions['helpers']['getBinaryStream']>>;

/* ------------------------------------------------------------------ helpers */

function rlValue(context: IExecuteFunctions, name: string, itemIndex: number): string {
	const value = context.getNodeParameter(name, itemIndex, '', { extractValue: true }) as string;
	return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

/** The folder parameter, where empty (or the "Workspace Root" list entry) means the root. */
export function folderIdOrRoot(value: string): string | null {
	return value === '' || value === 'root' ? null : value;
}

function requireValue(context: IExecuteFunctions, value: string, what: string, itemIndex: number): string {
	if (!value) {
		throw new NodeOperationError(context.getNode(), `No ${what} selected`, {
			description: `Choose a ${what} from the list, or enter its ID.`,
			itemIndex,
		});
	}
	return value;
}

function isoFromUnix(value: unknown): string | null {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) return null;
	return new Date(n * 1000).toISOString();
}

/**
 * The file name to upload under: the override if given, else the incoming
 * binary's own name. dosya.dev sets a file's type from its extension, so a
 * name without one gets the binary's extension appended rather than being
 * stored as an untyped file.
 */
export function resolveFileName(override: string, binary: Pick<IBinaryData, 'fileName' | 'fileExtension'>): string {
	let name = override.trim() || (binary.fileName ?? '').trim() || 'file';
	const lastDot = name.lastIndexOf('.');
	const hasExtension = lastDot > 0 && lastDot < name.length - 1;
	if (!hasExtension && binary.fileExtension) {
		name = `${name}.${binary.fileExtension.replace(/^\./, '')}`;
	}
	return name;
}

/**
 * A UUID v4 that is the same every time THIS item is uploaded by THIS node
 * in THIS execution, and different otherwise. dosya.dev stores the first
 * completed upload under the key and answers any repeat with it, so a retry
 * after a timeout cannot create a second copy. Content is part of the seed,
 * so two different files in a loop can never share a key.
 */
export function idempotencyKey(parts: {
	executionId: string;
	nodeId: string;
	workspaceId: string;
	folderId: string | null;
	fileName: string;
	sha256: string;
	itemIndex: number;
}): string {
	const seed = [
		'n8n-nodes-dosya',
		parts.executionId,
		parts.nodeId,
		parts.workspaceId,
		parts.folderId ?? '',
		parts.fileName,
		parts.sha256,
		String(parts.itemIndex),
	].join('\n');
	const h = createHash('sha256').update(seed).digest('hex');
	const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function fileOutput(file: IDataObject, extra: IDataObject): IDataObject {
	return {
		id: file.id,
		name: file.name,
		size: file.size_bytes,
		mime_type: file.mime_type,
		version: file.version,
		...extra,
	};
}

/* ------------------------------------------------------------------- upload */

export async function uploadFile(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const workspaceId = requireValue(this, rlValue(this, 'workspace', i), 'workspace', i);
	const folderId = folderIdOrRoot(rlValue(this, 'folder', i));
	const field = (this.getNodeParameter('binaryPropertyName', i) as string).trim();
	const binary = this.helpers.assertBinaryData(i, field);
	const fileName = resolveFileName(this.getNodeParameter('fileName', i, '') as string, binary);

	// Inline (base64) binaries are already in memory; stored ones are read
	// through the binary-data helpers, so nothing here touches the disk.
	let size: number;
	if (binary.id) {
		size = (await this.helpers.getBinaryMetadata(binary.id)).fileSize;
	} else {
		size = Buffer.byteLength(binary.data, 'base64');
	}

	const file =
		size <= ONE_SHOT_MAX_BYTES
			? await uploadOneShot.call(this, i, { workspaceId, folderId, fileName, field })
			: await uploadInParts.call(this, i, { workspaceId, folderId, fileName, field, binary, size });

	return {
		json: fileOutput(file.file, {
			is_new_version: Number(file.file.version) > 1,
			workspace_id: workspaceId,
			folder_id: folderId,
			created_at: isoFromUnix(file.file.created_at),
			hash_verified: file.file.hash_verified === true,
			deduplicated: file.replayed,
			upload_method: file.method,
		}),
		pairedItem: { item: i },
	};
}

async function uploadOneShot(
	this: IExecuteFunctions,
	i: number,
	target: { workspaceId: string; folderId: string | null; fileName: string; field: string },
): Promise<{ file: IDataObject; replayed: boolean; method: string }> {
	const data = await this.helpers.getBinaryDataBuffer(i, target.field);
	if (data.length > ONE_SHOT_MAX_BYTES) {
		throw new NodeOperationError(this.getNode(), 'The file grew while it was being read', { itemIndex: i });
	}
	const sha256 = createHash('sha256').update(data).digest('hex');

	const headers: Record<string, string> = {
		'Content-Length': String(data.length),
		// dosya.dev checks the received bytes against this and refuses a mismatch.
		'X-Dosya-Sha256': sha256,
	};
	const executionId = this.getExecutionId();
	if (executionId) {
		headers[IDEMPOTENCY_HEADER] = idempotencyKey({
			executionId,
			nodeId: this.getNode().id ?? this.getNode().name,
			workspaceId: target.workspaceId,
			folderId: target.folderId,
			fileName: target.fileName,
			sha256,
			itemIndex: i,
		});
	}

	const qs: IDataObject = { workspace_id: target.workspaceId, file_name: target.fileName };
	if (target.folderId) qs.folder_id = target.folderId;

	const response = await dosyaRequest.call(this, {
		method: 'PUT',
		path: '/api/upload/file',
		qs,
		body: data,
		headers,
		idempotent: false,
		timeout: UPLOAD_TIMEOUT_MS,
		itemIndex: i,
	});
	return {
		file: (response.body.file ?? {}) as IDataObject,
		replayed: getHeader(response, REPLAY_HEADER) === 'true',
		method: 'single request',
	};
}

/** Read a binary in parts of `partSize` bytes without holding the whole file. */
async function* chunksOf(source: Buffer | BinaryStream, partSize: number): AsyncGenerator<Buffer> {
	if (Buffer.isBuffer(source)) {
		for (let offset = 0; offset < source.length; offset += partSize) {
			yield source.subarray(offset, offset + partSize);
		}
		return;
	}
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	for await (const chunk of source as AsyncIterable<Buffer | string>) {
		let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		while (buf.length > 0) {
			const take = Math.min(partSize - pendingBytes, buf.length);
			pending.push(buf.subarray(0, take));
			pendingBytes += take;
			buf = buf.subarray(take);
			if (pendingBytes === partSize) {
				yield Buffer.concat(pending, pendingBytes);
				pending = [];
				pendingBytes = 0;
			}
		}
	}
	if (pendingBytes > 0) yield Buffer.concat(pending, pendingBytes);
}

async function uploadInParts(
	this: IExecuteFunctions,
	i: number,
	target: {
		workspaceId: string;
		folderId: string | null;
		fileName: string;
		field: string;
		binary: IBinaryData;
		size: number;
	},
): Promise<{ file: IDataObject; replayed: boolean; method: string }> {
	// Opening a session creates nothing a user can see; an abandoned one is
	// swept by dosya.dev. So it is not retried after an ambiguous failure, but
	// a duplicate session would be harmless if it were.
	const init = await dosyaRequest.call(this, {
		method: 'POST',
		path: '/api/upload/init',
		body: {
			workspace_id: target.workspaceId,
			folder_id: target.folderId,
			file_name: target.fileName,
			file_size: target.size,
			mime_type: target.binary.mimeType,
		},
		idempotent: false,
		itemIndex: i,
	});
	const sessionId = init.body.session_id as string;
	const resumable = init.body.resumable as IDataObject | null;
	if (!sessionId || !resumable) {
		throw new NodeOperationError(this.getNode(), 'dosya.dev did not open a multi-part upload', {
			description: 'Try again. If it keeps happening, contact dosya.dev support.',
			itemIndex: i,
		});
	}
	const partSize = Number(resumable.part_size);
	const source: Buffer | BinaryStream = target.binary.id
		? await this.helpers.getBinaryStream(target.binary.id, partSize)
		: await this.helpers.getBinaryDataBuffer(i, target.field);

	let completed = false;
	try {
		let partNumber = 0;
		for await (const part of chunksOf(source, partSize)) {
			partNumber++;
			// Sending a part again replaces the same part, so parts are safe to retry.
			await dosyaRequest.call(this, {
				method: 'PUT',
				path: `/api/upload/${encodeURIComponent(sessionId)}/part/${partNumber}`,
				body: part,
				headers: { 'Content-Length': String(part.length) },
				idempotent: true,
				timeout: UPLOAD_TIMEOUT_MS,
				itemIndex: i,
			});
		}
		// Completing twice is refused rather than duplicated, but it is still
		// not retried after an ambiguous failure: the second answer would be a
		// confusing "already complete" for an upload that did succeed.
		const done = await dosyaRequest.call(this, {
			method: 'POST',
			path: `/api/upload/${encodeURIComponent(sessionId)}/complete`,
			idempotent: false,
			timeout: UPLOAD_TIMEOUT_MS,
			itemIndex: i,
		});
		completed = true;
		return { file: (done.body.file ?? {}) as IDataObject, replayed: false, method: 'multi-part' };
	} finally {
		if (!completed) {
			// Free the session at once instead of leaving it to the sweep. Best effort.
			await dosyaRequest
				.call(this, { method: 'DELETE', path: `/api/upload/${encodeURIComponent(sessionId)}`, idempotent: true })
				.catch(() => undefined);
		}
	}
}

/* ----------------------------------------------------------------- download */

export async function downloadFile(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const fileId = requireValue(this, rlValue(this, 'file', i), 'file', i);
	const outputField = (this.getNodeParameter('binaryPropertyName', i) as string).trim();

	// download-url hands back a short-lived signed link as JSON. The bytes are
	// then fetched WITHOUT the credential, so the API key never leaves
	// api.dosya.dev.
	const grant = await dosyaRequest.call(this, {
		method: 'GET',
		path: `/api/files/${encodeURIComponent(fileId)}/download-url`,
		idempotent: true,
		itemIndex: i,
	});
	const url = grant.body.url as string;
	const name = (grant.body.name as string) || fileId;

	let response: { statusCode: number; headers: Record<string, unknown>; body: unknown };
	try {
		response = await this.helpers.httpRequest({
			method: 'GET',
			url,
			encoding: 'stream',
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			headers: { 'User-Agent': USER_AGENT },
			timeout: UPLOAD_TIMEOUT_MS,
		});
	} catch (error) {
		throw new NodeOperationError(this.getNode(), error as Error, {
			message: 'Could not download the file from dosya.dev',
			description: 'Check the network connection of your n8n instance, then try again.',
			itemIndex: i,
		});
	}
	if (response.statusCode >= 400) {
		throw new NodeOperationError(
			this.getNode(),
			`The download link from dosya.dev answered with status ${response.statusCode}`,
			{ description: 'The link may have expired before the download started. Try again.', itemIndex: i },
		);
	}

	// The signed link usually answers application/octet-stream whatever the
	// file is (seen live), so a generic type is not passed on: n8n then
	// derives the type from the file name, the same way dosya.dev does.
	const headerType = (getHeader(response, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
	const mimeType = headerType && headerType !== 'application/octet-stream' ? headerType : undefined;
	const binary = await this.helpers.prepareBinaryData(response.body as BinaryStream, name, mimeType);

	return {
		json: { id: fileId, name, size: grant.body.size, mime_type: binary.mimeType ?? mimeType ?? null },
		binary: { [outputField]: binary },
		pairedItem: { item: i },
	};
}

/* --------------------------------------------------------------------- list */

export async function listFiles(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const workspaceId = requireValue(this, rlValue(this, 'workspace', i), 'workspace', i);
	const folderId = folderIdOrRoot(rlValue(this, 'folder', i));
	const returnAll = this.getNodeParameter('returnAll', i) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', i) as number);
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const includeFolders = options.includeFolders === true;
	const sort = (options.sort as string) || 'newest';

	const results: INodeExecutionData[] = [];
	const push = (json: IDataObject) => results.push({ json, pairedItem: { item: i } });

	for (let page = 1; results.length < limit; page++) {
		const qs: IDataObject = {
			workspace_id: workspaceId,
			sort,
			page,
			per_page: Math.min(LIST_PAGE_SIZE, Math.max(10, limit === Infinity ? LIST_PAGE_SIZE : limit)),
		};
		if (folderId) qs.folder_id = folderId;
		const response = await dosyaRequest.call(this, {
			method: 'GET',
			path: '/api/files',
			qs,
			idempotent: true,
			itemIndex: i,
		});
		const body = response.body;

		// Subfolders are not paginated: every page repeats the full list, so
		// they are taken from the first page only.
		if (page === 1 && includeFolders) {
			for (const folder of (body.folders as IDataObject[]) ?? []) {
				if (results.length >= limit) break;
				push({
					type: 'folder',
					id: folder.id,
					name: folder.name,
					size: folder.total_size_bytes,
					file_count: folder.file_count,
					workspace_id: workspaceId,
					folder_id: folderId,
					created_at: isoFromUnix(folder.created_at),
					updated_at: isoFromUnix(folder.updated_at),
				});
			}
		}

		const files = (body.files as IDataObject[]) ?? [];
		for (const file of files) {
			if (results.length >= limit) break;
			push({
				type: 'file',
				id: file.id,
				name: file.name,
				size: file.size_bytes,
				mime_type: file.mime_type,
				extension: file.extension,
				version: file.current_version,
				workspace_id: workspaceId,
				folder_id: folderId,
				created_at: isoFromUnix(file.created_at),
				updated_at: isoFromUnix(file.updated_at),
			});
		}

		const pagination = (body.pagination as IDataObject) ?? {};
		const totalPages = Number(pagination.total_pages ?? 1);
		if (files.length === 0 || page >= totalPages) break;
	}
	return results;
}

/* ------------------------------------------------------------ create folder */

/**
 * dosya.dev treats "/" and "\" in a folder name as nesting, so "Clients/Acme"
 * creates Acme inside Clients. With `replaceSlashes` they become dashes and
 * the name stays one folder, which is what a customer name like "A/B Ltd" needs.
 */
export function folderNameFor(name: string, replaceSlashes: boolean): string {
	const trimmed = name.trim();
	return replaceSlashes ? trimmed.replace(/[\\/]+/g, '-') : trimmed;
}

export async function createFolder(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const workspaceId = requireValue(this, rlValue(this, 'workspace', i), 'workspace', i);
	const parentId = folderIdOrRoot(rlValue(this, 'folder', i));
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const name = folderNameFor(this.getNodeParameter('name', i) as string, options.slashesInName === true);
	if (name.split(/[\\/]/).every((segment) => segment.trim() === '')) {
		throw new NodeOperationError(this.getNode(), 'The folder name is empty', {
			description: 'Enter a name, or check that the expression for it returns text.',
			itemIndex: i,
		});
	}

	const body: IDataObject = { workspace_id: workspaceId, name };
	if (parentId) body.parent_id = parentId;

	// dosya.dev reuses a folder that already exists under that name instead
	// of creating a second one, so this is safe to retry.
	const response = await dosyaRequest.call(this, {
		method: 'POST',
		path: '/api/folders',
		body,
		idempotent: true,
		itemIndex: i,
	});
	const folder = (response.body.folder ?? {}) as IDataObject;
	const createdCount = Number(response.body.created_count ?? 0);
	return {
		json: {
			id: folder.id,
			name: folder.name,
			parent_id: folder.parent_id ?? null,
			workspace_id: workspaceId,
			created: createdCount > 0,
			created_count: createdCount,
		},
		pairedItem: { item: i },
	};
}

/* -------------------------------------------------------- create share link */

export async function createShareLink(this: IExecuteFunctions, i: number): Promise<INodeExecutionData> {
	const target = this.getNodeParameter('shareTarget', i) as 'file' | 'folder';
	const targetId =
		target === 'folder'
			? requireValue(this, folderIdOrRoot(rlValue(this, 'shareFolder', i)) ?? '', 'folder', i)
			: requireValue(this, rlValue(this, 'file', i), 'file', i);
	const options = this.getNodeParameter('options', i, {}) as IDataObject;

	const body: IDataObject = {};
	const days = Number(options.expiresInDays ?? 0);
	if (days > 0) body.expires_in_days = days;
	if (typeof options.accessCode === 'string' && options.accessCode !== '') {
		if (options.accessCode.length < 8) {
			throw new NodeOperationError(this.getNode(), 'The access code is shorter than 8 characters', {
				description: 'dosya.dev needs an access code of at least 8 characters.',
				itemIndex: i,
			});
		}
		// The API calls it `password`. It is what a recipient types to open
		// the link, not a dosya.dev account password.
		body.password = options.accessCode;
	}
	if (options.viewOnly === true) body.lock_mode = 'view_only';

	const path =
		target === 'folder'
			? `/api/folders/${encodeURIComponent(targetId)}/share`
			: `/api/files/${encodeURIComponent(targetId)}/share`;

	// Every successful call creates a new link, so this is never retried
	// after an ambiguous failure. A 429 is still retried: dosya.dev refuses a
	// rate-limited request before creating anything.
	const response = await dosyaRequest.call(this, {
		method: 'POST',
		path,
		body,
		idempotent: false,
		itemIndex: i,
	});
	const link = (response.body.link ?? {}) as IDataObject;
	return {
		json: {
			id: link.id,
			url: link.url,
			target_type: target,
			target_id: targetId,
			expires_at: isoFromUnix(link.expires_at),
			view_only: link.lock_mode === 'view_only',
			access_code_required: body.password !== undefined,
			access_mode: link.access_mode,
			created_at: isoFromUnix(link.created_at),
		},
		pairedItem: { item: i },
	};
}
