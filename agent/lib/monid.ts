import { appSetting } from "../../lib/app-settings";

const MONID_API_URL = "https://api.monid.ai/v1/run";
const MONID_TIMEOUT_MS = 120_000;

type MonidRun = {
  status?: string;
  output?: unknown;
  providerResponse?: {
    httpStatus?: number;
    error?: unknown;
  };
  message?: string;
};

function getMonidApiKey() {
  const apiKey = appSetting("MONID_API_KEY");
  if (!apiKey) {
    throw new Error("Add a Monid API key in Settings → API Keys.");
  }
  return apiKey;
}

function errorMessage(value: unknown) {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return JSON.stringify(value);
}

export async function runTinyfish(
  endpoint: "/search" | "/fetch",
  input: Record<string, unknown>,
  options: { queryParams?: boolean; signal?: AbortSignal } = {},
) {
  const timeoutSignal = AbortSignal.timeout(MONID_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(MONID_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getMonidApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: "tinyfish",
      endpoint,
      ...(options.queryParams ? { queryParams: input } : { input }),
    }),
    signal,
  });
  const result = (await response.json().catch(() => null)) as MonidRun | null;

  if (!response.ok) {
    throw new Error(
      `Monid ${endpoint} failed (${response.status}): ${errorMessage(result)}`,
    );
  }

  const providerStatus = result?.providerResponse?.httpStatus;
  if (
    providerStatus !== undefined &&
    (providerStatus < 200 || providerStatus >= 300)
  ) {
    throw new Error(
      `TinyFish ${endpoint} failed (${providerStatus}): ${errorMessage(result?.providerResponse?.error)}`,
    );
  }

  if (result?.status !== "COMPLETED") {
    throw new Error(
      `TinyFish ${endpoint} did not complete (status: ${result?.status ?? "unknown"}).`,
    );
  }

  return result.output;
}
