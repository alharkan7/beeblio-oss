import {
  FileText,
  FolderOpen,
  Lightbulb,
  BookOpenText,
  Table2,
  PencilSparkles,
  type LucideIcon,
  ChartColumnIncreasing, FileImage,
} from "lucide-react";

import type { ResearchArtifactView } from "./research-artifact-browser";

export type Activity =
  | "files"
  | "literature"
  | "knowledge"
  | "skills"
  | Exclude<ResearchArtifactView, "references">
  | "project";

export const activities: { id: Activity; label: string; icon: LucideIcon }[] = [
  { id: "literature", label: "Literature", icon: BookOpenText },
  { id: "knowledge", label: "Knowledge", icon: Lightbulb },
  { id: "data", label: "Data", icon: Table2 },
  { id: "analysis", label: "Analysis", icon: ChartColumnIncreasing },
  { id: "reports", label: "Reports", icon: FileText },
  { id: "figures", label: "Figures", icon: FileImage },
  { id: "files", label: "File Manager", icon: FolderOpen },
  // { id: "project", label: "Project Info", icon: Info },
];

// Rendered in the bottom rail group (above Usage & Credits) rather than with
// the project activities: skills are user-scoped, not part of the research
// artifact views.
export const SKILLS_RAIL_ITEM: { id: Activity; label: string; icon: LucideIcon } = {
  id: "skills",
  label: "Agent Skills",
  icon: PencilSparkles,
};

// Guards the remembered-activity restore: a stored id that is no longer
// rendered in the rail (e.g. from an older build) falls back to the default.
const railActivityIds = new Set<Activity>([...activities.map(({ id }) => id), SKILLS_RAIL_ITEM.id]);

// Stored ids from older builds that should restore to their merged successor.
const legacyActivityAliases: Partial<Record<string, Activity>> = {
  bibliography: "literature",
};

export function rememberedRailActivity(value: string | undefined | null): Activity | undefined {
  if (!value) return undefined;
  const aliased = legacyActivityAliases[value] ?? value;
  return railActivityIds.has(aliased as Activity) ? (aliased as Activity) : undefined;
}

// Persisted as a cookie scoped to the project path so the server layout can
// render the remembered panel in the initial HTML instead of flashing the
// File Explorer default before a client-side restore. Only call from the
// client: it touches document.cookie.
export function rememberRailActivity(projectId: string, activity: Activity) {
  document.cookie = `beeblio:${projectId}:rail-activity=${activity}; path=/${projectId}; max-age=31536000; samesite=lax`;
}

// The research views are introduced together, so they share one tour target
// (see app/_components/onboarding/tour-steps.ts).
const RESEARCH_OUTPUT_ACTIVITIES = new Set<Activity>(["data", "analysis", "reports", "figures"]);

export function railTourTarget(activity: Activity): string {
  return RESEARCH_OUTPUT_ACTIVITIES.has(activity) ? "rail-output" : `rail-${activity}`;
}
