import assert from "node:assert/strict";
import test from "node:test";
import type { ImageGeneratePayload } from "../server/validation.js";
import { generateImageBatch } from "../src/api.js";

const result = { mediaType: "image/png", b64Json: "iVBORw0KGgo=" };
const references = ["first", "second", "third"].map((value) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`);

function payloads(provider: "openrouter" | "mflux"): ImageGeneratePayload[] {
  return references.map((inputReference) => provider === "openrouter"
    ? { provider, model: "meta/muse-image", prompt: "Same prompt", inputReference }
    : { provider, model: "flux2-klein-9b", prompt: "Same prompt", inputReference, resolution: "1024x1024", steps: 4, quantization: 8, lowRam: false, vaeTiling: false, vaeTileSize: 512, referenceFit: "cover" });
}

function response(provider: "openrouter" | "mflux") {
  return provider === "openrouter" ? Response.json(result) : new Response(
    `${JSON.stringify({ type: "progress", progress: { phase: "generating", step: 1, total: 4, percent: 25 } })}\n${JSON.stringify({ type: "result", result })}\n`,
  );
}

test("image batches submit one reference at a time with pinned settings and header-only credentials", async (t) => {
  for (const provider of ["openrouter", "mflux"] as const) {
    await t.test(provider, async (t) => {
      const first = Promise.withResolvers<Response>();
      const requests = payloads(provider);
      const events: string[] = [];
      let calls = 0;
      let progress = 0;
      t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        const index = calls++;
        assert.equal(url, "/api/image/generate");
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(String(init.body)), requests[index]);
        assert.equal(new Headers(init.headers).get("X-OpenRouter-Api-Key"), provider === "openrouter" ? "volatile-test-key" : null);
        assert.equal(String(init.body).includes("volatile-test-key"), false);
        return index === 0 ? first.promise : response(provider);
      });
      const pending = generateImageBatch(requests, {
        sessionApiKey: "volatile-test-key",
        signal: new AbortController().signal,
        onStart: (index) => { events.push(`start ${index}`); },
        onResult: (index, image) => { assert.deepEqual(image, result); events.push(`result ${index}`); },
        onProgress: () => { progress += 1; },
      });
      await Promise.resolve();
      assert.equal(calls, 1, "Later references must wait for the first response");
      assert.deepEqual(events, ["start 0"]);
      first.resolve(response(provider));
      await pending;
      assert.equal(calls, 3);
      assert.deepEqual(events, ["start 0", "result 0", "start 1", "result 1", "start 2", "result 2"]);
      assert.equal(progress, provider === "mflux" ? 3 : 0);
    });
  }
});

test("failed, ambiguous, and aborted batches retain completed results without submitting remaining images", async (t) => {
  for (const outcome of ["rejected", "network", "broken stream", "abort during request", "abort after result", "already aborted"] as const) {
    await t.test(outcome, async (t) => {
      const controller = new AbortController();
      const provider = outcome === "broken stream" ? "mflux" : "openrouter";
      const completed: number[] = [];
      let calls = 0;
      t.mock.method(globalThis, "fetch", async () => {
        calls += 1;
        if (calls === 1) return response(provider);
        if (outcome === "rejected") return Response.json({ error: { message: "Rejected", type: "validation_error", retryable: false } }, { status: 400 });
        if (outcome === "network") throw new TypeError("Connection lost");
        if (outcome === "broken stream") return new Response('{"type":"progress"}\n');
        controller.abort();
        return response(provider); // A late success must not update a cleared/aborted workspace.
      });
      if (outcome === "already aborted") controller.abort();
      const pending = generateImageBatch(payloads(provider), {
        signal: controller.signal,
        onStart: () => undefined,
        onResult: (index) => {
          completed.push(index);
          if (outcome === "abort after result") controller.abort();
        },
        onProgress: () => undefined,
      });
      await assert.rejects(pending, outcome === "rejected"
        ? { name: "ApiError", status: 400, type: "validation_error" }
        : outcome === "network"
          ? { name: "ApiError", status: 0, type: "local_network_error" }
          : outcome === "broken stream"
            ? { name: "ApiError", type: "invalid_local_response" }
            : { name: "AbortError" });
      assert.equal(calls, outcome === "already aborted" ? 0 : outcome === "abort after result" ? 1 : 2);
      assert.deepEqual(completed, outcome === "already aborted" ? [] : [0]);
    });
  }
});
