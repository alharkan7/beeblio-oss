import type { ReactNode } from "react";

/**
 * The full-page frame for the error and not-found screens, matching the
 * workspace loading screen so a failure looks like part of the app rather
 * than a blank or framework page.
 */
export function RouteFallback({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  /** The actions, such as "Try again" and "Back to projects". */
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-7 bg-background [background-image:radial-gradient(circle_at_12%_0%,oklch(0.91_0.035_235/0.45),transparent_27rem)] dark:[background-image:radial-gradient(circle_at_12%_0%,oklch(0.4_0.035_235/0.18),transparent_27rem)] px-6 text-foreground">
      <div className="flex flex-col items-center gap-2.5">
        <img src="/beeblio-mark.svg" alt="" className="size-9" />
        <span className="text-[1.15rem] font-semibold tracking-[-0.035em]">Beeblio</span>
      </div>
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <h1 className="text-base font-semibold tracking-[-0.01em]">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children ? <div className="flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </main>
  );
}
