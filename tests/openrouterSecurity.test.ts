import assert from "node:assert/strict";
import test from "node:test";
import {
  generateVideo,
  getVideoContent,
  getVideoStatus,
  OpenRouterError,
  releaseVideoCapability,
} from "../server/openrouter.js";
import type { GenerateVideoInput } from "../server/validation.js";

const input: GenerateVideoInput = {
  provider: "openrouter",
  prompt: "test video",
  model: "minimax/minimax-hailuo-2.3",
  duration: 6,
  aspectRatio: "16:9",
  resolution: "768p",
  generateAudio: false,
};

test("server-key video capabilities isolate status and content access", async () => {
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.OPENROUTER_API_KEY;
  const authorizations: string[] = [];
  let contentType = "video/mp4";
  let contentStatus = 200;
  let contentRange: string | undefined;
  let polledStatus = "completed";
  globalThis.fetch = async (request, init) => {
    const url = String(request);
    authorizations.push(new Headers(init?.headers).get("authorization") || "");
    if (url.endsWith("/videos") && init?.method === "POST") {
      return Response.json({ id: "video-test", polling_url: "/videos/video-test", status: "pending" });
    }
    if (url.includes("/videos/video-test/content")) {
      return new Response(contentStatus === 416 ? null : "video", {
        status: contentStatus,
        headers: {
          ...(contentType ? { "Content-Type": contentType } : {}),
          ...(contentRange ? { "Content-Range": contentRange } : {}),
        },
      });
    }
    return Response.json({ id: "video-test", polling_url: "/videos/video-test", status: polledStatus });
  };
  process.env.OPENROUTER_API_KEY = "server-test-key";

  try {
    const created = await generateVideo(input);
    assert.match(created.capabilityToken || "", /^[0-9a-f-]{36}$/);
    await assert.rejects(
      getVideoStatus(created.id),
      (error) => error instanceof OpenRouterError && error.status === 404,
    );
    const polled = await getVideoStatus(created.id, undefined, undefined, created.capabilityToken);
    assert.equal(polled.status, "completed");
    assert.equal(polled.capabilityToken, undefined);
    assert.equal((await getVideoContent(created.id, undefined, undefined, undefined, created.capabilityToken)).status, 200);
    await assert.rejects(
      getVideoStatus("another-video", undefined, undefined, created.capabilityToken),
      (error) => error instanceof OpenRouterError && error.status === 404,
    );

    contentType = "text/html";
    await assert.rejects(
      getVideoContent(created.id, undefined, undefined, undefined, created.capabilityToken),
      (error) => error instanceof OpenRouterError && error.type === "invalid_provider_response",
    );
    contentStatus = 416;
    await assert.rejects(
      getVideoContent(created.id, undefined, undefined, undefined, created.capabilityToken),
      (error) => error instanceof OpenRouterError && error.type === "invalid_provider_response",
    );
    contentType = "";
    contentRange = "bytes */100";
    assert.equal(
      (await getVideoContent(created.id, undefined, undefined, undefined, created.capabilityToken)).status,
      416,
    );
    assert.deepEqual(releaseVideoCapability(created.id, created.capabilityToken!), { released: true });
    await assert.rejects(
      getVideoStatus(created.id, undefined, undefined, created.capabilityToken),
      (error) => error instanceof OpenRouterError && error.status === 404,
    );

    const temporary = await generateVideo(input, "temporary-test-key");
    assert.equal(temporary.capabilityToken, undefined);
    assert.equal((await getVideoStatus(temporary.id, "temporary-test-key")).status, "completed");
    assert.ok(authorizations.includes("Bearer server-test-key"));
    assert.ok(authorizations.includes("Bearer temporary-test-key"));

    const failed = await generateVideo(input);
    polledStatus = "failed";
    assert.equal((await getVideoStatus(failed.id, undefined, undefined, failed.capabilityToken)).status, "failed");
    assert.equal((await getVideoStatus(failed.id, undefined, undefined, failed.capabilityToken)).status, "failed");
    releaseVideoCapability(failed.id, failed.capabilityToken!);
    polledStatus = "completed";

    const expiring = await generateVideo(input);
    const realNow = Date.now;
    Date.now = () => realNow() + 25 * 60 * 60 * 1_000;
    try {
      await assert.rejects(
        getVideoStatus(expiring.id, undefined, undefined, expiring.capabilityToken),
        (error) => error instanceof OpenRouterError && error.status === 404,
      );
    } finally {
      Date.now = realNow;
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousApiKey;
  }
});
