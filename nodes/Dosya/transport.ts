import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

import { version } from '../../package.json';

export const API_BASE = 'https://api.dosya.dev';
export const APP_BASE = 'https://app.dosya.dev';
export const API_KEYS_URL = `${APP_BASE}/profile/api`;
export const BILLING_URL = `${APP_BASE}/billing`;

/**
 * Read from package.json at build time (tsconfig includes it and the build
 * ships it as dist/package.json), so `npm run release` bumping the version is
 * the only edit a release needs.
 */
export const PACKAGE_VERSION: string = version;

/**
 * Sent on every request to dosya.dev. Two reasons: requests with a default
 * scripting user agent can be refused at the edge before they reach the API,
 * and support can tell which client a failing request came from. It carries
 * no data about the user or the workflow.
 */
export const USER_AGENT = `n8n-nodes-dosya/${PACKAGE_VERSION}`;

/** dosya.dev's one-request upload refuses bodies above this; larger files use parts. */
export const ONE_SHOT_MAX_BYTES = 50 * 1024 * 1024;

/** Upload header honoured by PUT /api/upload/file (UUID v4). */
export const IDEMPOTENCY_HEADER = 'X-Dosya-Idempotency-Key';
/** Set on a 200 that replays an upload this key already completed. */
export const REPLAY_HEADER = 'x-dosya-idempotent-replay';

const MAX_ATTEMPTS = 3;
/** A longer Retry-After (for example a daily transfer cap) is reported, not slept through. */
const MAX_RETRY_WAIT_SECONDS = 30;
const DEFAULT_TIMEOUT_MS = 60_000;

type Context = IExecuteFunctions | ILoadOptionsFunctions;

export interface DosyaRequest {
	method: IHttpRequestMethods;
	path: string;
	qs?: IDataObject;
	body?: IDataObject | Buffer;
	headers?: Record<string, string>;
	/**
	 * Whether the request may be sent again after an ambiguous outcome (no
	 * response, or a 502/503/504). Only true where a repeat cannot create a
	 * second file, folder or link. A 429 is retried regardless: dosya.dev
	 * refuses a rate-limited request before doing any work.
	 */
	idempotent: boolean;
	timeout?: number;
	itemIndex?: number;
}

export interface DosyaResponse<T> {
	statusCode: number;
	headers: Record<string, unknown>;
	body: T;
}

function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== wanted) continue;
		if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
		return value === undefined || value === null ? undefined : String(value);
	}
	return undefined;
}

export function getHeader(response: { headers: Record<string, unknown> }, name: string) {
	return header(response.headers, name);
}

/** Seconds to wait, from a Retry-After header in either of its two RFC 9110 forms. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return undefined;
	return Math.max(0, Math.ceil((date - now) / 1000));
}

export function parseBody(raw: unknown): IDataObject {
	if (raw === undefined || raw === null || raw === '') return {};
	if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? (parsed as IDataObject) : { value: parsed };
		} catch {
			return { error: raw.slice(0, 500) };
		}
	}
	return raw as IDataObject;
}

const TRANSIENT_CODES = new Set([
	'ECONNRESET',
	'ECONNABORTED',
	'ETIMEDOUT',
	'EPIPE',
	'EAI_AGAIN',
	'ENOTFOUND',
	'ECONNREFUSED',
]);

function isTransientTransportError(error: unknown): boolean {
	const code = (error as { code?: unknown } | undefined)?.code;
	if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
	const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
	return typeof cause === 'string' && TRANSIENT_CODES.has(cause);
}

function backoffSeconds(attempt: number): number {
	return attempt; // 1 s, then 2 s
}

/**
 * Turn a dosya.dev refusal into an error that says what happened and how to
 * fix it. dosya.dev answers `{ ok: false, error, code? }`; its sentences are
 * written for people, so they are kept as the message and a fix goes in the
 * description.
 */
export function dosyaError(
	context: Context,
	statusCode: number,
	body: IDataObject,
	options: { itemIndex?: number; retryAfter?: number } = {},
): NodeApiError {
	const serverMessage = typeof body.error === 'string' && body.error ? body.error : undefined;
	const code = typeof body.code === 'string' ? body.code : undefined;
	let message = serverMessage ?? `dosya.dev answered with status ${statusCode}`;
	let description: string | undefined;

	if (statusCode === 401) {
		message = 'dosya.dev did not accept the API key';
		description = `The key may be mistyped, revoked or expired. Create a new key at ${API_KEYS_URL} and update the credential.`;
	} else if (statusCode === 403) {
		if (serverMessage?.includes('anchored at a folder')) {
			description = `Folder-anchored keys only work over WebDAV and S3. Create a key without a folder anchor at ${API_KEYS_URL}.`;
		} else if (serverMessage?.includes("credential's scope")) {
			description = `This node needs a key with Full access scope. Create one at ${API_KEYS_URL} and update the credential.`;
		} else if (code === 'share_free_link_limit') {
			description = `Revoke or let an existing link expire, or upgrade your plan at ${BILLING_URL}.`;
		} else {
			description =
				'Check that the key belongs to a member of this workspace with permission for this action, and that the key is not pinned to a different workspace.';
		}
	} else if (statusCode === 404) {
		description =
			'Check the ID. The file or folder may have been deleted or moved to the trash, or the API key cannot see it.';
	} else if (storageRefusal(statusCode, body) === 'plan') {
		description = `Free up space by emptying the trash, or upgrade your plan at ${BILLING_URL}.`;
	} else if (storageRefusal(statusCode, body) === 'workspace') {
		description = 'A workspace admin set this limit. Empty the trash, or ask an admin to raise the limit in workspace settings.';
	} else if (statusCode === 413) {
		description = 'The file is larger than your plan, workspace or API key allows for a single file.';
	} else if (statusCode === 429) {
		message = serverMessage ?? 'dosya.dev is rate limiting these requests';
		description =
			options.retryAfter !== undefined
				? `Try again in about ${formatWait(options.retryAfter)}. Use the node's Retry On Fail setting, or add a Wait node between batches.`
				: 'Try again later. Use the node\'s Retry On Fail setting, or add a Wait node between batches.';
	} else if (statusCode >= 500) {
		message = serverMessage ?? 'dosya.dev is temporarily unavailable';
		description = 'Try again in a few minutes.';
	}

	return new NodeApiError(
		context.getNode(),
		{ message, statusCode, ...(code ? { code } : {}) } as JsonObject,
		{
			message,
			description,
			httpCode: String(statusCode),
			itemIndex: options.itemIndex,
		},
	);
}

/**
 * Which storage wall a refusal is, from dosya.dev's own sentences
 * (apps/api src/lib/quota.ts and lib/upload/init-gates.ts). Only the plan's
 * wall is fixed by upgrading; a workspace or per-member cap is an admin's
 * setting.
 */
export function storageRefusal(statusCode: number, body: IDataObject): 'plan' | 'workspace' | undefined {
	if (statusCode !== 400 && statusCode !== 413) return undefined;
	const text = typeof body.error === 'string' ? body.error.toLowerCase() : '';
	if (body.upgrade !== undefined || text.startsWith("you've used ") || text.includes('of your plan is already allocated')) {
		return 'plan';
	}
	if (body.code === 'upload_quota_exceeded') return 'plan';
	if (text.includes('storage limit')) return 'workspace';
	return undefined;
}

function formatWait(seconds: number): string {
	if (seconds < 90) return `${seconds} seconds`;
	if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
	return `${Math.round(seconds / 3600)} hours`;
}

/**
 * One request to the dosya.dev API, authenticated by the credential, with
 * bounded retries that cannot duplicate anything (see DosyaRequest.idempotent).
 */
export async function dosyaRequest(this: Context, request: DosyaRequest): Promise<DosyaResponse<IDataObject>> {
	const isBinaryBody = Buffer.isBuffer(request.body);
	const options: IHttpRequestOptions = {
		method: request.method,
		url: `${API_BASE}${request.path}`,
		qs: request.qs,
		body: request.body,
		headers: {
			'User-Agent': USER_AGENT,
			Accept: 'application/json',
			...(isBinaryBody ? { 'Content-Type': 'application/octet-stream' } : {}),
			...request.headers,
		},
		json: !isBinaryBody,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		// A credentialed request never follows a redirect: the key must stay on api.dosya.dev.
		disableFollowRedirect: true,
		timeout: request.timeout ?? DEFAULT_TIMEOUT_MS,
	};
	const hasIdempotencyKey = Boolean(request.headers?.[IDEMPOTENCY_HEADER]);

	for (let attempt = 1; ; attempt++) {
		let response: { statusCode: number; headers: Record<string, unknown>; body: unknown };
		try {
			response = await this.helpers.httpRequestWithAuthentication.call(this, 'dosyaApi', options);
		} catch (error) {
			if ((request.idempotent || hasIdempotencyKey) && attempt < MAX_ATTEMPTS && isTransientTransportError(error)) {
				await sleep(backoffSeconds(attempt) * 1000);
				continue;
			}
			// NodeOperationError, not NodeApiError: the latter swaps in n8n's own
			// sentence for these codes, which recommends Retry On Fail - wrong
			// advice for a request that may already have created a link.
			throw new NodeOperationError(this.getNode(), error as Error, {
				message: 'Could not reach dosya.dev',
				description:
					request.idempotent || hasIdempotencyKey
						? 'The connection failed or timed out. Check the network connection of your n8n instance, then try again.'
						: 'The connection failed or timed out, possibly after dosya.dev had already done the work. Check dosya.dev before running this step again, so you do not create a duplicate.',
				itemIndex: request.itemIndex,
			});
		}

		const body = parseBody(response.body);
		if (response.statusCode < 400) {
			return { statusCode: response.statusCode, headers: response.headers ?? {}, body };
		}

		const retryAfter = parseRetryAfter(header(response.headers, 'retry-after'));
		const retryable =
			response.statusCode === 429 ||
			// Our own earlier attempt with the same idempotency key is still being processed.
			(response.statusCode === 409 && hasIdempotencyKey && retryAfter !== undefined) ||
			((request.idempotent || hasIdempotencyKey) && [502, 503, 504].includes(response.statusCode));
		const wait = retryAfter ?? backoffSeconds(attempt);
		if (retryable && attempt < MAX_ATTEMPTS && wait <= MAX_RETRY_WAIT_SECONDS) {
			await sleep(wait * 1000);
			continue;
		}
		throw dosyaError(this, response.statusCode, body, { itemIndex: request.itemIndex, retryAfter });
	}
}
