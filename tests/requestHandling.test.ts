import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Request, Response as ExpressResponse } from "express";
import { abortableRoute } from "../server/abortableRoute.js";
import { validateGenerateImageInput } from "../server/validation.js";
import { rasterMediaType, type LocalMfluxProgress } from "../shared/imageTypes.js";
import { generateImage, getAppConfig } from "../src/api.js";

test("shared raster detection accepts complete signatures and rejects truncated or mismatched references", () => {
  for (const [hex, mediaType] of [
    ["89504e470d0a1a0a", "image/png"],
    ["ffd8ff", "image/jpeg"],
    ["524946460000000057454250", "image/webp"],
  ]) {
    const bytes = Buffer.from(hex, "hex");
    assert.equal(rasterMediaType(bytes), mediaType);
    assert.equal(rasterMediaType(new Uint8Array(bytes)), mediaType);
    for (let length = 0; length < bytes.length; length += 1) {
      assert.equal(rasterMediaType(bytes.subarray(0, length)), undefined);
    }
    const input = { provider: "openrouter", model: "meta/muse-image", prompt: "test" };
    assert.doesNotThrow(() => validateGenerateImageInput({ ...input, inputReference: `data:${mediaType};base64,${bytes.toString("base64")}` }));
    const otherType = mediaType === "image/png" ? "image/jpeg" : "image/png";
    assert.throws(() => validateGenerateImageInput({ ...input, inputReference: `data:${otherType};base64,${bytes.toString("base64")}` }));
    bytes[0] = 0;
    assert.equal(rasterMediaType(bytes), undefined);
  }
});

test("abortable routes forward failures, cancel disconnected work, and remove listeners", async () => {
  for (const outcome of ["success", "failure", "disconnect", "finished"] as const) {
    const response = Object.assign(new EventEmitter(), { writableEnded: false });
    const failure = new Error("request failed");
    let forwarded: unknown;
    let requestSignal!: AbortSignal;
    await abortableRoute(async (_request, _response, signal) => {
      requestSignal = signal;
      assert.equal(response.listenerCount("close"), 1);
      if (outcome === "finished") response.writableEnded = true;
      if (outcome === "disconnect" || outcome === "finished") response.emit("close");
      if (outcome === "failure" || outcome === "disconnect") throw failure;
    })({} as Request, response as unknown as ExpressResponse, (error) => { forwarded = error; });
    assert.equal(forwarded, outcome === "failure" ? failure : undefined);
    assert.equal(requestSignal.aborted, outcome === "disconnect");
    assert.equal(response.listenerCount("close"), 0);
    response.emit("close");
    assert.equal(requestSignal.aborted, outcome === "disconnect");
  }
});

test("JSON and streaming API requests preserve errors and leave successful streams readable", async (t) => {
  let respond = () => Response.json({ sessionId: "test" });
  t.mock.method(globalThis, "fetch", async () => respond());
  const progress: LocalMfluxProgress[] = [];
  const mflux = () => generateImage({
    provider: "mflux", model: "flux2-klein-4b", prompt: "test", resolution: "1024x1024",
    steps: 4, quantization: 8, lowRam: false, vaeTiling: false, vaeTileSize: 512,
  }, undefined, undefined, (update) => progress.push(update));
  assert.deepEqual(await getAppConfig(), { sessionId: "test" });
  for (const request of [getAppConfig, mflux]) {
    respond = () => { throw new TypeError("network unavailable"); };
    await assert.rejects(request, { name: "ApiError", status: 0, type: "local_network_error", retryable: true });
    respond = () => new Response("not JSON", { status: 503 });
    await assert.rejects(request, { name: "ApiError", status: 503, type: "invalid_local_response", retryable: true });
    respond = () => Response.json({ error: { message: "Busy", type: "busy", retryable: false } }, { status: 429, headers: { "Retry-After": "10" } });
    await assert.rejects(request, { name: "ApiError", message: "Busy", status: 429, type: "busy", retryable: false, retryAfterSeconds: 10 });
  }
  const update: LocalMfluxProgress = { phase: "generating", step: 1, total: 4, percent: 25 };
  const result = { mediaType: "image/png", b64Json: "iVBORw0KGgo=" };
  const bytes = new TextEncoder().encode(`${JSON.stringify({ type: "progress", progress: update })}\n${JSON.stringify({ type: "result", result })}`);
  respond = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 20));
    controller.enqueue(bytes.subarray(20));
    controller.close();
  } }));
  assert.deepEqual(await mflux(), result);
  assert.deepEqual(progress, [update]);
  respond = () => new Response("{broken stream}");
  await assert.rejects(mflux, { name: "ApiError", type: "invalid_local_response", retryable: true });
});
