import assert from "node:assert/strict";
import test from "node:test";

import { errorDetail } from "../lib/error-detail";

test("errorDetail shows an error's own message", () => {
  assert.equal(errorDetail(new Error("Folder is read-only"), "Try again"), "Folder is read-only");
});

test("errorDetail hides the message Next.js puts in place of a server error", () => {
  const redacted = new Error(
    "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.",
  );
  assert.equal(errorDetail(redacted, "Try again"), "Try again");
  assert.equal(errorDetail(redacted), undefined);
});

test("errorDetail hides React's minified error that production clients receive", () => {
  const minified = new Error("Minified React error #441; visit https://react.dev/errors/441 for the full message.");
  assert.equal(errorDetail(minified, "Try again"), "Try again");
});

test("errorDetail falls back for empty messages and non-errors", () => {
  assert.equal(errorDetail(new Error("  "), "Try again"), "Try again");
  assert.equal(errorDetail("boom", "Try again"), "Try again");
  assert.equal(errorDetail(undefined), undefined);
});
