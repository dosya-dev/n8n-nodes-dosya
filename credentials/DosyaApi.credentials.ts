import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { version } from '../package.json';

export class DosyaApi implements ICredentialType {
	name = 'dosyaApi';

	displayName = 'dosya.dev API';

	icon: Icon = { light: 'file:../nodes/Dosya/dosya.svg', dark: 'file:../nodes/Dosya/dosya.dark.svg' };

	documentationUrl = 'https://github.com/dosya-dev/n8n-nodes-dosya#credentials';

	properties: INodeProperties[] = [
		{
			displayName:
				'Create an API key in dosya.dev under Profile > API keys (https://app.dosya.dev/profile/api). Choose Full access scope and leave the folder anchor empty. You can pin the key to one workspace to limit what it reaches. Never paste your dosya.dev password here.',
			name: 'notice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// GET /api/me is the cheapest authenticated call. A read-only key passes
	// it, so that case is caught by the rule below; an upload-only key is
	// refused outright with a message that names its scope.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.dosya.dev',
			url: '/api/me',
			headers: { 'User-Agent': `n8n-nodes-dosya/${version}` },
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'user.api_key_scope',
					value: 'read',
					message:
						'This key is read-only. Uploads, folders and share links need a key with Full access scope.',
				},
			},
		],
	};
}
