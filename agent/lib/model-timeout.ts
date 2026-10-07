import { appSetting } from "../../lib/app-settings";

// Local turns have no wall-clock deadline. An optional request timeout can be
// configured for installations that want to bound a single OpenRouter call.
export function timedModelFetch(): typeof fetch {
  return (input, init) => {
    const timeoutMs = Number(appSetting("OPENROUTER_REQUEST_TIMEOUT_MS"));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return fetch(input, init);
    const timeout = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    return fetch(input, { ...init, signal });
  };
}
