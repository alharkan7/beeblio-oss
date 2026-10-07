/**
 * The workspace tour, in order. Each step points at elements marked with
 * `data-tour="<target>"`; the first target that is on screen wins, and all of
 * its matches are outlined together (the research views are one step). A step
 * with nothing on screen is skipped, so the tour adapts to the mobile layout
 * and to panels that are closed.
 */
export type TourStep = {
  id: string;
  targets: readonly string[];
  title: string;
  body: string;
  /** Replaces `body` when the step points at that target instead of the first. */
  bodyFor?: Partial<Record<string, string>>;
  side?: "top" | "right" | "bottom" | "left";
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "agent",
    targets: ["agent-panel", "agent-toggle"],
    title: "Beeblio AI",
    body: "Your research assistant. Ask it to find sources, analyse data, or draft and edit files. It works in this project's folder.",
    // With the panel closed the composer step is skipped, so its tips come here.
    bodyFor: {
      "agent-toggle": "Opens your research assistant. Ask it to find sources, analyse data, or draft and edit files. In its message box, type @ to attach a project file and / to run a skill.",
    },
    side: "left",
  },
  {
    id: "composer",
    targets: ["composer"],
    title: "Give it context",
    body: "Type @ to attach a project file and / to run a skill. The buttons under the box upload files, and in the desktop app take a screenshot.",
    side: "left",
  },
  {
    id: "literature",
    targets: ["rail-literature"],
    title: "Literature",
    body: "Search scholarly databases, collect papers, and keep your references and literature matrix in one place.",
    side: "right",
  },
  {
    id: "knowledge",
    targets: ["rail-knowledge"],
    title: "Knowledge",
    body: "Add documents the assistant should be able to search when it answers. Needs a Google AI key in Settings.",
    side: "right",
  },
  {
    id: "outputs",
    targets: ["rail-output"],
    title: "Your research, by kind",
    body: "Data, analyses, reports, and figures in this project, each kind in its own view.",
    side: "right",
  },
  {
    id: "files",
    targets: ["rail-files"],
    title: "File Manager",
    body: "Every file in the project folder. Open one to edit it here; changes are saved to the folder on your computer.",
    side: "right",
  },
  {
    id: "quick-open",
    targets: ["quick-open"],
    title: "Quick open",
    body: "Jump to any file, reference, or paper. Shortcut: ⌘P on a Mac, Ctrl+P on Windows.",
    side: "bottom",
  },
  {
    id: "review",
    targets: ["review"],
    title: "Document review",
    body: "Get focused feedback on the open document. Suggested changes are applied only when you accept them.",
    side: "bottom",
  },
  {
    id: "skills",
    targets: ["rail-skills"],
    title: "Agent Skills",
    body: "Write down procedures you repeat, such as a reporting style, and run them in any project with /skill.",
    side: "right",
  },
  {
    id: "shortcuts",
    targets: ["shortcuts"],
    title: "Shortcuts",
    body: "All keyboard shortcuts, in case you forget one.",
    side: "right",
  },
  {
    id: "account",
    targets: ["account"],
    title: "Settings and this tour",
    body: "Change models and API keys, check the tools the assistant uses, or take this tour again.",
    side: "right",
  },
];
