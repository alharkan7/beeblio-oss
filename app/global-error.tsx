"use client";

import { useEffect } from "react";

import "./globals.css";

/**
 * Last resort for a failure in the root layout itself, where app/error.tsx
 * cannot help because the layout (theme, providers) is what failed. It has
 * to render its own document and so uses plain elements only.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
        <img src="/beeblio-mark.svg" alt="" className="size-9" />
        <h1 className="text-base font-semibold">Beeblio could not start this window</h1>
        <p className="max-w-sm text-sm text-muted-foreground">Your files are safe. Try again; if this keeps happening, restart the app.</p>
        <button type="button" onClick={reset} className="h-10 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">
          Try again
        </button>
      </body>
    </html>
  );
}
