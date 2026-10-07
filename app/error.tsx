"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RouteFallback } from "./_components/route-fallback";

/**
 * Catches rendering failures below the root layout. Without it, one failing
 * component replaces the whole window with Next's bare error text, which in
 * the desktop app leaves no way back but restarting it.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <RouteFallback
      title="Something went wrong"
      description={
        <>
          This page could not be shown. Your files are safe; try again, or go back to your projects.
          {error.digest ? <span className="mt-2 block font-mono text-[11px] text-muted-foreground/70">Reference {error.digest}</span> : null}
        </>
      }
    >
      <Button type="button" onClick={reset} autoFocus>
        <RotateCcw />Try again
      </Button>
      <Button variant="outline" asChild>
        <Link href="/workspace">Back to projects</Link>
      </Button>
    </RouteFallback>
  );
}
