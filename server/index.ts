import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { z, ZodError } from "zod";
import {
  beginLocalH3Shutdown,
  deleteLocalVideoJob,
  discardLocalH3Workspace,
  deleteLocalReferenceImage,
  generateLocalVideo,
  getLocalVideoPath,
  getLocalVideoStatus,
  initializeLocalH3Storage,
  isLocalJobId,
  isLocalH3Supported,
  LocalH3Error,
  renewLocalH3Workspace,
  shutdownLocalH3Storage,
  uploadLocalReferenceImage,
} from "./localH3.js";
import {
  beginLocalMfluxShutdown,
  generateLocalMfluxImage,
  getAvailableLocalMfluxModels,
  initializeLocalMfluxStorage,
  isLocalMfluxConfigured,
  isLocalMfluxSupported,
  LocalMfluxError,
  shutdownLocalMflux,
} from "./localMflux.js";
import {
  generateImage,
  generateVideo,
  getVideoContent,
  getVideoStatus,
  OpenRouterError,
  releaseVideoCapability,
} from "./openrouter.js";
import {
  validateGenerateImageInput,
  validateGenerateVideoInput,
  validateJobId,
} from "./validation.js";

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || (isProduction ? 3000 : 3001));
const host = process.env.HOST?.trim() || "127.0.0.1";
const trustContainerProxy = process.env.MOTIO_TRUST_CONTAINER_PROXY === "1";
const serverSessionId = randomUUID();
const sessionApiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024, "The temporary API key is too long.")
  .optional();
const localReferenceDeleteSchema = z
  .object({ token: z.string().uuid() })
  .strict();
const localReferenceTokenSchema = z.string().uuid();
const localWorkspaceTokenSchema = z.string().uuid();
const videoCapabilityTokenSchema = z.string().uuid();

function getSessionApiKey(request: Request): string | undefined {
  return sessionApiKeySchema.parse(request.get("X-OpenRouter-Api-Key"));
}

function getLocalWorkspaceToken(request: Request): string {
  return localWorkspaceTokenSchema.parse(request.get("X-Motio-Workspace-Token"));
}

function getVideoCapabilityToken(request: Request): string | undefined {
  return videoCapabilityTokenSchema.optional().parse(request.get("X-Motio-Video-Token"));
}

function assertLoopbackRequest(request: Request): void {
  const normalizeHostname = (value: string) => value.toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  const allowedHostnames = new Set(["127.0.0.1", "::1", "localhost"]);
  const hostname = normalizeHostname(request.hostname);
  const remoteAddress = normalizeHostname(request.socket.remoteAddress || "");
  const origin = request.get("Origin");
  let originHostname: string | undefined;
  if (origin) {
    try {
      originHostname = normalizeHostname(new URL(origin).hostname);
    } catch {
      originHostname = "";
    }
  }
  if (
    (!allowedHostnames.has(remoteAddress) && !trustContainerProxy) ||
    !allowedHostnames.has(hostname) ||
    (originHostname !== undefined && !allowedHostnames.has(originHostname))
  ) {
    throw new LocalH3Error(
      "Motio accepts this operation only from a loopback origin.",
      403,
      "local_request_forbidden",
      false,
    );
  }
}

function loopbackOnly(request: Request, _response: Response, next: NextFunction): void {
  try {
    assertLoopbackRequest(request);
    next();
  } catch (error) {
    next(error);
  }
}

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("Content-Security-Policy", "base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  next();
});
app.use("/api", (_request, response, next) => {
  response.setHeader("Cache-Control", "private, no-store");
  next();
});

app.get("/api/config", (_request, response) => {
  response.json({
    sessionId: serverSessionId,
    localH3: {
      supported: isLocalH3Supported(),
      configured: Boolean(
        process.env.H3_BINARY?.trim() && process.env.H3_MODEL_DIR?.trim(),
      ),
    },
    localMflux: {
      supported: isLocalMfluxSupported(),
      configured: isLocalMfluxConfigured(),
      models: getAvailableLocalMfluxModels(),
    },
  });
});

app.put(
  "/api/local/workspace",
  loopbackOnly,
  (request: Request, response: Response, next: NextFunction) => {
    try {
      response.json(renewLocalH3Workspace(getLocalWorkspaceToken(request)));
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/local/reference-image",
  express.raw({
    type: ["image/png", "image/jpeg", "image/webp", "application/octet-stream"],
    limit: "25mb",
  }),
  async (request: Request, response: Response, next: NextFunction) => {
    try {
      assertLoopbackRequest(request);
      if (!Buffer.isBuffer(request.body)) {
        throw new LocalH3Error(
          "Send the reference image as the request body.",
          415,
          "local_reference_error",
          false,
        );
      }
      const uploadToken = localReferenceTokenSchema.parse(
        request.get("X-Reference-Upload-Token"),
      );
      const previousToken = localReferenceTokenSchema.optional().parse(
        request.get("X-Previous-Reference-Token"),
      );
      const result = await uploadLocalReferenceImage(
        request.body,
        uploadToken,
        getLocalWorkspaceToken(request),
        previousToken,
      );
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/image/generate",
  loopbackOnly,
  express.json({ limit: "15mb" }),
  async (request: Request, response: Response, next: NextFunction) => {
    const controller = new AbortController();
    const abortUpstream = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", abortUpstream);
    try {
      const input = validateGenerateImageInput(request.body);
      if (input.provider === "mflux") {
        response.status(200);
        response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.flushHeaders();
        const send = (event: unknown) => {
          if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
        };
        try {
          const result = await generateLocalMfluxImage(input, controller.signal, (progress) => send({ type: "progress", progress }));
          send({ type: "result", result });
        } catch (error) {
          if (!controller.signal.aborted) {
            if (!(error instanceof LocalMfluxError)) console.error(error);
            send({
              type: "error",
              error: error instanceof LocalMfluxError
                ? { status: error.status, type: error.type, message: error.message, retryable: error.retryable }
                : { status: 500, type: "internal_error", message: "The server could not complete the request.", retryable: false },
            });
          }
        } finally {
          if (!response.writableEnded) response.end();
        }
        return;
      }

      response.json(await generateImage(input, getSessionApiKey(request), controller.signal));
    } catch (error) {
      if (!controller.signal.aborted) next(error);
    } finally {
      response.off("close", abortUpstream);
    }
  },
);

app.use(express.json({ limit: "100kb" }));

app.delete(
  "/api/local/reference-image",
  async (request: Request, response: Response, next: NextFunction) => {
    try {
      assertLoopbackRequest(request);
      const input = localReferenceDeleteSchema.parse(request.body);
      const result = await deleteLocalReferenceImage(input.token, getLocalWorkspaceToken(request));
      response.json(result);
    } catch (error) {
      next(error);
    }
  },
);

app.delete(
  "/api/local/workspace",
  async (request: Request, response: Response, next: NextFunction) => {
    try {
      assertLoopbackRequest(request);
      const result = await discardLocalH3Workspace(getLocalWorkspaceToken(request));
      response.json(result);
    } catch (error) {
      next(error);
    }
  },
);

app.delete(
  "/api/local/video/:id",
  async (request: Request, response: Response, next: NextFunction) => {
    try {
      assertLoopbackRequest(request);
      const result = await deleteLocalVideoJob(validateJobId(request.params.id), getLocalWorkspaceToken(request));
      response.json(result);
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/video/generate",
  loopbackOnly,
  async (request: Request, response: Response, next: NextFunction) => {
    const controller = new AbortController();
    const abortUpstream = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", abortUpstream);
    try {
      const input = validateGenerateVideoInput(request.body);
      const result =
        input.provider === "local"
          ? await generateLocalVideo(input, getLocalWorkspaceToken(request))
          : await generateVideo(
              input,
              getSessionApiKey(request),
              controller.signal,
            );
      response.status(202).json(result);
    } catch (error) {
      if (!controller.signal.aborted) next(error);
    } finally {
      response.off("close", abortUpstream);
    }
  },
);

app.get(
  "/api/video/status/:id",
  loopbackOnly,
  async (request: Request, response: Response, next: NextFunction) => {
    const controller = new AbortController();
    const abortUpstream = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", abortUpstream);
    try {
      const id = validateJobId(request.params.id);
      const result = isLocalJobId(id)
        ? getLocalVideoStatus(id, getLocalWorkspaceToken(request))
        : await getVideoStatus(
            id,
            getSessionApiKey(request),
            controller.signal,
            getVideoCapabilityToken(request),
          );
      response.json(result);
    } catch (error) {
      if (!controller.signal.aborted) next(error);
    } finally {
      response.off("close", abortUpstream);
    }
  },
);

app.head(
  "/api/video/content/:id",
  loopbackOnly,
  async (request: Request, response: Response, next: NextFunction) => {
    try {
      const id = validateJobId(request.params.id);
      if (!isLocalJobId(id)) {
        response.setHeader("Allow", "GET");
        response.status(405).end();
        return;
      }

      const videoPath = await getLocalVideoPath(id, getLocalWorkspaceToken(request));
      response.setHeader("Content-Disposition", "inline");
      response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      response.setHeader("Content-Type", "video/mp4");
      response.sendFile(videoPath, { dotfiles: "allow" }, (error) => {
        if (error) next(error);
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/video/content/:id",
  loopbackOnly,
  async (request: Request, response: Response, next: NextFunction) => {
    const controller = new AbortController();
    const abortUpstream = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", abortUpstream);
    try {
      const id = validateJobId(request.params.id);

      if (isLocalJobId(id)) {
        const videoPath = await getLocalVideoPath(id, getLocalWorkspaceToken(request));
        response.setHeader(
          "Content-Disposition",
          request.query.download === "1"
            ? "attachment; filename=\"h3-local-video.mp4\""
            : "inline",
        );
        response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        response.setHeader("Content-Type", "video/mp4");
        response.sendFile(videoPath, { dotfiles: "allow" }, (error) => {
          if (error) next(error);
        });
        return;
      }

      const upstream = await getVideoContent(
        id,
        request.headers.range,
        getSessionApiKey(request),
        controller.signal,
        getVideoCapabilityToken(request),
      );

      response.status(upstream.status);
      for (const header of [
        "accept-ranges",
        "content-length",
        "content-range",
      ]) {
        const value = upstream.headers.get(header);
        if (value) response.setHeader(header, value);
      }
      response.setHeader("Content-Type", "video/mp4");
      response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");

      response.setHeader(
        "Content-Disposition",
        request.query.download === "1"
          ? "attachment; filename=\"openrouter-video.mp4\""
          : "inline",
      );

      if (!upstream.body) {
        response.end();
        return;
      }

      const stream = Readable.fromWeb(upstream.body as never);
      stream.on("error", (error) => response.destroy(error));
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (!controller.signal.aborted) next(error);
    }
  },
);

app.delete(
  "/api/video/:id",
  loopbackOnly,
  (request: Request, response: Response, next: NextFunction) => {
    try {
      const id = validateJobId(request.params.id);
      if (isLocalJobId(id)) {
        throw new OpenRouterError("The video generation was not found.", 404, "not_found", false);
      }
      response.json(releaseVideoCapability(id, videoCapabilityTokenSchema.parse(request.get("X-Motio-Video-Token"))));
    } catch (error) {
      next(error);
    }
  },
);

if (isProduction) {
  const clientDirectory = path.resolve(process.cwd(), "dist");
  app.use(express.static(clientDirectory));
  app.use((request, response, next) => {
    if (
      request.method === "GET" &&
      request.path !== "/api" &&
      !request.path.startsWith("/api/")
    ) {
      response.sendFile(path.join(clientDirectory, "index.html"));
      return;
    }
    next();
  });
}

app.use((request, response) => {
  response.status(404).json({
    error: {
      type: "not_found",
      message: `No route exists for ${request.method} ${request.path}.`,
      retryable: false,
    },
  });
});

app.use(
  (error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          type: "validation_error",
          message: error.issues[0]?.message || "The request is invalid.",
          retryable: false,
          fields: error.flatten().fieldErrors,
        },
      });
      return;
    }

    if (error instanceof OpenRouterError || error instanceof LocalH3Error || error instanceof LocalMfluxError) {
      if (error instanceof OpenRouterError && error.retryAfter) {
        response.setHeader("Retry-After", error.retryAfter);
      }
      response.status(error.status).json({
        error: {
          type: error.type,
          message: error.message,
          retryable: error.retryable,
        },
      });
      return;
    }

    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({
        error: {
          type: "invalid_json",
          message: "The request body is not valid JSON.",
          retryable: false,
        },
      });
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number" &&
      error.status >= 400 &&
      error.status < 500
    ) {
      if (
        "headers" in error &&
        typeof error.headers === "object" &&
        error.headers !== null
      ) {
        for (const [name, value] of Object.entries(error.headers)) {
          if (typeof value === "string") response.setHeader(name, value);
        }
      }
      const message =
        error.status === 413
          ? "The request body is too large."
          : error.status === 415
            ? "The request content type or encoding is not supported."
            : "The request could not be parsed.";
      response.status(error.status).json({
        error: {
          type: "request_error",
          message,
          retryable: false,
        },
      });
      return;
    }

    console.error(error);
    response.status(500).json({
      error: {
        type: "internal_error",
        message: "The server could not complete the request.",
        retryable: false,
      },
    });
  },
);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port.");
}

await initializeLocalMfluxStorage();
await initializeLocalH3Storage();

const server = app.listen(port, host, () => {
  console.log(`Motio server listening on http://${host}:${port}`);
});

let closing: Promise<void> | undefined;
function closeServer(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    beginLocalH3Shutdown();
    beginLocalMfluxShutdown();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const closeTimeout = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, 15_000);
      timeout.unref();
    });
    await Promise.race([closed, closeTimeout]);
    await shutdownLocalH3Storage();
    await shutdownLocalMflux();
  })();
  return closing;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void closeServer()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  });
}
