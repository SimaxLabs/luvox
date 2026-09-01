# Motion Lab

A local React interface for asynchronous video generation through OpenRouter, configured by default for `minimax/hailuo-3`. The API key is read only by the Express server and is never included in the browser bundle or API responses.

## Docker

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY in .env
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

Active generation IDs are kept in browser storage so polling resumes after a reload. Stopping an active watch does not cancel provider work because OpenRouter does not currently document a cancellation endpoint.

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
- `GET /api/video/status/:id` returns the normalized `queued`, `processing`, `completed`, or `failed` state.
- `GET /api/video/content/:id` securely proxies the authenticated OpenRouter video stream for preview and download.

Model capabilities are defined once in `shared/videoModels.ts` and used by both the UI and server validation. Add future models there only after checking their records from OpenRouter's video model endpoint.

## OpenRouter contract

The implementation was checked against the live OpenRouter documentation and model metadata on September 1, 2026:

- [Video generation guide](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
- [Submit video request](https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request)
- [Poll video status](https://openrouter.ai/docs/api/api-reference/video-generation/poll-video-generation-status)
- [Download video content](https://openrouter.ai/docs/api/api-reference/video-generation/download-generated-video-content)
- [Video model capabilities](https://openrouter.ai/api/v1/videos/models)

Hailuo 3 currently advertises `2K`, durations from 5 through 15 seconds, six aspect ratios, native audio, and first/last frame images. The dedicated video API documents public HTTPS image URLs for frame images. It does not document multipart file uploads or base64 data URLs, so this app deliberately requests frame URLs rather than inventing an upload encoding.
