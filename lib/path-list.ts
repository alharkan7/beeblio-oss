/**
 * Joins PATH-style lists in order of preference, dropping empty and repeated
 * entries. The delimiter is a parameter because the list being built may be
 * for another platform than the one running the code (tests, mainly).
 * Free of imports so the desktop app's main process can share it.
 */
export function mergePaths(lists: ReadonlyArray<string | undefined>, delimiter: string): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const list of lists) {
    for (const entry of (list ?? "").split(delimiter)) {
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        entries.push(entry);
      }
    }
  }
  return entries.join(delimiter);
}
