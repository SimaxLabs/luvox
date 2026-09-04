# Luvox

<img src="public/logo.png" alt="Luvox logo" width="96" />

**Start with an idea or a frame. Choose how it runs. Set it in motion.**

Luvox is a local studio for shaping prompts, reference frames, and model-specific controls without changing tools every time the backend changes.

Luvox is designed for non-professional users who want to turn a prompt into an image or video without managing node graphs, templates, or other complex workflow tools. The goal is a small, approachable interface that can grow with new generation models while keeping credentials and local files behind your own server.

Generate videos remotely through [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/video-generation), create images through OpenRouter or local [MFLUX](https://github.com/mflux-community/mflux), or run [h3.c](https://github.com/antirez/h3.c) directly on a compatible Mac.

## AI Development Disclosure

Luvox is built with substantial assistance from GPT 5.6 and Claude Fable.

AI output is treated as a draft, not proof that the software works. Humans decide the behavior and own the testing, debugging, and review.

## Run with Docker

Docker is the quickest way to use Luvox with OpenRouter. It builds the app and installs Node.js dependencies inside the image, so npm is not needed on your host.

```bash
cp .env.example .env
# Add your OPENROUTER_API_KEY to .env
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000).

Compose intentionally publishes Luvox only on `127.0.0.1`. Keep that host binding so paid generation routes are not exposed to the network.

Local MFLUX and h3.c generation are not available in Docker because the Linux container cannot access macOS Metal or host model files, so the Docker UI hides the provider selectors and uses OpenRouter only.

## Run with npm

Use npm when developing Luvox or running MFLUX or h3.c locally. Luvox has a React client and an Express server; npm installs and builds both. Host mode gives local engines the macOS Metal and filesystem access they need.

Requires Node.js 22.12 or newer.

```bash
cp .env.example .env
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). For a production build:

```bash
npm run build
NODE_ENV=production npm start
```

## Local image generation with MFLUX

Install and verify [MFLUX](https://github.com/mflux-community/mflux) on a Mac with Apple Silicon. Luvox automatically finds `mflux-generate-flux2`, its `mflux-generate-flux2-edit` companion, and `mflux-generate-qwen-edit` on the server process's `PATH`; set absolute paths in `.env` when the primary executables are not detected:

```bash
MFLUX_FLUX2_BINARY=/absolute/path/to/mflux-generate-flux2
MFLUX_QWEN_EDIT_BINARY=/absolute/path/to/mflux-generate-qwen-edit
```

Run `npm run dev`, choose **Text to image**, then select **Local MFLUX**. Luvox supports FLUX.2 Klein 4B generation and Qwen Image Edit with common 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, and 2:3 resolution presets. FLUX.2 uses normal text-to-image generation without a reference and its dedicated edit pipeline when one reference is supplied. Uploaded references can preserve the full image with padding or crop to fill the selected output canvas. Qwen requires one reference image; the MFLUX CLI's multi-image and LoRA options are not exposed.

FLUX.2 defaults to the Fast setup with 1024p / 1:1, four steps, and 4-bit quantization; Quality switches to 8-bit. Qwen defaults to 20 steps, 8-bit quantization, and guidance 2.5, with a 30-step Quality setup. Advanced controls expose each model's allowlisted steps, quantization, seed, Low RAM mode, VAE tiling at 128, 256, or 512 pixels, and Qwen guidance. Low RAM automatically enables VAE tiling.

Before using a model in Luvox, run its MFLUX executable successfully once in Terminal so its weights are downloaded and cached. Luvox does not download or bundle weights, keeps prompts and references in a private temporary directory, allows only one MFLUX generation at a time, and removes temporary files after each request. MFLUX and model weights have separate licenses; review them before use.

During local generation, the preview monitor streams MFLUX's inference steps, elapsed time, step ETA, and seconds per step. The ETA covers the remaining inference loop; final image decoding can add time.

## Local generation with h3.c

Part of Luvox's work is inspired by [h3.c](https://github.com/antirez/h3.c), which is also the engine required for local image-to-video generation. It is not bundled with Luvox.

Local mode requires macOS on Apple Silicon, `ffmpeg`, the MiniMax H3 model weights, and a working h3.c build. Follow the [h3.c project instructions](https://github.com/antirez/h3.c) to install and verify them, then set these paths in `.env`:

```bash
H3_BINARY=/absolute/path/to/h3.c/h3
H3_MODEL_DIR=/absolute/path/to/MiniMax-H3
```

Run `npm run dev` and select **Local** in Luvox. Local mode does not need an OpenRouter API key. The current official h3.c CLI accepts one-shot prompts only through a process argument, so prompts may be visible to local process-inspection and monitoring tools while generation runs.

The Advanced section includes allowlisted h3.c acceleration presets, seed control, and SSD streaming. Reduced tokens and the fast internal canvas are limited to the officially validated 512p / 1:1 / Balanced path.

The h3.c source and MiniMax H3 model weights have their own licenses and usage restrictions. Review them before downloading, running, or distributing the engine, weights, or outputs.

## Session jobs

Each generation type has one slot: OpenRouter image, local MFLUX image, OpenRouter video, and local h3.c video can overlap, but the same type must finish or fail before another starts. Unknown submissions stay locked until Unlock (OpenRouter) or Clear (local). Completed results can be deleted individually; other session jobs remain until Clear, reload, or server restart. Active local MFLUX and h3.c work can be aborted, but OpenRouter exposes no cancellation endpoint.

## Privacy

Luvox uses volatile session state instead of accounts or a generation database. API responses are marked `private, no-store`, and credentials are kept out of payloads and URLs.

When using OpenRouter, Luvox creates no local generation files. UI-entered keys, prompts, results, and job records stay in tab or transit memory and are not persisted by Luvox. Keys travel only in request headers, remain pinned to submitted jobs in tab memory, and disappear on workspace reset, reload, or tab close. Videos are streamed through an authenticated proxy rather than saved to disk; temporary-key media uses revocable browser `blob:` URLs. Server-key video access uses a per-job capability kept only in tab and server memory, never in a URL, and expires after 24 hours without use. A server-configured `OPENROUTER_API_KEY` never reaches the browser.

OpenRouter and model providers have separate data practices. Review OpenRouter's [privacy policy](https://openrouter.ai/privacy) and [provider logging documentation](https://openrouter.ai/docs/features/privacy-and-logging). Closing Luvox does not cancel provider work already submitted.

Local MFLUX and h3.c run only on a compatible Mac. MFLUX uses an owner-marked private system temporary directory for each request, removes it when the request finishes or stops, and removes stale owned directories at startup after an abrupt server exit. h3.c temporarily stores app-owned jobs, outputs, and uploaded references under `.h3-jobs` or `H3_JOBS_DIR`; per-tab tokens isolate them. Luvox cleans h3.c files when a job is deleted or aborted, on Clear, reload/close cleanup, startup, graceful shutdown, or after a browser workspace misses its five-minute lease.

## License

Luvox is licensed under the [GNU General Public License v3.0](LICENSE).
