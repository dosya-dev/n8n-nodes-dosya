import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { DosyaApi } from '../credentials/DosyaApi.credentials';
import { Dosya } from '../nodes/Dosya/Dosya.node';
import { PACKAGE_VERSION, USER_AGENT } from '../nodes/Dosya/transport';

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return path.endsWith('.ts') ? [path] : [];
	});
}

describe('package', () => {
	it('keeps the user agent version in step with package.json', () => {
		expect(PACKAGE_VERSION).toBe(pkg.version);
		expect(USER_AGENT).toBe(`n8n-nodes-dosya/${pkg.version}`);
		expect(new DosyaApi().test.request.headers).toEqual({ 'User-Agent': USER_AGENT });
	});

	it('has no runtime dependencies and only n8n-workflow as a peer', () => {
		expect(pkg.dependencies ?? {}).toEqual({});
		expect(pkg.peerDependencies).toEqual({ 'n8n-workflow': '*' });
		expect(pkg.license).toBe('MIT');
		expect(pkg.keywords).toContain('n8n-community-node-package');
	});

	it('ships source that reads no environment variables, files or timers', () => {
		const files = [...sourceFiles(join(root, 'nodes')), ...sourceFiles(join(root, 'credentials'))];
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const text = readFileSync(file, 'utf8');
			expect(text, file).not.toMatch(/process\.env|from ['"](node:)?fs['"]|require\(|setTimeout|child_process/);
		}
	});
});

describe('credential', () => {
	const credential = new DosyaApi();

	it('stores only an API key, as a password field', () => {
		const fields = credential.properties.filter((p) => p.type !== 'notice');
		expect(fields).toHaveLength(1);
		expect(fields[0]).toMatchObject({ name: 'apiKey', typeOptions: { password: true }, required: true });
		expect(JSON.stringify(credential.properties).toLowerCase()).toContain('never paste your dosya.dev password');
	});

	it('sends the key as a bearer token and tests it against /api/me', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
		});
		expect(credential.test.request).toMatchObject({ baseURL: 'https://api.dosya.dev', url: '/api/me' });
	});
});

describe('node description', () => {
	const description = new Dosya().description;

	it('offers exactly the five first-release operations', () => {
		const ops = description.properties
			.filter((p) => p.name === 'operation')
			.flatMap((p) => (p.options as Array<{ value: string }>).map((o) => `${p.displayOptions?.show?.resource?.[0]}:${o.value}`));
		expect(ops.sort()).toEqual(['file:download', 'file:getMany', 'file:upload', 'folder:create', 'shareLink:create']);
	});

	it('uses the credential it declares', () => {
		expect(description.credentials).toEqual([{ name: 'dosyaApi', required: true }]);
	});
});
