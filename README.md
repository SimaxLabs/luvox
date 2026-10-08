# Luvox

<img src="public/logo.png" alt="Luvox logo" width="96" />

**Start with an idea or a frame. Choose how it runs. Set it in motion.**

Luvox is a simple local studio for generating images and videos from prompts and reference images, without node graphs or complex workflows. Use [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/video-generation) for remote generation, [MFLUX](https://github.com/mflux-community/mflux) for local images, or [h3.c](https://github.com/antirez/h3.c) for local videos on Apple Silicon.

## AI Development Disclosure

Built with substantial assistance from GPT 5.6 and Claude Fable, with human testing and review.

## Run with Docker

The quickest setup for OpenRouter. Local MFLUX and h3.c require the npm setup below.

```bash
cp .env.example .env
# Add your OPENROUTER_API_KEY to .env
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Keep Compose's `127.0.0.1` binding so paid generation routes remain accessible only from your computer.

## Run with npm

Requires **Node.js 22.12+**. Use this setup for development or local engines. Add `OPENROUTER_API_KEY` to `.env` if using OpenRouter.

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

## Personalize OpenRouter models

Choose **Manage models** beside the OpenRouter key field to add compatible models from its [image](https://openrouter.ai/docs/api/api-reference/images/list-image-generation-models) and [video](https://openrouter.ai/docs/api/api-reference/video-generation/list-all-video-generation-models) catalogs. Browsing costs no credits. Built-in models cannot be replaced or removed.

## Saved prompts

Choose **Saved prompts** to save up to 100 prompts, optionally including model settings. Credentials and references are never saved.

Custom models and saved prompts are stored in `.luvox`. Set `LUVOX_DATA_DIR` to an absolute path to change this location. Docker uses the `luvox-data` volume; **`docker compose down -v` deletes this saved data**.

## Local image generation with MFLUX

Requires **macOS on Apple Silicon** and an installed [MFLUX](https://github.com/mflux-community/mflux). Use the npm setup, then choose **Text to image → Local MFLUX**.

- **Z-Image Turbo** (default): text-to-image and optional reference-image variations.
- **FLUX.2 Klein 4B**: text-to-image and instruction-based editing with one reference image.

Luvox discovers the executables on `PATH`. If needed, set absolute paths in `.env`:

```bash
MFLUX_FLUX2_BINARY=/absolute/path/to/mflux-generate-flux2
MFLUX_Z_IMAGE_TURBO_BINARY=/absolute/path/to/mflux-generate-z-image-turbo
```

FLUX.2 editing also requires `mflux-generate-flux2-edit` beside the main executable or on `PATH`.

For Z-Image Turbo, open **Advanced → LoRA adapters** to add up to four compatible adapters. Enter an absolute `.safetensors` path or Hugging Face `owner/repo[:file.safetensors]`; strength defaults to `1` and accepts `-2` to `2`. Include any required trigger words in your prompt. LoRA selections are session-only and are not saved with prompts.

Missing model resources download automatically on first generation, with progress shown in the app. Stopping keeps cached resources for retry. Gated models may require accepting their terms and running `hf auth login` on the host. MFLUX and its dependencies must be installed separately.

Use **Fast** for lower-memory quantization or **Low RAM** to reduce peak memory and unload the model after each image. Otherwise, model reuse speeds up repeat generations while keeping memory occupied.

Optional `.env` settings, in minutes:

| Setting | Default | Purpose |
| --- | --- | --- |
| `MFLUX_DOWNLOAD_TIMEOUT_MINUTES` | `120` | Cumulative resource-check/download limit; 1–240. |
| `MFLUX_TIMEOUT_MINUTES` | `30` | Loading/generation limit, excluding detected downloads; 1–240. |
| `MFLUX_KEEP_ALIVE_MINUTES` | `5` | Idle time before unloading the model; 0–240. Set `0` to disable reuse. |

## Local generation with h3.c

Requires **macOS on Apple Silicon**, `ffmpeg`, [h3.c](https://github.com/antirez/h3.c), and MiniMax H3 model weights. Follow the h3.c installation instructions, then set absolute paths in `.env`:

```bash
H3_BINARY=/absolute/path/to/h3.c/h3
H3_MODEL_DIR=/absolute/path/to/MiniMax-H3
```

Use the npm setup and select **Local** for video generation. No OpenRouter key is needed. **h3.c prompts may be visible in local process listings** while generation runs.

## Session jobs

Different generation types can run together, with one active job per type. **Download results you want to keep**: jobs and results are cleared on reload or server restart.

Local generation can be stopped. OpenRouter jobs cannot be cancelled through Luvox; closing the app does not stop paid work already submitted.

## Privacy

- Only custom models and explicitly saved prompts persist as workspace data. Temporary browser-entered API keys are not stored; the server's `OPENROUTER_API_KEY` never reaches the browser.
- Local engines use temporary generation files that Luvox cleans up. Downloaded model caches remain on disk for reuse.
- Remote prompts and references are sent to the selected provider. See OpenRouter's [privacy policy](https://openrouter.ai/privacy) and [provider logging documentation](https://openrouter.ai/docs/features/privacy-and-logging).

## License

Luvox is licensed under the [GNU General Public License v3.0](LICENSE).

MFLUX, h3.c, and their model weights have separate licenses and usage restrictions. Engines and weights are not bundled with Luvox.
