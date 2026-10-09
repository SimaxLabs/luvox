import type { Request, RequestHandler, Response } from "express";

export function abortableRoute(
  handle: (request: Request, response: Response, signal: AbortSignal) => Promise<void>,
): RequestHandler {
  return async (request, response, next) => {
    const controller = new AbortController();
    const abortUpstream = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", abortUpstream);
    try {
      await handle(request, response, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) next(error);
    } finally {
      response.off("close", abortUpstream);
    }
  };
}
