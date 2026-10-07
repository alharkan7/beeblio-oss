import type { ReactNode } from "react";

/**
 * Fills the Beeblio AI panel when its conversation cannot be shown, so the
 * rest of the workspace (editor, files, open tabs) stays usable.
 */
export function ConversationFallback({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center" role="alert">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</p>
      {children ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  );
}
