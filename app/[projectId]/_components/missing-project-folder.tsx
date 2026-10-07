"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RouteFallback } from "@/app/_components/route-fallback";

/**
 * Shown instead of the workspace when a linked project folder was moved,
 * renamed, or is on a drive that is not connected. An empty workspace would
 * look like the files were gone, and invite adding new ones nowhere.
 */
export function MissingProjectFolder({ projectName, folderPath }: { projectName: string; folderPath: string }) {
  const router = useRouter();
  const [checking, startChecking] = useTransition();

  return (
    <RouteFallback
      title={`The folder for “${projectName}” is missing`}
      description={
        <>
          Beeblio cannot find
          <span className="my-2 block break-all rounded-lg border bg-card px-3 py-2 font-mono text-xs text-foreground">{folderPath}</span>
          If it was moved or is on a drive that is not connected, put it back and try again. Nothing in the project was changed.
        </>
      }
    >
      <Button type="button" onClick={() => startChecking(() => router.refresh())} disabled={checking} autoFocus>
        {checking ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        Try again
      </Button>
      <Button variant="outline" asChild>
        <Link href="/workspace">Back to projects</Link>
      </Button>
    </RouteFallback>
  );
}
