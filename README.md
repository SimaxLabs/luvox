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

Active generation IDs are kept in browser storage so polling resumes after a reload. A temporary OpenRouter key must be re-entered after reload. Stopping a watch does not cancel paid OpenRouter work or a running local h3.c process.

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

Run the app directly with `npm run dev`, or use `npm run build && NODE_ENV=production npm start`. Local mode is unavailable in Docker because the Linux container cannot access macOS Metal.

The backend runs one generation at a time and accepts at most three waiting jobs. The UI intentionally exposes only canvas, clip length, quality, seed, and optional SSD streaming presets. Outputs remain in `H3_JOBS_DIR`; local job status is held in server memory and is lost on restart.

The `h3.c` engine is MIT licensed, but MiniMax H3 weights use a separate community license with territorial and hosting restrictions. Review the model license before downloading, running, or distributing weights or outputs.

## API key selection

- With no key entered in the UI, the server uses `OPENROUTER_API_KEY` from its environment.
- A temporary key entered in the UI takes precedence for generation, polling, preview, and download requests.
- The temporary key exists only in the current tab's React memory. It is sent to the local backend in the `X-OpenRouter-Api-Key` header and is never placed in request bodies, URLs, browser storage, server storage, or logs.
- Session-key video content is fetched through the authenticated local proxy and exposed to the player as a temporary `blob:` URL. The object URL is revoked when the key, job, or page changes.

Build and run the production server locally:

```bash
npm run build
NODE_ENV=production npm start
```

## API

- `POST /api/video/generate` validates model-specific controls and submits a generation.
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
