<p align="center">
  <img src="name.png" alt="Motio" width="420" />
</p>

**Start with an idea or a frame. Choose how it runs. Set it in motion.**

Motio is a local studio for shaping prompts, reference frames, and model-specific controls without changing tools every time the backend changes. Generate videos remotely through [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/video-generation), create first-frame images from a prompt and optional reference with [Meta Muse Image](https://openrouter.ai/meta/muse-image) through OpenRouter's [Image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), or run [h3.c](https://github.com/antirez/h3.c) directly on a compatible Mac.

The first integrations are intentionally focused. The goal is a small interface that can grow with new generation models and workflows while keeping credentials and local files behind your own server.

## AI Development Disclosure

Motio is built with substantial assistance from GPT 5.6 and Claude Fable.

AI output is treated as a draft, not proof that the software works. Humans decide the behavior and own the testing, debugging, and review.

## Run with Docker

Docker is the quickest way to use Motio with OpenRouter. It builds the app and installs Node.js dependencies inside the image, so npm is not needed on your host.

```bash
cp .env.example .env
# Add your OPENROUTER_API_KEY to .env
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000).

Compose intentionally publishes Motio only on `127.0.0.1`. Keep that host binding so paid generation routes are not exposed to the network.

Local h3.c generation is not available in Docker because the Linux container cannot access macOS Metal or host model files.

## Run with npm

Use npm when developing Motio or running h3.c locally. Motio has a React client and an Express server; npm installs and builds both. Host mode also gives h3.c the macOS Metal and filesystem access it needs.

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

## Local generation with h3.c

Part of Motio's work is inspired by [h3.c](https://github.com/antirez/h3.c), which is also the engine required for local image-to-video generation. It is not bundled with Motio.

Local mode requires macOS on Apple Silicon, `ffmpeg`, the MiniMax H3 model weights, and a working h3.c build. Follow the [h3.c project instructions](https://github.com/antirez/h3.c) to install and verify them, then set these paths in `.env`:

```bash
H3_BINARY=/absolute/path/to/h3.c/h3
H3_MODEL_DIR=/absolute/path/to/MiniMax-H3
```

Run `npm run dev` and select **Local** in Motio. Local mode does not need an OpenRouter API key.

The Advanced section includes allowlisted h3.c acceleration presets, seed control, and SSD streaming. Reduced tokens and the fast internal canvas are limited to the officially validated 512p / 1:1 / Balanced path.

The h3.c source and MiniMax H3 model weights have their own licenses and usage restrictions. Review them before downloading, running, or distributing the engine, weights, or outputs.

## Session jobs

Each generation type has one slot: different types can run together, but the same type must finish or fail before another starts. Unknown submissions stay locked until Unlock (OpenRouter) or Clear (local). Session jobs remain until Clear, reload, or server restart.

## Privacy

Motio uses volatile session state instead of accounts or a generation database. API responses are marked `private, no-store`, and credentials are kept out of payloads and URLs.

### Hosted version

The hosted version is OpenRouter-only; h3.c is unavailable and Motio creates no local generation files. UI-entered keys, prompts, results, and job records stay in tab or transit memory and are not persisted by Motio. Keys travel only in request headers, remain pinned to submitted jobs in tab memory, and disappear on workspace reset, reload, or tab close. Videos are streamed through an authenticated proxy rather than saved to disk; temporary-key media uses revocable browser `blob:` URLs. A server-configured `OPENROUTER_API_KEY` never reaches the browser.

OpenRouter, model providers, and hosting infrastructure have separate data practices. Review OpenRouter's [privacy policy](https://openrouter.ai/privacy) and [provider logging documentation](https://openrouter.ai/docs/features/privacy-and-logging). Closing Motio does not cancel provider work already submitted.

### Self-hosted local h3.c

Local h3.c runs only on a compatible Mac and temporarily stores app-owned jobs, outputs, and uploaded references under `.h3-jobs` or `H3_JOBS_DIR`. Per-tab tokens isolate them. Motio cleans them on Clear, delivered reload/close cleanup, startup, and graceful shutdown; an abrupt close may leave files until restart.

## License

Motio is licensed under the [GNU General Public License v3.0](LICENSE).
