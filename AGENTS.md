# Repository Guide

## Commands

- Use Node.js `>=22.12.0` and the npm lockfile. Use `npm ci` for a clean install; use `npm install` when intentionally changing dependencies.
- `npm run dev` starts Vite on `127.0.0.1:3000` and Express via `tsx watch` on `127.0.0.1:3001`; Vite proxies `/api` to Express.
- Run `npm run typecheck` for focused verification. Run `npm run build` before finishing; it repeats both TypeScript checks, builds the Vite client to `dist/`, and compiles the server to `dist-server/`.
- There are currently no test, lint, formatter, codegen, or CI commands. Do not claim those checks ran.
- `npm start` alone does not serve the production UI. Run `npm run build`, then `NODE_ENV=production npm start` so Express serves `dist/` on port 3000.

## Architecture

- `src/` is the React client; it must call only the local `/api` routes. `server/index.ts` dispatches provider-neutral routes. Keep OpenRouter HTTP/auth logic in `server/openrouter.ts` and h3.c process/queue logic in `server/localH3.ts`.
- `shared/videoModels.ts` is the single capability registry used by both UI controls and server validation. Add or change model options there rather than duplicating capability checks.
- Client TypeScript uses bundler resolution, while server TypeScript uses NodeNext. Relative imports in `server/` must use emitted `.js` suffixes even though the sources are `.ts`.
- Tailwind is v4 through `@tailwindcss/vite` and `src/styles.css`; there is intentionally no `tailwind.config.*` or PostCSS config.

## OpenRouter Constraints

- The environment `OPENROUTER_API_KEY` is server-only via `dotenv/config` and must never be returned to the client. A user-entered override may exist only in volatile React state and the local `X-OpenRouter-Api-Key` request header; pin that override to its submitted job in volatile state so later edits cannot change job authentication. Never put either key in payloads, URLs, logs, browser storage, or server storage.
- Before changing requests or capabilities, re-check the official sources linked under `README.md`'s OpenRouter contract. Use the dedicated asynchronous `/api/v1/videos` API; do not infer chat-completions fields or provider fields.
- Hailuo 3 currently accepts public HTTPS first/last-frame URLs through `frame_images`. Do not add multipart, local-file, or base64 submission unless the dedicated video-generation docs explicitly add support.
- Provider `pending` and `in_progress` map to local `queued` and `processing`; `failed`, `cancelled`, and `expired` map to local `failed`. Polling transport/auth errors are not proof that provider generation failed.
- Preview and download must stay behind `/api/video/content/:id`; that server proxy attaches authentication and forwards range headers. With a temporary key, the client fetches this route and creates a revocable `blob:` URL. Do not expose credentials in media URLs or assume `unsigned_urls` are permanently public.
- OpenRouter documents no cancellation endpoint. Jobs and prompts are deliberately not persisted; the client clears its workspace when the API stops or its per-boot session ID changes. This does not stop paid provider work already submitted to OpenRouter.
- Never exercise generation in a smoke test with an inherited shell key. Set `OPENROUTER_API_KEY=` explicitly for local error-path tests; a valid submission can incur cost immediately.

## Container Runtime

- Compose reads the untracked `.env`, listens only on host `127.0.0.1:3000`, and sets container `HOST=0.0.0.0`. Preserve that split so the local paid API is not exposed to the LAN by default.
- The runtime image contains only production dependencies plus `dist/` and `dist-server/`; server runtime imports must not depend on devDependencies or source files.

## Local h3.c Constraints

- Local mode is a macOS/Apple-Silicon host feature and cannot work inside the Linux Docker image. It requires a loopback-only server bind plus absolute `H3_BINARY` and `H3_MODEL_DIR` paths; `H3_RUNTIME_DIR` defaults beside the binary so `h3_shaders.metal` can be loaded.
- `h3.c` has no HTTP mode. `server/localH3.ts` deliberately spawns the one-shot CLI with an argument array and `shell: false`, owns all output paths under `.h3-jobs`/`H3_JOBS_DIR`, and serializes/caps jobs to avoid duplicate model residency. The server locks this directory and removes app-owned job/reference artifacts on startup and graceful shutdown. Preserve those boundaries and do not pass the full server environment to the child.
- Keep local controls preset-based through `shared/localH3.ts`; do not expose h3.c diagnostic flags directly in the UI. Local first/last-frame paths must be absolute and readable; browsed PNG, JPEG, and WebP files are copied into `H3_JOBS_DIR` and framed to the selected canvas with server-controlled FFmpeg filters, never passed to h3.c from browser-controlled paths. Reference cleanup requires a volatile server-registered ownership token and may delete only UUID-named files in the server-owned staging directory; never delete a manually entered source path.
- Never run h3.c generation as a smoke test: it can consume substantial unified memory and time. Safe checks should use missing/invalid local configuration paths.
- h3.c engine code is MIT, but model weights have separate territorial and hosting restrictions. Do not download, redistribute, or bundle weights with this repository.
