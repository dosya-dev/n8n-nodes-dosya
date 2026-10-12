import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { createFolder, createShareLink, downloadFile, listFiles, uploadFile } from './actions';
import { searchFiles, searchFolders, searchWorkspaces } from './methods';

const WORKSPACE_ID_REGEX = '^ws_[A-Za-z0-9_-]+$';
const FOLDER_ID_REGEX = '^fld_[A-Za-z0-9_-]+$';
const FILE_ID_REGEX = '^file_[A-Za-z0-9_-]+$';

const workspaceLocator: INodeProperties = {
	displayName: 'Workspace',
	name: 'workspace',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The dosya.dev workspace to work in',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchWorkspaces', searchable: true },
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. ws_AbC123',
			validation: [
				{ type: 'regex', properties: { regex: WORKSPACE_ID_REGEX, errorMessage: 'Workspace IDs start with ws_' } },
			],
		},
	],
};

function folderLocator(name: string, displayName: string, description: string): INodeProperties {
	return {
		displayName,
		name,
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		description,
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchFolders', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. fld_AbC123',
				validation: [
					{ type: 'regex', properties: { regex: FOLDER_ID_REGEX, errorMessage: 'Folder IDs start with fld_' } },
				],
			},
		],
	};
}

const fileLocator: INodeProperties = {
	displayName: 'File',
	name: 'file',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description:
		'The file to use. In a workflow, map the file ID from an earlier step, such as the ID an Upload or Get Many step returns.',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchFiles', searchable: true, searchFilterRequired: false },
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. file_AbC123',
			validation: [
				{ type: 'regex', properties: { regex: FILE_ID_REGEX, errorMessage: 'File IDs start with file_' } },
			],
		},
	],
};

const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'File', value: 'file' },
			{ name: 'Folder', value: 'folder' },
			{ name: 'Share Link', value: 'shareLink' },
		],
		default: 'file',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['file'] } },
		options: [
			{
				name: 'Download',
				value: 'download',
				action: 'Download a file',
				description: 'Download a file as binary data for the next steps',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				action: 'Get many files',
				description: 'List the files in a folder or at the workspace root',
			},
			{
				name: 'Upload',
				value: 'upload',
				action: 'Upload a file',
				description: 'Upload binary data from an earlier step as a file',
			},
		],
		default: 'upload',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['folder'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a folder',
				description: 'Create a folder, or reuse it if one with that name already exists',
			},
		],
		default: 'create',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['shareLink'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a share link',
				description: 'Create a link that lets anyone with it open a file or folder',
			},
		],
		default: 'create',
	},

	// Workspace. Required where dosya.dev needs it; for Download and Share
	// Link the target's own ID is enough, and the workspace only scopes the
	// "From List" pickers, so a mapped ID works without choosing one.
	{
		...workspaceLocator,
		displayOptions: { show: { resource: ['file', 'folder'], operation: ['upload', 'getMany', 'create'] } },
	},
	{
		...workspaceLocator,
		required: false,
		description: 'Only used to browse files and folders in the lists below. Not needed when you enter or map an ID.',
		displayOptions: { show: { resource: ['file', 'shareLink'], operation: ['download', 'create'] } },
	},

	// ---------------------------------------------------------------- File: Upload
	{
		...folderLocator(
			'folder',
			'Folder',
			'The folder to upload into. Leave empty, or choose Workspace Root, to upload to the top level of the workspace.',
		),
		displayOptions: { show: { resource: ['file'], operation: ['upload', 'getMany'] } },
	},
	{
		displayName: 'Input Data Field Name',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
		description:
			'The name of the field that holds the file in the incoming item. Open the previous step\'s output, switch to the Binary tab, and copy the name shown above the file (often "data", or "attachment_0" for Gmail).',
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		default: '',
		placeholder: 'e.g. invoice-2026-10.pdf',
		displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
		description:
			'Leave empty to keep the incoming file\'s name. If a file with this name already exists in the folder, dosya.dev stores the upload as a new version of it instead of creating a second file.',
	},

	// -------------------------------------------------------------- File: Download
	{
		...fileLocator,
		displayOptions: { show: { resource: ['file'], operation: ['download'] } },
	},
	{
		displayName: 'Output Data Field Name',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		displayOptions: { show: { resource: ['file'], operation: ['download'] } },
		description: 'The name of the binary field the downloaded file is put in, for the next steps to use',
	},

	// -------------------------------------------------------------- File: Get Many
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['file'], operation: ['getMany'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		displayOptions: { show: { resource: ['file'], operation: ['getMany'], returnAll: [false] } },
		description: 'Max number of results to return',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { resource: ['file'], operation: ['getMany'] } },
		options: [
			{
				displayName: 'Include Subfolders in Output',
				name: 'includeFolders',
				type: 'boolean',
				default: false,
				description:
					'Whether to also return the folder\'s subfolders, as items with type "folder". Their contents are not listed.',
			},
			{
				displayName: 'Sort By',
				name: 'sort',
				type: 'options',
				default: 'newest',
				options: [
					{ name: 'Largest First', value: 'largest' },
					{ name: 'Name', value: 'name' },
					{ name: 'Newest First', value: 'newest' },
					{ name: 'Oldest First', value: 'oldest' },
					{ name: 'Smallest First', value: 'smallest' },
				],
			},
		],
	},

	// ------------------------------------------------------------- Folder: Create
	{
		...folderLocator(
			'folder',
			'Parent Folder',
			'Where to create the folder. Leave empty, or choose Workspace Root, to create it at the top level.',
		),
		displayOptions: { show: { resource: ['folder'], operation: ['create'] } },
	},
	{
		displayName: 'Folder Name',
		name: 'name',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. Acme Ltd',
		displayOptions: { show: { resource: ['folder'], operation: ['create'] } },
		description:
			'The name of the folder. Slashes create nested folders, so "Clients/Acme" creates Acme inside Clients. A folder that already exists is reused, never duplicated.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { resource: ['folder'], operation: ['create'] } },
		options: [
			{
				displayName: 'Replace Slashes With Dashes',
				name: 'slashesInName',
				type: 'boolean',
				default: false,
				description:
					'Whether to turn "/" and "\\" in the name into "-" so it always creates a single folder. Turn this on when the name comes from customer data, such as "A/B Trading".',
			},
		],
	},

	// --------------------------------------------------------- Share Link: Create
	{
		displayName: 'Share',
		name: 'shareTarget',
		type: 'options',
		default: 'file',
		displayOptions: { show: { resource: ['shareLink'], operation: ['create'] } },
		options: [
			{ name: 'File', value: 'file' },
			{ name: 'Folder', value: 'folder' },
		],
		description: 'Whether to share a single file or a whole folder',
	},
	{
		...fileLocator,
		displayOptions: { show: { resource: ['shareLink'], operation: ['create'], shareTarget: ['file'] } },
	},
	{
		...folderLocator('shareFolder', 'Folder', 'The folder to share'),
		required: true,
		displayOptions: { show: { resource: ['shareLink'], operation: ['create'], shareTarget: ['folder'] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { resource: ['shareLink'], operation: ['create'] } },
		options: [
			{
				displayName: 'Access Code',
				name: 'accessCode',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description:
					'A code of at least 8 characters that anyone opening the link must type. This is not your dosya.dev password.',
			},
			{
				displayName: 'Expires In Days',
				name: 'expiresInDays',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 0,
				description:
					'How many days the link works for. 0 uses your workspace default. On the Free plan links last at most 7 days.',
			},
			{
				displayName: 'View Only',
				name: 'viewOnly',
				type: 'boolean',
				default: false,
				description: 'Whether recipients can only preview in the browser, without downloading',
			},
		],
	},
];

/** Errors this node raised already say what happened; anything else is wrapped. */
function asNodeError(context: IExecuteFunctions, error: unknown, itemIndex: number): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeOperationError(context.getNode(), error as Error, { itemIndex });
}

export class Dosya implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'dosya.dev',
		name: 'dosya',
		icon: { light: 'file:dosya.svg', dark: 'file:dosya.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Upload, download, organise and share files in dosya.dev cloud storage',
		defaults: { name: 'dosya.dev' },
		// Upload needs binary input, which an AI agent cannot supply; the other
		// operations work as tools.
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'dosyaApi', required: true }],
		properties,
	};

	methods = {
		listSearch: { searchWorkspaces, searchFolders, searchFiles },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'file' && operation === 'upload') {
					returnData.push(await uploadFile.call(this, i));
				} else if (resource === 'file' && operation === 'download') {
					returnData.push(await downloadFile.call(this, i));
				} else if (resource === 'file' && operation === 'getMany') {
					returnData.push(...(await listFiles.call(this, i)));
				} else if (resource === 'folder' && operation === 'create') {
					returnData.push(await createFolder.call(this, i));
				} else if (resource === 'shareLink' && operation === 'create') {
					returnData.push(await createShareLink.call(this, i));
				} else {
					throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw asNodeError(this, error, i);
			}
		}
		return [returnData];
	}
}
