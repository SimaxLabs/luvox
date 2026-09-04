# Repository Guide

## Commands

- Use Node.js `>=22.12.0` and the npm lockfile. Use `npm ci` for a clean install; use `npm install` when intentionally changing dependencies.
- `npm run dev` starts Vite on `127.0.0.1:3000` and Express via `tsx watch` on `127.0.0.1:3001`; Vite proxies `/api` to Express.
- Run `npm test` for the small local-engine contract checks and `npm run typecheck` for focused verification. Run `npm run build` before finishing; it repeats both TypeScript checks, builds the Vite client to `dist/`, and compiles the server to `dist-server/`.
- There are currently no lint, formatter, codegen, or CI commands. Do not claim those checks ran.
- `npm start` alone does not serve the production UI. Run `npm run build`, then `NODE_ENV=production npm start` so Express serves `dist/` on port 3000.

## Architecture

- `src/` is the React client; it must call only the local `/api` routes. `server/index.ts` dispatches provider-neutral routes. Keep OpenRouter HTTP/auth logic in `server/openrouter.ts`, MFLUX process logic in `server/localMflux.ts`, and h3.c process/queue logic in `server/localH3.ts`.
- `shared/imageModels.ts` and `shared/videoModels.ts` define immutable OpenRouter built-ins. `server/openrouterModels.ts` strictly validates and merges additive custom JSON definitions for both UI controls and server validation; do not duplicate capability checks or allow custom models to replace built-ins.
- Client TypeScript uses bundler resolution, while server TypeScript uses NodeNext. Relative imports in `server/` must use emitted `.js` suffixes even though the sources are `.ts`.
- Tailwind is v4 through `@tailwindcss/vite` and `src/styles.css`; there is intentionally no `tailwind.config.*` or PostCSS config.

## Session Job Concurrency

- Give every generation type its own independent per-tab slot. Different types may overlap, but never allow a second pending, queued, or processing job of the same type; OpenRouter video and local h3.c video count as separate types.
- A slot unlocks only on completion or failure. A stopped poll is not terminal; an unknown paid submission keeps the existing ambiguity lock, and an unknown local submission keeps the local slot locked until Clear.
- Apply the same slot lifecycle when adding a generation option. Keep each pending request's controller, form values, credentials, and remote-work marker independent. Workflows without a resumable provider job ID, such as Muse image generation, use only a volatile client task in Session jobs.

## OpenRouter Constraints

- The environment `OPENROUTER_API_KEY` is server-only via Node's `--env-file-if-exists` and must never be returned to the client. A user-entered override may exist only in volatile React state and the local `X-OpenRouter-Api-Key` request header; pin that override to its submitted job in volatile state so later edits cannot change job authentication. Never put either key in payloads, URLs, logs, browser storage, or server storage.
- Before changing requests or capabilities, re-check the official sources linked under `README.md`'s OpenRouter contract. Use the dedicated asynchronous `/api/v1/videos` API; do not infer chat-completions fields or provider fields.
- Hailuo 3 currently accepts public HTTPS first/last-frame URLs through `frame_images`. Do not add multipart, local-file, or base64 submission unless the dedicated video-generation docs explicitly add support.
- Provider `pending` and `in_progress` map to local `queued` and `processing`; `failed`, `cancelled`, and `expired` map to local `failed`. Polling transport/auth errors are not proof that provider generation failed.
- Preview and download must stay behind `/api/video/content/:id`; that server proxy attaches authentication and forwards range headers. Temporary-key jobs use their pinned key, while server-key jobs use an independent volatile per-job capability in `X-Luvox-Video-Token` with a 24-hour idle expiry. The client fetches protected media and creates a revocable `blob:` URL. Never put either credential in media URLs or assume `unsigned_urls` are permanently public.
- OpenRouter documents no cancellation endpoint. Jobs and prompts are deliberately not persisted; the client clears its workspace when the API stops or its per-boot session ID changes. This does not stop paid provider work already submitted to OpenRouter.
- Never exercise generation in a smoke test with an inherited shell key. Set `OPENROUTER_API_KEY=` explicitly for local error-path tests; a valid submission can incur cost immediately.

## Container Runtime

- Compose reads the untracked `.env`, listens only on host `127.0.0.1:3000`, and sets container `HOST=0.0.0.0`. Preserve that split so the local paid API is not exposed to the LAN by default.
- The runtime image contains only production dependencies plus `dist/` and `dist-server/`; server runtime imports must not depend on devDependencies or source files.

## Local h3.c Constraints

- Local mode is a macOS/Apple-Silicon host feature and cannot work inside the Linux Docker image. It requires a loopback-only server bind plus absolute `H3_BINARY` and `H3_MODEL_DIR` paths; `H3_RUNTIME_DIR` defaults beside the binary so `h3_shaders.metal` can be loaded.
- `h3.c` has no HTTP mode. `server/localH3.ts` deliberately spawns the one-shot CLI with an argument array and `shell: false`, owns all output paths under `.h3-jobs`/`H3_JOBS_DIR`, and serializes/caps jobs to avoid duplicate model residency. The server locks this directory and removes app-owned job/reference artifacts on deletion, abort, startup, page reload, graceful shutdown, and expiry of the browser-renewed workspace lease. Preserve those boundaries and do not pass the full server environment to the child. Current official h3.c exposes one-shot prompts through `-p`; keep the UI and README disclosure until upstream provides private prompt input.
- Keep local controls preset-based through `shared/localH3.ts`; do not expose h3.c diagnostic flags directly in the UI. Local first/last-frame paths must be absolute and readable; browsed PNG, JPEG, and WebP files are copied into `H3_JOBS_DIR` and framed to the selected canvas with server-controlled FFmpeg filters, never passed to h3.c from browser-controlled paths. Reference cleanup requires a volatile server-registered ownership token and may delete only UUID-named files in the server-owned staging directory; never delete a manually entered source path.
- Never run h3.c generation as a smoke test: it can consume substantial unified memory and time. Safe checks should use missing/invalid local configuration paths.
- h3.c engine code is MIT, but model weights have separate territorial and hosting restrictions. Do not download, redistribute, or bundle weights with this repository.

## Local MFLUX Constraints

- Local MFLUX is a macOS/Apple-Silicon host feature and is unavailable in Docker. Use `MFLUX_FLUX2_BINARY` and `MFLUX_QWEN_EDIT_BINARY` only as absolute paths; otherwise Luvox may discover the corresponding executables on the server process's `PATH`. FLUX.2 reference editing uses `mflux-generate-flux2-edit`, discovered beside `MFLUX_FLUX2_BINARY` or on `PATH`.
- `server/localMflux.ts` must spawn with an argument array and `shell: false`, use owner-marked server temporary paths, cap output, return generic engine errors, and avoid passing the full server environment. Prompts use `--prompt-file` so they do not appear in process listings. Remove original references after framing; startup may delete only stale directories bearing Luvox's strict ownership marker.
- Keep OpenRouter image and local MFLUX image slots independent. MFLUX permits only one server-wide process, aborts it when the request closes, validates the output raster, and removes prompt, reference, and output files after every request.
- MFLUX progress is parsed from bounded CLI output and streamed as NDJSON over the existing generation response. A broken stream is not terminal proof; keep the local ambiguity lock until Clear.
- Qwen Image Edit requires a reference image and receives it through `--image-paths`. FLUX.2 uses `mflux-generate-flux2` without a reference and `mflux-generate-flux2-edit --image-paths` with one. Uploaded references are framed to the selected output canvas in the request's private temporary directory. Luvox supports one reference image, not the CLIs' multi-image or LoRA options.
- Never run real MFLUX generation as a smoke test: generation consumes substantial unified memory. Use the fake executable test or an MFLUX executable's `--help` only.
- MFLUX code and model weights have separate licenses. Do not download, redistribute, or bundle either with this repository.
