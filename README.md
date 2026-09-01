# Motion Lab

A local React interface for MiniMax H3 video generation through OpenRouter or a host-installed h3.c engine. The environment API key remains server-only; an optional UI key exists only in volatile tab memory.

The same UI can run MiniMax H3 locally through [antirez/h3.c](https://github.com/antirez/h3.c) on a compatible Mac.

## Docker

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY for OpenRouter mode, or configure local mode below
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000).

## Local development

Node.js 22.12 or newer is required.

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY in .env
npm install
npm run dev
```

Vite runs at [http://localhost:3000](http://localhost:3000) and proxies `/api` to Express on port `3001`.

Generation IDs, video state, reference paths, and prompts are not persisted in browser storage. Each server boot has a new session ID; the UI checks it every three seconds and resets the workspace when the API stops or restarts. This UI reset does not cancel paid OpenRouter work already submitted to the provider.

## Local h3.c generation

Local mode executes the one-shot `h3` CLI and does not use an API key. It requires:

- macOS on Apple Silicon
- A built `h3.c` checkout containing `h3` and `h3_shaders.metal`
- The MiniMax H3 Hugging Face model snapshot
- `ffmpeg` and `ffprobe` on `PATH`, with `libx264` available

Build and verify `h3.c` following its upstream README, then add absolute paths to this app's `.env`:

```dotenv
H3_BINARY=/absolute/path/to/h3.c/h3
H3_MODEL_DIR=/absolute/path/to/MiniMax-H3
# Optional; defaults beside H3_BINARY.
H3_RUNTIME_DIR=/absolute/path/to/h3.c
# Optional; defaults to ./.h3-jobs.
H3_JOBS_DIR=/absolute/path/to/h3-jobs
# Optional local child-process timeout.
H3_TIMEOUT_MINUTES=120
```

Run the app directly with `npm run dev`, or use `npm run build && NODE_ENV=production npm start`. Local mode is unavailable in Docker because the Linux container cannot access macOS Metal. Because local generation intentionally accepts host filesystem paths, the server must remain bound to `127.0.0.1` or `::1`; local mode is disabled for public bind addresses.

The backend runs one generation at a time and accepts at most three waiting jobs. The local presets include exact `576x1024` (`9:16`) output and h3.c's documented 22, 39, 56, 107, 243, and 362-frame durations. The UI also exposes quality, seed, first/last reference frames, and optional SSD streaming presets. When a new local job is successfully accepted, the previous job folder identified by the UI is removed only if that job is completed or failed; active and queued jobs are preserved.

On startup the server acquires an ownership lock for `H3_JOBS_DIR` and removes prior Motion Lab generation folders and staged UUID reference images. An unmarked directory is adopted only when empty (an empty `reference-images` directory is also allowed); a non-empty unmarked directory is rejected rather than cleaned. Graceful `SIGINT`/`SIGTERM` shutdown stops child process groups, removes the same app-owned artifacts, and releases the lock. A crash may leave files temporarily, but the next boot removes them before accepting requests. Unknown files and manually entered reference sources are not touched.

Local first/last frames can be entered as absolute paths to readable PNG, JPEG, or WebP files up to 25 MB. The Browse buttons upload a selected image to `H3_JOBS_DIR/reference-images` and fill that server-owned absolute path into the form. Browsers do not reveal the selected file's original absolute path. Each submitted job validates, copies, and frames its references to the selected output canvas before entering the queue. **Preserve full image** is the default: it keeps every source pixel in proportion and pads the extra canvas required by a different output ratio. **Crop to fill** is an explicit alternative that removes image edges. Both avoid h3.c's native first-frame stretching. Each upload uses a volatile client-generated idempotency and ownership token registered by the server; replacing or clearing that field removes the old staging file atomically by token, and an interrupted response can be retried safely. Path text alone can never authorize deletion, so manually entered files are never deleted. Staged uploads otherwise expire after 24 hours, and the staging area accepts up to 20 unexpired images.

The `h3.c` engine is MIT licensed, but MiniMax H3 weights use a separate community license with territorial and hosting restrictions. Review the model license before downloading, running, or distributing weights or outputs.

## API key selection

- With no key entered in the UI, the server uses `OPENROUTER_API_KEY` from its environment.
- A temporary key entered in the UI takes precedence for new jobs. Each submitted job keeps using the credential choice made at submission even if the draft field is edited later.
- The temporary key exists only in the current tab's React memory. It is sent to the local backend in the `X-OpenRouter-Api-Key` header and is never placed in request bodies, URLs, browser storage, server storage, or logs.
- Session-key video content is fetched through the authenticated local proxy and exposed to the player as a temporary `blob:` URL. The object URL is revoked when the job is cleared, replaced, or the page closes.

Build and run the production server locally:

```bash
npm run build
NODE_ENV=production npm start
```

## API

- `POST /api/video/generate` validates model-specific controls and submits a generation.
- `POST /api/local/reference-image` stores a browsed local reference image and returns its server-owned absolute path.
- `GET /api/video/status/:id` returns the normalized `queued`, `processing`, `completed`, or `failed` state for either provider.
- `GET /api/video/content/:id` securely proxies OpenRouter content or serves a completed local MP4 with range support.

Model capabilities are defined once in `shared/videoModels.ts` and used by both the UI and server validation. Add future models there only after checking their records from OpenRouter's video model endpoint.

## OpenRouter contract

The implementation was checked against the live OpenRouter documentation and model metadata on September 1, 2026:

- [Video generation guide](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
- [Submit video request](https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request)
- [Poll video status](https://openrouter.ai/docs/api/api-reference/video-generation/poll-video-generation-status)
- [Download video content](https://openrouter.ai/docs/api/api-reference/video-generation/download-generated-video-content)
- [Video model capabilities](https://openrouter.ai/api/v1/videos/models)

Hailuo 3 currently advertises `2K`, durations from 5 through 15 seconds, six aspect ratios, native audio, and first/last frame images. The dedicated video API documents public HTTPS image URLs for frame images. It does not document multipart file uploads or base64 data URLs, so this app deliberately requests frame URLs rather than inventing an upload encoding.
