import "dotenv/config";

import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { ZodError } from "zod";
import {
  generateVideo,
  getVideoContent,
  getVideoStatus,
  OpenRouterError,
} from "./openrouter.js";
import { validateGenerateVideoInput, validateJobId } from "./validation.js";

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || (isProduction ? 3000 : 3001));
const host = process.env.HOST?.trim() || "127.0.0.1";

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post(
  "/api/video/generate",
  async (request: Request, response: Response, next: NextFunction) => {
    try {
      const input = validateGenerateVideoInput(request.body);
      const result = await generateVideo(input);
      response.status(202).json(result);
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/video/status/:id",
  async (request: Request, response: Response, next: NextFunction) => {
    try {
      const id = validateJobId(request.params.id);
      const result = await getVideoStatus(id);
      response.json(result);
    } catch (error) {
      next(error);
    }
  },
);

app.head("/api/video/content/:id", (_request, response) => {
  response.setHeader("Allow", "GET");
  response.status(405).end();
});

app.get(
  "/api/video/content/:id",
  async (request: Request, response: Response, next: NextFunction) => {
    try {
      const id = validateJobId(request.params.id);
      const upstream = await getVideoContent(id, request.headers.range);

      response.status(upstream.status);
      for (const header of [
        "accept-ranges",
        "content-length",
        "content-range",
        "content-type",
      ]) {
        const value = upstream.headers.get(header);
        if (value) response.setHeader(header, value);
      }

      response.setHeader("Cache-Control", "private, no-store");
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
  (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
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

    if (error instanceof OpenRouterError) {
      if (error.retryAfter) response.setHeader("Retry-After", error.retryAfter);
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

app.listen(port, host, () => {
  console.log(`Motion Lab server listening on http://${host}:${port}`);
});
