/**
 * In production builds, which the desktop app is, an error thrown in a server
 * action reaches the browser without its message: React's client gives it a
 * minified-error pointer (#441), and the server's own text is boilerplate.
 * Shown in a toast either reads as a crash report, so both count as no detail.
 */
const REDACTED_SERVER_ERROR = /Minified React error #\d+|omitted in production builds|An error occurred in the Server Components render/;

/**
 * The part of a caught error worth showing a person: its message, unless
 * there is none or Next redacted it, in which case `fallback`.
 */
export function errorDetail(error: unknown, fallback: string): string;
export function errorDetail(error: unknown, fallback?: string): string | undefined;
export function errorDetail(error: unknown, fallback?: string): string | undefined {
  const message = error instanceof Error ? error.message.trim() : "";
  return message && !REDACTED_SERVER_ERROR.test(message) ? message : fallback;
}
