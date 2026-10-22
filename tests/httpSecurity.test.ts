import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Node fetch rewrites Host; send a real HTTP request to exercise the hostname guard.
function post(url: string, body: unknown, headers: Record<string, string>) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const outgoing = request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRouter-Api-Key": "fake-test-key", ...headers },
    }, (response) => {
      let contents = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { contents += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve({ status: response.statusCode!, body: JSON.parse(contents) }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify(body));
  });
}

test("HTTP generation routes reject forbidden hosts and origins before calling the provider", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luvox-http-test-"));
  const child = fork(new URL("./fixtures/httpServer.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: directory,
      HOST: "127.0.0.1",
      OPENROUTER_API_KEY: "",
      LUVOX_DATA_DIR: path.join(directory, "data"),
      H3_JOBS_DIR: path.join(directory, "jobs"),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => { diagnostics += chunk; });
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([
      once(child, "message").then(([message]) => message as { port: number }),
      exited.then(() => { throw new Error(`Test server exited before listening: ${diagnostics}`); }),
    ]);
    const base = `http://127.0.0.1:${ready.port}`;
    const inputs = [
      ["image", { provider: "openrouter", model: "meta/muse-image", prompt: "test image" }],
      ["video", { provider: "openrouter", model: "minimax/hailuo-3", prompt: "test video", duration: 6, aspectRatio: "16:9", resolution: "2K" }],
    ] as const;
    for (const [kind, input] of inputs) {
      const forbiddenHeaders: Record<string, string>[] = [
        { Host: "evil.example" },
        { Host: "evil.example", "X-Forwarded-Host": "localhost" },
        { Origin: "https://evil.example" },
        { Origin: "null" },
        { Origin: "not a URL" },
      ];
      for (const forbidden of forbiddenHeaders) {
        const response = await post(`${base}/api/${kind}/generate`, input, forbidden);
        assert.equal(response.status, 403, `${kind}: ${JSON.stringify(forbidden)}`);
        assert.equal(response.body.error.type, "local_request_forbidden");
      }
    }
    const count = once(child, "message");
    child.send("count");
    assert.equal((await count)[0].providerCalls, 0);

    for (const [kind, input] of inputs) {
      const response = await post(`${base}/api/${kind}/generate`, input, { Origin: "http://localhost:3000" });
      assert.equal(response.status, kind === "video" ? 202 : 200);
    }
    const finalCount = once(child, "message");
    child.send("count");
    assert.equal((await finalCount)[0].providerCalls, 2);
  } finally {
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(forceKill);
    await rm(directory, { recursive: true, force: true });
  }
});
