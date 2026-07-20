# Ingest Callback API

## Overview

The UNESCAP Orchestra backend now accepts callbacks from MCP servers to track the status of document ingestion jobs. When an MCP server finishes processing a document (extracting, converting to markdown, and ingesting into Chroma), it sends a POST request to the orchestra's callback endpoint with job metadata and results.

## Database Schema

### Job Entity (`jobs` table)

| Column | Type | Description |
|--------|------|-------------|
| `jobId` | varchar(255) | Primary key — job ID from MCP server |
| `sessionId` | varchar(255) | Client session ID (nullable) |
| `status` | varchar(50) | `pending`, `processing`, `done`, `partial`, or `failed` |
| `source` | varchar(255) | Versioned source (e.g., `PP-2024-456_v1`) |
| `version` | int | Version number (default: 1) |
| `docId` | varchar(255) | Chroma document ID (nullable) |
| `collection` | varchar(100) | Chroma collection name (nullable) |
| `pagesTotal` | int | Total pages in document (nullable) |
| `pagesDone` | int | Pages successfully processed (default: 0) |
| `pagesViaVlm` | int | Pages processed via VLM (default: 0) |
| `pagesViaPdfplumber` | int | Pages processed via pdfplumber (default: 0) |
| `pagesFailed` | int | Pages that failed processing (default: 0) |
| `durationSec` | float | Processing duration in seconds (nullable) |
| `markdownPath` | text | Path to exported markdown file (nullable) |
| `error` | text | Error message if status is `failed` (nullable) |
| `createdAt` | timestamptz | Creation timestamp |
| `updatedAt` | timestamptz | Last update timestamp |

## API Endpoints

### POST `/api/ingest/callback`

Accepts callback from MCP server with job update.

**Request Body** (CallbackPayload):

```json
{
  "session_id": "client-session-123",
  "job_id": "job_abc123",
  "status": "done",
  "source": "PP-2024-456_v1",
  "version": 1,
  "doc_id": "7f3a...",
  "collection": "regulations",
  "pages_total": 45,
  "pages_done": 45,
  "pages_via_vlm": 12,
  "pages_via_pdfplumber": 33,
  "pages_failed": 0,
  "duration_sec": 87.34,
  "markdown_path": "./markdown_exports/7f3a.../PP-2024-456_v1.md",
  "error": null
}
```

**Response** (Success):

```json
{
  "success": true,
  "job_id": "job_abc123",
  "status": "done",
  "updated_at": "2026-07-20T10:30:45.123Z"
}
```

**Response** (Error):

```json
{
  "error": "Missing required fields: job_id and status are required"
}
```

**Status Codes**:
- `200` — Job updated successfully
- `400` — Missing required fields (`job_id` or `status`)
- `500` — Server error during update

**Behavior**:
- If job does not exist → creates new job entry
- If job exists → updates all fields except `jobId`, `sessionId`, `source`, `version`
- Logs job update to console: `[callback] Job {jobId} updated: {status} ({pagesDone}/{pagesTotal} pages)`

### GET `/api/ingest/jobs`

List all ingest jobs, optionally filtered by session ID.

**Query Parameters**:
- `session_id` (optional) — Filter jobs by client session ID

**Response**:

```json
{
  "count": 2,
  "jobs": [
    {
      "jobId": "job_abc123",
      "sessionId": "client-session-123",
      "status": "done",
      "source": "PP-2024-456_v1",
      "version": 1,
      "docId": "7f3a...",
      "collection": "regulations",
      "pagesTotal": 45,
      "pagesDone": 45,
      "pagesViaVlm": 12,
      "pagesViaPdfplumber": 33,
      "pagesFailed": 0,
      "durationSec": 87.34,
      "markdownPath": "./markdown_exports/7f3a.../PP-2024-456_v1.md",
      "error": null,
      "createdAt": "2026-07-20T10:28:00.000Z",
      "updatedAt": "2026-07-20T10:30:45.123Z"
    }
  ]
}
```

**Examples**:

```bash
# List all jobs
curl http://localhost:3000/api/ingest/jobs

# List jobs for specific session
curl http://localhost:3000/api/ingest/jobs?session_id=client-session-123
```

## Database Functions

### `updateJobFromCallback(payload: CallbackPayload): Promise<Job>`

Creates or updates a job from a callback payload.

- **Upsert semantics**: Creates if `job_id` doesn't exist, updates otherwise
- **Returns**: The saved Job entity

### `getJob(jobId: string): Promise<Job | null>`

Retrieves a single job by ID.

### `listJobs(sessionId?: string): Promise<Job[]>`

Lists all jobs, optionally filtered by session ID. Results are ordered by `createdAt DESC`.

## Integration with MCP Servers

MCP servers should send a callback when:
1. Document ingestion starts (`status: "processing"`)
2. Document ingestion completes successfully (`status: "done"`)
3. Document ingestion partially succeeds (`status: "partial"`)
4. Document ingestion fails (`status: "failed"`, include `error` field)

**Example curl command** (from MCP server):

```bash
curl -X POST http://localhost:3000/api/ingest/callback \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "client-session-123",
    "job_id": "job_abc123",
    "status": "done",
    "source": "PP-2024-456_v1",
    "version": 1,
    "doc_id": "7f3a...",
    "collection": "regulations",
    "pages_total": 45,
    "pages_done": 45,
    "pages_via_vlm": 12,
    "pages_via_pdfplumber": 33,
    "pages_failed": 0,
    "duration_sec": 87.34,
    "markdown_path": "./markdown_exports/7f3a.../PP-2024-456_v1.md",
    "error": null
  }'
```

## Files Modified

1. **`src/db/entities/Job.ts`** — New TypeORM entity for jobs table
2. **`src/db/data-source.ts`** — Added Job entity to TypeORM DataSource
3. **`src/db/client.ts`** — Added job management functions:
   - `updateJobFromCallback()`
   - `getJob()`
   - `listJobs()`
4. **`src/index.ts`** — Added two new routes:
   - `POST /api/ingest/callback`
   - `GET /api/ingest/jobs`

## Testing

```bash
# 1. Start the backend
npm run dev

# 2. Test callback endpoint
curl -X POST http://localhost:3000/api/ingest/callback \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test-session",
    "job_id": "test-job-001",
    "status": "done",
    "source": "TEST-2024-001_v1",
    "version": 1,
    "doc_id": "test-doc-123",
    "collection": "test-collection",
    "pages_total": 10,
    "pages_done": 10,
    "pages_via_vlm": 3,
    "pages_via_pdfplumber": 7,
    "pages_failed": 0,
    "duration_sec": 12.5,
    "markdown_path": "./test.md",
    "error": null
  }'

# 3. List all jobs
curl http://localhost:3000/api/ingest/jobs

# 4. List jobs for specific session
curl http://localhost:3000/api/ingest/jobs?session_id=test-session
```

## Notes

- The `jobs` table is created automatically via TypeORM's `synchronize: true` setting
- Jobs are never deleted automatically — they accumulate for audit trail
- The `sessionId` field links jobs to client sessions but is nullable (MCP server can omit it)
- All lint errors in the response are pre-existing TypeScript decorator issues and do not affect runtime
