"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

export default function WorkspaceLoading() {
  const [isSlow, setIsSlow] = useState(false);

  useEffect(() => {
    // First sign-ins provision the demo project while the dashboard renders;
    // reassure users when the wait exceeds what a warm visit normally takes.
    const timeout = setTimeout(() => setIsSlow(true), 4000);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-7 bg-background [background-image:radial-gradient(circle_at_12%_0%,oklch(0.91_0.035_235/0.45),transparent_27rem)] dark:[background-image:radial-gradient(circle_at_12%_0%,oklch(0.4_0.035_235/0.18),transparent_27rem)] px-6">
      <div className="flex flex-col items-center gap-2.5">
        <img src="/beeblio-mark.svg" alt="" className="size-9" />
        <span className="text-[1.15rem] font-semibold tracking-[-0.035em]">Beeblio</span>
      </div>
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Preparing Your Workspace…
        </div>
        {isSlow && (
          <p className="text-xs text-muted-foreground/80">
            Still setting things up — the first sign-in can take a little longer.
          </p>
        )}
      </div>
    </div>
  );
}
