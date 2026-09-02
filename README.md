# Motio

**Start with an idea or a frame. Choose how it runs. Set it in motion.**

Motio is a local studio for shaping prompts, reference frames, and model-specific controls without changing tools every time the backend changes. Generate remotely through [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/video-generation), or run [h3.c](https://github.com/antirez/h3.c) directly on a compatible Mac.

The first integrations are intentionally focused. The goal is a small interface that can grow with new video models and workflows while keeping credentials and local files behind your own server.

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

The h3.c source and MiniMax H3 model weights have their own licenses and usage restrictions. Review them before downloading, running, or distributing the engine, weights, or outputs.

## Privacy

The environment API key stays on the server. A key entered in the UI remains only in the current browser tab. Prompts and jobs are not persisted by Motio.

## License

Motio is licensed under the [GNU General Public License v3.0](LICENSE).
