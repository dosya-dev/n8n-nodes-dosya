# n8n-nodes-dosya

An [n8n](https://n8n.io) community node for [dosya.dev](https://dosya.dev) cloud storage. Use it to save files from your workflows into a dosya.dev workspace, download them again, list a folder, create folders, and create share links.

- [Installation](#installation)
- [Credentials](#credentials)
- [Operations](#operations)
- [Example workflows](#example-workflows)
- [How the node handles files](#how-the-node-handles-files)
- [Limits](#limits)
- [Compared with the S3 node](#compared-with-the-s3-node)
- [Compatibility](#compatibility)
- [Development](#development)

## Installation

In n8n, open **Settings > Community Nodes > Install**, enter `n8n-nodes-dosya`, and confirm. See n8n's [community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) for self-hosted setups.

## Credentials

The node signs in with a dosya.dev **API key**. It never asks for your dosya.dev password.

1. Sign in at [app.dosya.dev](https://app.dosya.dev). If you do not have an account yet, [create one](https://app.dosya.dev/sign-up).
2. Open **Profile > API keys** ([app.dosya.dev/profile/api](https://app.dosya.dev/profile/api)) and create a key:
   - **Scope: Full access.** Read-only keys cannot upload, create folders or create share links, and upload-only keys cannot list or download.
   - **Folder anchor: none.** Folder-anchored keys only work over WebDAV and S3.
   - Optional: pin the key to one workspace to limit what it can reach.
   - Naming the key "n8n" makes it easy to find and revoke later.
3. In n8n, create a **dosya.dev API** credential and paste the key. n8n tests it against your account straight away.

The key is stored in n8n's encrypted credential store and sent only to `https://api.dosya.dev`. Downloads are fetched from a short-lived signed link without the key.

## Operations

| Resource | Operation | What it does |
|---|---|---|
| File | Upload | Uploads binary data from an earlier step. Returns the file ID, name, size, type and version. |
| File | Download | Downloads a file into a binary field for the next steps. |
| File | Get Many | Lists the files in a folder or at the workspace root, with optional subfolders. |
| Folder | Create | Creates a folder, or returns the existing one if the name is already taken. |
| Share Link | Create | Creates a link to a file or folder, with optional expiry, access code and view-only mode. Returns the URL. |

Workspaces, folders and files can be picked from a list or entered by ID (`ws_...`, `fld_...`, `file_...`). In a workflow you will usually map the ID from an earlier step, for example the `id` an Upload step returns.

### Choosing the incoming file (Input Data Field Name)

Upload reads the file from a binary field of the incoming item. To find its name, open the previous step's output, switch to the **Binary** tab, and copy the name shown above the file. Common values are `data` (HTTP Request, Read/Write Files from Disk, Convert to File) and `attachment_0`, `attachment_1`, ... (Gmail Trigger with attachments downloaded). Example 1 below shows how to upload every attachment of an email.

### Output fields

- **Upload:** `id`, `name`, `size` (bytes), `mime_type`, `version`, `is_new_version`, `workspace_id`, `folder_id` (`null` for the root), `created_at`, `hash_verified`, `deduplicated`, `upload_method`
- **Download:** `id`, `name`, `size`, `mime_type`, plus the file in the binary field you name
- **Get Many:** one item per entry with `type` (`file` or `folder`), `id`, `name`, `size`, `mime_type`, `extension`, `version`, `workspace_id`, `folder_id`, `created_at`, `updated_at`
- **Create Folder:** `id`, `name`, `parent_id`, `workspace_id`, `created` (false when an existing folder was reused), `created_count`
- **Create Share Link:** `id`, `url`, `target_type`, `target_id`, `expires_at`, `view_only`, `access_code_required`, `access_mode`, `created_at`

## Example workflows

Importable workflows are in [`examples/`](examples). In n8n, use **Workflows > Import from File**, then pick your dosya.dev credential, workspace and folder in each dosya.dev node. None of them contain keys, IDs or personal data.

1. **[Archive Gmail attachments](examples/01-archive-gmail-attachments.json)**: every email with attachments that arrives in Gmail has its attachments saved to a dosya.dev folder. Needs a Gmail credential.
2. **[Store and share a PDF](examples/02-store-and-share-pdf.json)**: a PDF sent to a webhook (stand-in for whatever generates your PDF) is uploaded, a 7-day share link is created, the link is emailed, and the webhook answers with the link. Needs an SMTP credential for the email step.
3. **[Create a client folder](examples/03-create-client-folder.json)**: customer data posted to a webhook creates a folder named after the customer inside a "Clients" folder, and the webhook answers with the folder ID. Running it twice for the same customer reuses the folder.

Each file's `notes` and sticky notes explain its setup and how to test it with `curl`.

## How the node handles files

- **Binary data** is read and written through n8n's binary-data helpers, so it works whether n8n keeps binary data in memory, on disk or in S3. The node never reads environment variables or touches the file system itself.
- **Files up to 50 MB** are sent in one request with a SHA-256 checksum; dosya.dev verifies the bytes and the output shows `hash_verified: true`.
- **Files over 50 MB** are sent in 10 MB parts and then finalised. When n8n stores binary data outside memory, the file is streamed part by part and never held in memory whole.
- **Names** are kept as they are, including spaces, accents, non-Latin scripts and symbols such as `&`, `#` and `+`. dosya.dev removes `/`, `\` and control characters from file names. If a name has no extension, the incoming file's extension is added, because dosya.dev sets a file's type from its extension.
- **Same name, same folder:** dosya.dev keeps one file and stores the new upload as its next version (`is_new_version: true`). It does not create "file (1).pdf".
- **Download types:** the file type of a download is taken from its name.

### Retries and duplicates

The node retries on its own only where repeating cannot create a duplicate:

| Situation | What the node does |
|---|---|
| dosya.dev answers 429 (rate limited) | Waits for `Retry-After` (up to 30 seconds) and retries, at most 3 attempts. dosya.dev refuses these before doing any work, so this is safe for every operation. A longer wait, such as a daily transfer limit, is reported instead, with how long to wait. |
| Timeout, dropped connection, 502/503/504 | Retried for reads, folder creation (an existing folder is reused) and upload parts. |
| Upload of a file up to 50 MB | Sent with an idempotency key derived from the execution, node, destination, name and content. If the same item is sent again in the same execution, for example by n8n's **Retry On Fail**, dosya.dev returns the first upload (`deduplicated: true`) instead of storing it again. |
| Create Share Link | Never repeated after an ambiguous failure, because each call creates a new link. The error tells you to check dosya.dev before running the step again. |

Running a workflow again is a new execution, so it uploads again (as a new version of a same-named file) and creates a new share link.

## Limits

These come from dosya.dev and your plan, not from the node:

- **Storage:** uploads stop when the workspace owner's plan is full. The error names the limit and how to free space or upgrade at [app.dosya.dev/billing](https://app.dosya.dev/billing). See [dosya.dev/pricing](https://dosya.dev/pricing) for plans.
- **Free plan:** at most 5 active share links at a time, share links last at most 7 days, and downloads are capped per day.
- **Per-file size:** a plan, a workspace or an API key can set a maximum file size.
- **Request rate:** rate-limited requests are retried as described above.
- **Memory:** a file up to 50 MB is held in memory once while it is sent. Larger files use about 10 MB at a time when n8n stores binary data on disk or in S3 (`N8N_DEFAULT_BINARY_DATA_MODE=filesystem` or `s3`). In n8n's default in-memory mode the whole file is already in memory before this node runs, so very large files need that setting changed. Downloads are streamed into n8n's binary store.
- **Vault:** files in end-to-end encrypted Vault spaces are transferred as stored; the node does not decrypt them.
- **Not included in this release:** deleting, moving or renaming, sync, triggers on new files, and file requests.

## Compared with the S3 node

dosya.dev also speaks S3 at `https://api.dosya.dev/s3`, so n8n's built-in **S3** node can upload, download, list and delete objects using an S3 key from the same API keys page (bucket = workspace ID). Use the S3 node if you need deletion or are already set up for S3.

This node adds what S3 cannot express: picking workspaces and folders by name, share links with expiry, access codes and view-only mode, reuse of existing folders, versions on same-name uploads, integrity-checked uploads, and errors that say what to do (for example, which plan limit was hit).

## Compatibility

Built and tested with n8n 2.42 (`n8n-workflow` 2.42.4) and Node.js 22.

## Development

```bash
npm install
npm run build      # n8n-node build
npm run lint       # n8n's community-node rules
npm test           # unit tests, all HTTP mocked
npm run dev        # n8n with this node, hot reloading
```

`npm run test:live` runs the same operations against the real dosya.dev API. It needs `DOSYA_LIVE_API_KEY` (a full-access key on a **test** account) and `DOSYA_LIVE_WORKSPACE`, and creates and then removes a folder named `n8n-live-<timestamp>`.

The node sends `User-Agent: n8n-nodes-dosya/<version>` so dosya.dev support can tell which client a request came from. It collects no telemetry and makes no requests other than the ones each operation needs.

## License

[MIT](LICENSE.md)
