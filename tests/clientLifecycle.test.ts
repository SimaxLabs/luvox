import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import App from "../src/App.js";
import { OPENROUTER_IMAGE_MODELS } from "../shared/imageModels.js";
import { VIDEO_MODELS } from "../shared/videoModels.js";
import type { VideoJob } from "../src/api.js";
import type { SavedPrompt } from "../shared/savedPrompts.js";

const image = { b64Json: "iVBORw0KGgo=", mediaType: "image/png" };
const localId = "local_00000000-0000-4000-8000-000000000001";
const video = (id = "paid-video", status: VideoJob["status"] = "queued"): VideoJob => ({
  id,
  provider: id.startsWith("local_") ? "local" : "openrouter",
  status,
  ...(status === "completed" ? { videoUrl: `/api/video/content/${id}` } : {}),
});
const mfluxResult = () => new Response(`${JSON.stringify({ type: "result", result: image })}\n`);
const config = (sessionId = "same-server") => ({
  sessionId,
  localH3: { supported: true, configured: false },
  localMflux: { supported: true, models: ["flux2-klein-4b", "flux2-klein-9b"] },
  openRouter: { revision: 0, images: OPENROUTER_IMAGE_MODELS, videos: VIDEO_MODELS, customImageIds: [], customVideoIds: [] },
});
type Call = { url: string; init: RequestInit; body?: Record<string, any> };

async function mount(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost:3000" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  t.mock.method(dom.window, "confirm", () => true);
  Object.assign(dom.window.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.open = true; },
    close(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new dom.window.Event("close")); },
  });
  const objectUrls = t.mock.method(URL, "createObjectURL", () => "blob:http://localhost:3000/test-video");
  t.mock.method(URL, "revokeObjectURL", () => {});
  const calls: Call[] = [];
  const api = {
    config: async (_call: Call) => Response.json(config()),
    savedPrompts: async (_call: Call) => Response.json({ version: 1, prompts: [] }),
    generateVideo: async (_call: Call) => Response.json(video()),
    generateImage: async (call: Call) => call.body?.provider === "mflux" ? mfluxResult() : Response.json(image),
    poll: async (_call: Call) => Response.json(video()),
    renew: async (_call: Call) => Response.json({ renewed: true }),
    discard: async (_call: Call) => Response.json({ cleared: true }),
    remove: async (_call: Call) => Response.json({ deleted: true, released: true }),
    upload: async (_call: Call) => Response.json({ path: "/staged/reference.png", token: crypto.randomUUID() }),
  };
  t.mock.method(globalThis, "fetch", async (url, init: RequestInit = {}) => {
    const call: Call = { url: String(url), init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url === "/api/config") return api.config(call);
    if (url === "/api/saved-prompts") return api.savedPrompts(call);
    if (url === "/api/local/workspace") return init.method === "PUT" ? api.renew(call) : api.discard(call);
    if (url === "/api/local/reference-image") return init.method === "POST" ? api.upload(call) : Response.json({ deleted: true });
    if (url === "/api/video/generate") return api.generateVideo(call);
    if (url === "/api/image/generate") return api.generateImage(call);
    if (String(url).startsWith("/api/video/status/")) return api.poll(call);
    if (String(url).startsWith("/api/video/content/")) return new Response("fake video", { headers: { "Content-Type": "video/mp4" } });
    if (init.method === "DELETE") return api.remove(call);
    throw new Error(`Unexpected test request: ${url}`);
  });
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    t.mock.timers.reset();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(createElement(App)));
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
    assert.ok(found, `Button not found: ${label}`);
    return found;
  };
  const click = async (label: string) => {
    const node = button(label);
    assert.equal(node.matches(":disabled"), false, `Button disabled: ${label}`);
    await act(async () => node.click());
  };
  const fill = async (id: string, value: string) => {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    assert.ok(input, `Input not found: ${id}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => { container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  };
  const selectJob = async (id: string) => {
    const node = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(id));
    assert.ok(node, `Job not found: ${id}`);
    await act(async () => node.click());
  };
  const advance = async (ms: number) => { await act(async () => { t.mock.timers.tick(ms); }); };
  const generations = () => calls.filter((call) => call.url.endsWith("/generate"));
  return { dom, container, api, calls, objectUrls, button, click, fill, submit, selectJob, advance, generations };
}

test("prompt migration keeps the browser copy until every record is saved", async (t) => {
  for (const scenario of ["complete", "invalid record", "save failure"]) {
    await t.test(scenario, async (t) => {
      const ui = await mount(t);
      const prompt: SavedPrompt = { id: crypto.randomUUID(), name: "Browser prompt", prompt: "A red kite", createdAt: "2026-09-07T12:00:00.000Z" };
      const records = [prompt, ...(scenario === "invalid record" ? [{ ...prompt, id: crypto.randomUUID(), settings: { kind: "mflux" } }] : [])];
      const source = JSON.stringify({ version: 1, prompts: records });
      ui.dom.window.localStorage.setItem("luvox.saved-prompts.v1", source);
      let saved: SavedPrompt[] = [];
      ui.api.savedPrompts = async (call) => {
        if (call.init.method === "PUT") {
          assert.deepEqual(call.body, prompt);
          if (scenario === "save failure") return Response.json({ error: { message: "Disk full", retryable: false } }, { status: 500 });
          saved = [prompt];
        }
        return Response.json({ version: 1, prompts: saved });
      };
      await ui.click("Saved prompts");
      assert.equal(ui.dom.window.localStorage.getItem("luvox.saved-prompts.v1"), scenario === "complete" ? null : source);
      const dialog = ui.container.querySelector<HTMLDialogElement>('dialog[aria-labelledby="prompt-library-title"]')!;
      if (scenario === "invalid record") {
        assert.match(dialog.textContent!, /Browser prompt data is invalid.*original browser copy has been kept/);
        assert.deepEqual(saved, []);
      } else if (scenario === "save failure") assert.match(dialog.textContent!, /could not be fully migrated.*Disk full/);
      else assert.ok(dialog.textContent!.includes(prompt.name));
    });
  }
});

test("opening the prompt library refreshes additions and deletions and retries failed loads", async (t) => {
  const ui = await mount(t);
  const prompt: SavedPrompt = { id: crypto.randomUUID(), name: "Saved in another tab", prompt: "A red kite", createdAt: "2026-09-07T12:00:00.000Z" };
  let saved: SavedPrompt[] = [];
  const respond = async () => Response.json({ version: 1, prompts: saved });
  ui.api.savedPrompts = respond;
  const dialog = ui.container.querySelector<HTMLDialogElement>('dialog[aria-labelledby="prompt-library-title"]')!;
  const close = async () => { await act(async () => dialog.querySelector<HTMLButtonElement>("button")!.click()); };
  await ui.click("Saved prompts");
  assert.match(dialog.textContent!, /No saved prompts yet/);
  await close();
  saved = [prompt];
  await ui.click("Saved prompts");
  assert.ok(dialog.textContent!.includes(prompt.name));
  await close();
  saved = [];
  await ui.click("Saved prompts");
  assert.ok(!dialog.textContent!.includes(prompt.name));
  await close();
  ui.api.savedPrompts = async () => Response.json({ error: { message: "Storage unavailable", retryable: false } }, { status: 503 });
  await ui.click("Saved prompts");
  assert.match(dialog.textContent!, /Storage unavailable/);
  await close();
  ui.api.savedPrompts = respond;
  saved = [prompt];
  await ui.click("Saved prompts");
  assert.ok(dialog.textContent!.includes(prompt.name));
  assert.ok(!dialog.textContent!.includes("Storage unavailable"));
  assert.equal(ui.calls.filter((call) => call.url === "/api/saved-prompts").length, 5);
});

test("server restarts and sustained outages preserve paid locks and ignore late submissions", async (t) => {
  for (const scenario of ["restart", "offline"]) {
    await t.test(scenario, async (t) => {
      const ui = await mount(t);
      const pendingVideo = Promise.withResolvers<Response>();
      const pendingImage = Promise.withResolvers<Response>();
      ui.api.generateVideo = () => pendingVideo.promise;
      ui.api.generateImage = () => pendingImage.promise;
      await ui.fill("prompt", "Pending paid video");
      await ui.submit();
      await ui.click("Text to image");
      await ui.fill("image-prompt", "Pending paid image");
      await ui.submit();
      if (scenario === "restart") {
        ui.api.config = async () => Response.json(config("new-server"));
      } else {
        ui.api.config = async () => { throw new TypeError("API offline"); };
        await ui.advance(3_000);
        await ui.advance(3_000);
        assert.ok(ui.generations().every((call) => !call.init.signal!.aborted), "Short outages must not reset the workspace");
      }
      await ui.advance(3_000);
      assert.equal(ui.generations().length, 2);
      assert.ok(ui.generations().every((call) => call.init.signal!.aborted));
      assert.equal(ui.container.querySelector<HTMLTextAreaElement>("#prompt")!.value, "");
      if (scenario === "offline") {
        ui.api.config = async () => Response.json(config());
        await ui.advance(3_000);
      }
      await ui.fill("prompt", "Duplicate paid video");
      await ui.submit();
      await ui.click("Text to image");
      assert.equal(ui.container.querySelector<HTMLTextAreaElement>("#image-prompt")!.value, "");
      await ui.fill("image-prompt", "Duplicate paid image");
      await ui.submit();
      assert.equal(ui.generations().length, 2);

      await act(async () => {
        pendingVideo.resolve(Response.json(video("late-paid-video", "completed")));
        pendingImage.resolve(Response.json(image));
      });
      assert.ok(!ui.container.querySelector('a[download="openrouter-image.png"]'));
      assert.ok(!ui.container.textContent!.includes("late-paid-video"));
      await ui.submit();
      await ui.click("Text to video");
      await ui.submit();
      assert.equal(ui.generations().length, 2, "Late success must not unlock either paid slot");
      assert.ok(!ui.container.querySelector("video"));
      await ui.click("Unlock retry");
      ui.api.generateVideo = async () => Response.json(video("explicit-retry"));
      await ui.fill("prompt", "Explicit retry");
      await ui.submit();
      assert.equal(ui.generations().length, 3);
    });
  }
});

test("all four client slots can overlap, reject duplicate submits, and keep submitted credentials", async (t) => {
  const ui = await mount(t);
  const remoteVideo = Promise.withResolvers<Response>();
  const localVideo = Promise.withResolvers<Response>();
  const remoteImage = Promise.withResolvers<Response>();
  const localImage = Promise.withResolvers<Response>();
  ui.api.generateVideo = (call) => call.body?.provider === "local" ? localVideo.promise : remoteVideo.promise;
  ui.api.generateImage = (call) => call.body?.provider === "mflux" ? localImage.promise : remoteImage.promise;

  await ui.fill("session-api-key", "submitted-video-key");
  await ui.fill("prompt", "Submitted video prompt");
  await ui.submit();
  await ui.submit();
  assert.equal(ui.generations().length, 1);
  await ui.click("Text to image");
  await ui.fill("image-prompt", "Submitted image prompt");
  await ui.fill("session-api-key", "submitted-image-key");
  await ui.submit();
  await ui.submit();
  await ui.click("MFLUX");
  await ui.submit();
  await ui.submit();
  await ui.click("Text to video");
  await ui.click("h3.c");
  await ui.submit();
  await ui.submit();
  assert.deepEqual(ui.generations().map((call) => [call.url, call.body?.provider]), [
    ["/api/video/generate", "openrouter"], ["/api/image/generate", "openrouter"],
    ["/api/image/generate", "mflux"], ["/api/video/generate", "local"],
  ]);
  assert.equal(ui.generations()[0].body?.prompt, "Submitted video prompt");
  assert.equal(new Headers(ui.generations()[0].init.headers).get("X-OpenRouter-Api-Key"), "submitted-video-key");
  assert.equal(new Headers(ui.generations()[1].init.headers).get("X-OpenRouter-Api-Key"), "submitted-image-key");
  for (const call of ui.generations()) assert.ok(!JSON.stringify(call.body).includes("-key"));
  for (const call of ui.generations().slice(2)) assert.equal(new Headers(call.init.headers).has("X-OpenRouter-Api-Key"), false);

  await act(async () => {
    remoteVideo.resolve(Response.json(video()));
    localVideo.resolve(Response.json(video(localId)));
    remoteImage.resolve(Response.json(image));
    localImage.resolve(mfluxResult());
  });
  await ui.click("OpenRouter");
  await ui.fill("session-api-key", "later-key");
  await ui.submit();
  assert.equal(ui.generations().length, 4, "A queued video must keep its slot");
  ui.api.poll = async (call) => Response.json(video(call.url.split("/").at(-1), "processing"));
  await ui.advance(3_000);
  await ui.submit();
  assert.equal(ui.generations().length, 4, "A processing video must keep its slot");
  ui.api.poll = async (call) => Response.json(video(call.url.split("/").at(-1), "completed"));
  await ui.advance(10_000);
  await ui.selectJob("paid-video");
  for (const call of ui.calls.filter((call) => /\/(status|content)\/paid-video$/.test(call.url))) {
    assert.equal(new Headers(call.init.headers).get("X-OpenRouter-Api-Key"), "submitted-video-key");
  }
  await ui.submit();
  assert.equal(ui.generations().length, 5, "Completion must unlock the slot");
  assert.equal(new Headers(ui.generations()[4].init.headers).get("X-OpenRouter-Api-Key"), "later-key");
});

test("uncertain submissions stay locked across view changes until Clear, for every type", async (t) => {
  for (const kind of ["image", "mflux", "openrouter", "local"]) {
    await t.test(kind, async (t) => {
      const ui = await mount(t);
      const unknown = async () => { throw new TypeError("Connection lost after submission"); };
      ui.api.generateVideo = unknown;
      ui.api.generateImage = kind === "mflux" ? async () => new Response('{"type":"progress"}\n') : unknown;
      const imageWorkflow = kind === "image" || kind === "mflux";
      if (imageWorkflow) await ui.click("Text to image");
      if (kind === "mflux") await ui.click("MFLUX");
      if (kind === "local") await ui.click("h3.c");
      const prompt = imageWorkflow ? "image-prompt" : "prompt";
      await ui.fill(prompt, "Keep the slot locked");
      await ui.submit();
      await ui.submit();
      assert.equal(ui.generations().length, 1);
      await ui.click(imageWorkflow ? "Text to video" : "Text to image");
      await ui.click(imageWorkflow ? "Text to image" : "Text to video");
      await ui.submit();
      assert.equal(ui.generations().length, 1);
      await ui.click("Unlock retry");
      await ui.fill(prompt, "Explicit retry");
      await ui.submit();
      assert.equal(ui.generations().length, 2);
    });
  }
});

test("a stopped status poll keeps the paid video slot locked", async (t) => {
  const ui = await mount(t);
  await ui.fill("prompt", "Paid video");
  await ui.submit();
  ui.api.poll = async () => Response.json({ error: { message: "Key rejected", retryable: false } }, { status: 401 });
  await ui.advance(3_000);
  assert.match(ui.container.textContent!, /Automatic status checks stopped/);
  await ui.submit();
  assert.equal(ui.generations().length, 1);
  await ui.advance(30_000);
  assert.equal(ui.calls.filter((call) => call.url.includes("/status/")).length, 1);
});

test("a known submission rejection unlocks its slot", async (t) => {
  const ui = await mount(t);
  ui.api.generateVideo = async () => Response.json({ error: { message: "Rejected", type: "validation_error", retryable: false } }, { status: 400 });
  await ui.fill("prompt", "Rejected request");
  await ui.submit();
  await ui.submit();
  assert.equal(ui.generations().length, 2);
});

test("h3.c expiry preserves paid jobs, credentials, image results, prompts, and running MFLUX", async (t) => {
  const ui = await mount(t);
  const localImage = Promise.withResolvers<Response>();
  ui.api.generateVideo = async (call) => Response.json(video(call.body?.provider === "local" ? localId : "paid-video"));
  ui.api.generateImage = (call) => call.body?.provider === "mflux" ? localImage.promise : Promise.resolve(Response.json(image));
  ui.api.poll = async (call) => Response.json(video(call.url.split("/").at(-1), "processing"));
  await ui.fill("session-api-key", "pinned-key");
  await ui.fill("prompt", "Keep this unsaved video prompt");
  await ui.submit();
  await ui.click("Text to image");
  await ui.fill("image-prompt", "Keep this unsaved image prompt");
  await ui.submit();
  await ui.click("MFLUX");
  await ui.submit();
  const mfluxCall = ui.generations().at(-1)!;
  await ui.click("Text to video");
  await ui.click("h3.c");
  await ui.fill("local-first-frame-path", "/manual/reference.png");
  await ui.submit();
  await ui.selectJob("paid-video");
  await ui.fill("session-api-key", "edited-key");
  const oldToken = new Headers(ui.calls.find((call) => call.url === "/api/local/workspace")!.init.headers).get("X-Luvox-Workspace-Token");
  ui.api.renew = async (call) => new Headers(call.init.headers).get("X-Luvox-Workspace-Token") === oldToken
    ? Response.json({ error: { message: "Expired", retryable: false } }, { status: 410 })
    : Response.json({ renewed: true });
  await ui.advance(30_000);
  assert.ok(ui.container.textContent!.includes("paid-video"));
  assert.ok(!ui.container.textContent!.includes(localId));
  assert.equal(ui.container.querySelector<HTMLTextAreaElement>("#prompt")!.value, "Keep this unsaved video prompt");
  assert.equal(ui.container.querySelector<HTMLInputElement>("#session-api-key")!.value, "edited-key");
  assert.equal(mfluxCall.init.signal!.aborted, false);
  await ui.submit();
  assert.equal(ui.generations().length, 4);
  ui.api.poll = async () => Response.json(video("paid-video", "completed"));
  await ui.advance(10_000);
  assert.ok(ui.container.querySelector("video"));
  assert.equal(new Headers(ui.calls.find((call) => call.url === "/api/video/content/paid-video")!.init.headers).get("X-OpenRouter-Api-Key"), "pinned-key");
  await ui.click("h3.c");
  assert.equal(ui.container.querySelector<HTMLInputElement>("#local-first-frame-path")!.value, "");
  await ui.click("Text to image");
  assert.equal(ui.container.querySelector<HTMLTextAreaElement>("#image-prompt")!.value, "Keep this unsaved image prompt");
  await act(async () => localImage.resolve(mfluxResult()));
  assert.ok(ui.container.querySelector('a[download="mflux-image.png"]'));
  await ui.click("OpenRouter");
  assert.ok(ui.container.querySelector('a[download="openrouter-image.png"]'));
});

test("late local submissions from an expired workspace cannot restore a job or unlock its replacement", async (t) => {
  const ui = await mount(t);
  const oldSubmission = Promise.withResolvers<Response>();
  const newSubmission = Promise.withResolvers<Response>();
  ui.api.generateVideo = () => oldSubmission.promise;
  await ui.click("h3.c");
  await ui.fill("prompt", "Pending local video");
  await ui.submit();
  const oldCall = ui.generations()[0];
  ui.api.renew = async () => Response.json({ error: { message: "Expired", retryable: false } }, { status: 410 });
  await ui.advance(30_000);
  assert.equal(oldCall.init.signal!.aborted, true);
  ui.api.generateVideo = () => newSubmission.promise;
  await ui.submit();
  assert.equal(ui.generations().length, 2);
  assert.notEqual(new Headers(oldCall.init.headers).get("X-Luvox-Workspace-Token"), new Headers(ui.generations()[1].init.headers).get("X-Luvox-Workspace-Token"));
  await act(async () => oldSubmission.resolve(Response.json(video(localId))));
  assert.ok(!ui.container.textContent!.includes(localId));
  await ui.submit();
  assert.equal(ui.generations().length, 2);
  const replacement = localId.replace(/1$/, "2");
  await act(async () => newSubmission.resolve(Response.json(video(replacement))));
  assert.ok(ui.container.textContent!.includes(replacement));
});

test("late uploads from an expired workspace cannot restore reference paths", async (t) => {
  const ui = await mount(t);
  const upload = Promise.withResolvers<Response>();
  ui.api.upload = () => upload.promise;
  await ui.click("h3.c");
  const picker = ui.container.querySelector<HTMLInputElement>("#local-first-frame-picker")!;
  Object.defineProperty(picker, "files", { value: [new ui.dom.window.File(["fake"], "reference.png")] });
  await act(async () => { picker.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true })); });
  ui.api.renew = async () => Response.json({ error: { message: "Expired", retryable: false } }, { status: 410 });
  await ui.advance(30_000);
  await act(async () => upload.resolve(Response.json({ path: "/old/reference.png", token: crypto.randomUUID() })));
  assert.equal(ui.container.querySelector<HTMLInputElement>("#local-first-frame-path")!.value, "");
  assert.ok(ui.calls.some((call) => call.url === "/api/local/reference-image" && call.init.method === "DELETE"));
});

test("late local deletion cannot unlock a replacement deletion after expiry", async (t) => {
  const ui = await mount(t);
  const oldDeletion = Promise.withResolvers<Response>();
  const newDeletion = Promise.withResolvers<Response>();
  ui.api.generateVideo = async () => Response.json(video(localId, "failed"));
  ui.api.remove = () => oldDeletion.promise;
  await ui.click("h3.c");
  await ui.fill("prompt", "Failed video");
  await ui.submit();
  await ui.click("Delete job");
  ui.api.renew = async () => Response.json({ error: { message: "Expired", retryable: false } }, { status: 410 });
  await ui.advance(30_000);
  ui.api.generateVideo = async () => Response.json(video(localId.replace(/1$/, "2"), "failed"));
  ui.api.remove = () => newDeletion.promise;
  await ui.submit();
  await ui.click("Delete job");
  await act(async () => oldDeletion.resolve(Response.json({ deleted: true })));
  assert.equal(ui.button("Deleting...").disabled, true);
  await act(async () => newDeletion.resolve(Response.json({ deleted: true })));
  assert.ok(!ui.container.textContent!.includes("local_"));
});

test("late Clear responses cannot invalidate the replacement h3.c workspace after expiry", async (t) => {
  for (const outcome of ["success", "error"]) {
    await t.test(outcome, async (t) => {
      const ui = await mount(t);
      const cleanup = Promise.withResolvers<Response>();
      ui.api.discard = () => cleanup.promise;
      ui.api.generateVideo = async () => Response.json(video(localId, "failed"));
      await ui.click("h3.c");
      await ui.click("Clear");
      ui.api.renew = async () => Response.json({ error: { message: "Expired", retryable: false } }, { status: 410 });
      await ui.advance(30_000);
      await ui.fill("prompt", "New workspace");
      await ui.submit();
      assert.equal(ui.generations().length, 1);
      await act(async () => cleanup.resolve(outcome === "success" ? Response.json({ cleared: true })
        : Response.json({ error: { message: "Old cleanup failed", retryable: false } }, { status: 500 })));
      assert.ok(!ui.container.textContent!.includes("Local workspace cleanup could not be confirmed"));
      await ui.submit();
      assert.equal(ui.generations().length, 2);
      assert.equal(new Headers(ui.generations()[0].init.headers).get("X-Luvox-Workspace-Token"),
        new Headers(ui.generations()[1].init.headers).get("X-Luvox-Workspace-Token"));
    });
  }
});

test("reselecting the current video keeps its preview, and failed jobs can be deleted", async (t) => {
  const ui = await mount(t);
  ui.api.generateVideo = async () => Response.json({ ...video("paid-video", "completed"), capabilityToken: crypto.randomUUID() });
  await ui.fill("prompt", "A completed video");
  await ui.submit();
  const source = ui.container.querySelector("video")!.src;
  await ui.selectJob("paid-video");
  await ui.selectJob("paid-video");
  assert.equal(ui.container.querySelector("video")!.src, source);
  assert.equal(ui.objectUrls.mock.callCount(), 1);
  assert.ok(ui.container.querySelector(`a[href="${source}"][download]`));
  ui.api.generateVideo = async () => Response.json({ ...video(localId, "failed"), error: "Fake engine failure" });
  await ui.click("h3.c");
  await ui.submit();
  assert.match(ui.container.textContent!, /Fake engine failure/);
  await ui.click("Delete job");
  assert.ok(ui.calls.some((call) => call.url === `/api/local/video/${localId}` && call.init.method === "DELETE"));
  assert.ok(!ui.container.textContent!.includes(localId));
  assert.ok(ui.container.textContent!.includes("paid-video"));
  ui.api.generateVideo = async () => Response.json({ ...video("failed-paid-video", "failed"), capabilityToken: crypto.randomUUID() });
  await ui.click("OpenRouter");
  await ui.submit();
  await ui.click("Delete job");
  assert.ok(ui.calls.some((call) => call.url === "/api/video/failed-paid-video" && call.init.method === "DELETE"));
  assert.ok(!ui.container.textContent!.includes("failed-paid-video"));
});
