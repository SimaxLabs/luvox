import {
  generateLocalVideo,
  initializeLocalH3Storage,
  LocalH3Error,
  shutdownLocalH3Storage,
} from "../../server/localH3.js";

try {
  await initializeLocalH3Storage();
  const job = process.argv[2] === "generate" ? await generateLocalVideo({
    provider: "local", prompt: "fake crash recovery", resolution: "256x256", frames: 22,
    quality: "draft", acceleration: "standard", seed: 42, frameFit: "contain", ssdStreaming: false,
  }, crypto.randomUUID()) : undefined;
  process.once("message", () => {
    void shutdownLocalH3Storage().then(() => process.disconnect());
  });
  process.send?.({ ready: true, jobId: job?.id });
} catch (error) {
  process.send?.({ error: error instanceof LocalH3Error ? error.type : String(error), message: String(error) });
  process.exitCode = 1;
  process.disconnect();
}
