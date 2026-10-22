import { createServer } from "node:net";

const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address();
if (!address || typeof address === "string") throw new Error("No test port available");
await new Promise<void>((resolve) => reservation.close(() => resolve()));
process.env.PORT = String(address.port);

let providerCalls = 0;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith("https://openrouter.ai/api/v1/") || init?.method !== "POST") {
    throw new Error("Unexpected provider call in HTTP test");
  }
  providerCalls += 1;
  return String(url).endsWith("/videos")
    ? Response.json({ id: "http-test-video", polling_url: "/videos/http-test-video", status: "pending" })
    : Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] });
};
process.on("message", () => process.send?.({ providerCalls }));
await import("../../server/index.js");
setImmediate(() => process.send?.({ port: address.port }));
