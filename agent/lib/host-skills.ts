import { readFile } from "node:fs/promises";
import path from "node:path";

import { appRoot } from "../../lib/app-paths";

const HOST_SKILL_ENTRYPOINTS: Readonly<Record<string, string>> = {
  "bibliometric-analysis": "bibliometric-analysis.md",
  "data-cleaning-heuristics": "data-cleaning-heuristics.md",
  "data-visualization-styling": "data-visualization-styling.md",
  "docx": "beeblio-docx.md",
  "excalidraw-diagramming": "excalidraw-diagramming.md",
  "interactive-html-artifacts": "interactive-html-artifacts.md",
  "literature-matrix": "literature-matrix.md",
  "literature-search-synthesis": "literature-search-synthesis.md",
  "mermaid-diagramming": "mermaid-diagramming.md",
  "multimedia-processing": "multimedia-processing.md",
  "pdf": "pdf.md",
  "posterly": "posterly.md",
  "pptx": "beeblio-pptx.md",
  "science-scrollytelling": "science-scrollytelling.md",
  "statistical-interpretation": "statistical-interpretation.md",
  "survey-forms": "survey-forms.md",
  "svg-diagram": "svg-diagram.md",
  "template-presentations": "template-presentations.md",
  "xlsx": "beeblio-xlsx.md",
};

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export async function readHostSkill(skill: string): Promise<string | null> {
  const relativePath = HOST_SKILL_ENTRYPOINTS[skill];
  if (!relativePath) return null;
  // In `eve dev`, authored modules execute from a generated module-map, so
  // import.meta.url points into .eve/dev-hosts rather than agent/lib. The app
  // root (the checkout, or the desktop app's resources) is stable instead.
  const root = appRoot();
  const candidates = [
    path.resolve(root, "agent", "skills", relativePath),
    path.resolve(root, ".eve", "compile", "workspace-resources", "__root__", "skills", skill, "SKILL.md"),
    path.resolve(root, ".output", ".eve", "compile", "workspace-resources", "__root__", "skills", skill, "SKILL.md"),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const markdown = await readFile(candidate, "utf8");
      return markdown.replace(FRONTMATTER, "").trim();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Packaged project skill ${skill} is unavailable`, { cause: lastError });
}

export function hasHostSkill(skill: string): boolean {
  return Object.hasOwn(HOST_SKILL_ENTRYPOINTS, skill);
}
