import type { IDataObject, ILoadOptionsFunctions, INodeListSearchItems, INodeListSearchResult } from 'n8n-workflow';

import { dosyaRequest } from './transport';

const SEARCH_PAGE_SIZE = 50;

function currentWorkspace(context: ILoadOptionsFunctions): string {
	const value = context.getCurrentNodeParameter('workspace', { extractValue: true });
	return typeof value === 'string' ? value.trim() : '';
}

function matches(name: string, filter?: string): boolean {
	return !filter || name.toLowerCase().includes(filter.trim().toLowerCase());
}

/**
 * "Clients / Acme / Final" from the flat folder list, so three folders named
 * "Final" are told apart. `seen` guards against a malformed parent chain.
 */
export function folderPath(folder: IDataObject, byId: Map<string, IDataObject>): string {
	const parts = [String(folder.name)];
	const seen = new Set([folder.id]);
	let current: IDataObject | undefined = folder;
	while (current?.parent_id && !seen.has(current.parent_id)) {
		seen.add(current.parent_id);
		current = byId.get(String(current.parent_id));
		if (!current) break;
		parts.unshift(String(current.name));
	}
	return parts.join(' / ');
}

export async function searchWorkspaces(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
	const response = await dosyaRequest.call(this, { method: 'GET', path: '/api/workspaces', idempotent: true });
	const workspaces = (response.body.workspaces as IDataObject[]) ?? [];
	const results: INodeListSearchItems[] = workspaces
		.filter((w) => matches(String(w.name), filter))
		.map((w) => ({ name: String(w.name), value: String(w.id) }));
	return { results };
}

export async function searchFolders(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
	const workspaceId = currentWorkspace(this);
	if (!workspaceId) return { results: [] };
	const response = await dosyaRequest.call(this, {
		method: 'GET',
		path: '/api/folders/tree',
		qs: { workspace_id: workspaceId },
		idempotent: true,
	});
	const folders = (response.body.folders as IDataObject[]) ?? [];
	const byId = new Map(folders.map((f) => [String(f.id), f]));
	const results: INodeListSearchItems[] = folders
		.map((f) => ({ name: folderPath(f, byId), value: String(f.id) }))
		.filter((f) => matches(f.name, filter))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (matches('Workspace Root', filter)) results.unshift({ name: 'Workspace Root', value: 'root' });
	return { results };
}

/**
 * Typing a name searches the whole workspace; with nothing typed, the newest
 * files at the workspace root are listed.
 */
export async function searchFiles(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const workspaceId = currentWorkspace(this);
	if (!workspaceId) return { results: [] };
	const page = Number(paginationToken ?? 1) || 1;
	const query = filter?.trim();

	const response = query
		? await dosyaRequest.call(this, {
				method: 'GET',
				path: '/api/search',
				qs: { workspace_id: workspaceId, q: query, page, per_page: SEARCH_PAGE_SIZE },
				idempotent: true,
			})
		: await dosyaRequest.call(this, {
				method: 'GET',
				path: '/api/files',
				qs: { workspace_id: workspaceId, sort: 'newest', page, per_page: SEARCH_PAGE_SIZE },
				idempotent: true,
			});

	const files = (response.body.files as IDataObject[]) ?? [];
	const pagination = (response.body.pagination as IDataObject) ?? {};
	// GET /api/files reports total_pages; GET /api/search reports only total_files.
	const totalPages =
		pagination.total_pages !== undefined
			? Number(pagination.total_pages)
			: Math.ceil(Number(pagination.total_files ?? 0) / SEARCH_PAGE_SIZE);
	return {
		results: files.map((f) => ({ name: String(f.name), value: String(f.id) })),
		paginationToken: files.length > 0 && page < totalPages ? String(page + 1) : undefined,
	};
}
