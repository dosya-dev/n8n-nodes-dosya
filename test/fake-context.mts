import { vi } from 'vitest';
import type { IBinaryData, IDataObject, IExecuteFunctions, INode } from 'n8n-workflow';

/** One scripted answer from the dosya.dev API, or a transport failure. */
export type Scripted =
	| { status: number; body?: unknown; headers?: Record<string, string> }
	| { throw: Error & { code?: string } };

export interface Call {
	method: string;
	url: string;
	qs?: IDataObject;
	body?: unknown;
	headers: Record<string, string>;
	authenticated: boolean;
}

export const NODE: INode = {
	id: 'node-1',
	name: 'dosya.dev',
	type: 'n8n-nodes-dosya.dosya',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** A readable-like async iterable that yields `data` in chunks of `chunkSize`. */
export function streamOf(data: Buffer, chunkSize: number) {
	return {
		async *[Symbol.asyncIterator]() {
			for (let offset = 0; offset < data.length; offset += chunkSize) {
				yield data.subarray(offset, offset + chunkSize);
			}
		},
	};
}

export async function collect(stream: unknown): Promise<Buffer> {
	const parts: Buffer[] = [];
	for await (const chunk of stream as AsyncIterable<Buffer>) parts.push(Buffer.from(chunk));
	return Buffer.concat(parts);
}

/**
 * A minimal IExecuteFunctions. `params` holds node parameters; a resource
 * locator is given as its plain value. API answers are consumed in order.
 */
export function fakeContext(options: {
	params: IDataObject;
	api?: Scripted[];
	download?: Scripted & { stream?: unknown };
	binary?: Record<string, IBinaryData & { bytes?: Buffer }>;
	stored?: Record<string, Buffer>;
	executionId?: string;
	items?: number;
	continueOnFail?: boolean;
}) {
	const calls: Call[] = [];
	const queue = [...(options.api ?? [])];
	const prepared: Array<{ data: Buffer; fileName?: string; mimeType?: string }> = [];

	const answer = async (request: IDataObject, authenticated: boolean) => {
		calls.push({
			method: String(request.method),
			url: String(request.url),
			qs: request.qs as IDataObject | undefined,
			body: request.body,
			headers: (request.headers ?? {}) as Record<string, string>,
			authenticated,
		});
		const next = queue.shift();
		if (!next) throw new Error(`Unexpected request ${request.method} ${request.url}`);
		if ('throw' in next) throw next.throw;
		return { statusCode: next.status, headers: next.headers ?? {}, body: next.body ?? {} };
	};

	const binaryFor = (field: string) => {
		const bin = options.binary?.[field];
		if (!bin) throw new Error(`No binary data in field "${field}"`);
		return bin;
	};

	const context = {
		getNode: () => NODE,
		getExecutionId: () => options.executionId ?? 'exec-1',
		getInputData: () => Array.from({ length: options.items ?? 1 }, () => ({ json: {} })),
		continueOnFail: () => options.continueOnFail ?? false,
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in options.params ? options.params[name] : fallback,
		helpers: {
			httpRequestWithAuthentication: vi.fn(async (_cred: string, request: IDataObject) => answer(request, true)),
			httpRequest: vi.fn(async (request: IDataObject) => {
				calls.push({
					method: String(request.method),
					url: String(request.url),
					headers: (request.headers ?? {}) as Record<string, string>,
					authenticated: false,
				});
				const d = options.download;
				if (!d) throw new Error('No download scripted');
				if ('throw' in d) throw d.throw;
				return { statusCode: d.status, headers: d.headers ?? {}, body: d.stream };
			}),
			assertBinaryData: (_i: number, field: string) => binaryFor(field),
			getBinaryDataBuffer: async (_i: number, field: string) => {
				const bin = binaryFor(field);
				if (bin.id) return options.stored![bin.id];
				return Buffer.from(bin.data, 'base64');
			},
			getBinaryMetadata: async (id: string) => ({ fileSize: options.stored![id].length }),
			getBinaryStream: async (id: string, chunkSize = 64 * 1024) =>
				// Deliberately NOT aligned to the part size, like a real file stream.
				streamOf(options.stored![id], Math.max(1, Math.floor(chunkSize / 3) + 7)),
			prepareBinaryData: async (data: unknown, fileName?: string, mimeType?: string) => {
				const bytes = Buffer.isBuffer(data) ? data : await collect(data);
				prepared.push({ data: bytes, fileName, mimeType });
				return { data: '', fileName, mimeType, fileSize: String(bytes.length) } as IBinaryData;
			},
		},
	};

	return {
		context: context as unknown as IExecuteFunctions,
		calls,
		prepared,
		remaining: () => queue.length,
		helpers: context.helpers,
	};
}
