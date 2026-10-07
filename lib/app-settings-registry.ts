/**
 * Every setting the app reads, described once so the Settings dialog, the
 * server-side validation, and the setup check stay in step. Names match the
 * environment variables in .env.example, which still work as fallbacks in a
 * checkout. Kept free of Node.js imports so client components can use it.
 */

export type SettingKind = "secret" | "model" | "integer" | "email" | "url";

export type SettingGroup = "models" | "keys" | "google" | "contact" | "sharing";

export type SettingDefinition = {
  name: string;
  label: string;
  group: SettingGroup;
  kind: SettingKind;
  /** The agent cannot run a chat turn without it. */
  required?: boolean;
  help: string;
  placeholder?: string;
};

export const SETTING_GROUPS: ReadonlyArray<{ id: SettingGroup; label: string; description: string; optional?: boolean }> = [
  { id: "models", label: "Models", description: "OpenRouter models used by the agent and the writing tools." },
  { id: "keys", label: "API Keys", description: "Stored only on this computer. Only the last four characters are ever shown." },
  { id: "google", label: "Google AI", description: "Models for transcription and Knowledge search.", optional: true },
  { id: "contact", label: "Contact Email", description: "Sent to scholarly APIs, which give faster, more reliable access to identified clients.", optional: true },
  { id: "sharing", label: "Sharing", description: "For Office previews and public share links.", optional: true },
];

export const SETTINGS = [
  { name: "OPENROUTER_MODEL_ID", label: "Main model", group: "models", kind: "model", required: true, placeholder: "provider/model", help: "OpenRouter model ID for the research agent." },
  { name: "OPENROUTER_MODEL_CONTEXT_WINDOW_TOKENS", label: "Context window (tokens)", group: "models", kind: "integer", required: true, help: "Size of the main model's context window. Filled in from OpenRouter when you save a new main model." },
  { name: "OPENROUTER_MODEL_ID_LITE", label: "Lite model", group: "models", kind: "model", placeholder: "Uses the main model", help: "Titles, equations, and sentence suggestions." },
  { name: "OPENROUTER_MODEL_ID_REVIEW", label: "Review model", group: "models", kind: "model", placeholder: "Uses the main model", help: "Document review." },
  { name: "OPENROUTER_VISION_MODEL_ID", label: "Vision model", group: "models", kind: "model", placeholder: "Uses the main model", help: "Image analysis." },
  { name: "OPENROUTER_REQUEST_TIMEOUT_MS", label: "Request timeout (ms)", group: "models", kind: "integer", placeholder: "No limit", help: "Limits a single OpenRouter request." },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter", group: "keys", kind: "secret", required: true, placeholder: "sk-or-…", help: "Required for the agent and the AI writing tools. Checked with OpenRouter before it is saved." },
  { name: "GOOGLE_API_KEY", label: "Google Gemini", group: "keys", kind: "secret", help: "Transcription and Knowledge search." },
  { name: "BRAVE_SEARCH_API_KEY", label: "Brave Search", group: "keys", kind: "secret", help: "The agent's Brave web search tool." },
  { name: "MONID_API_KEY", label: "Monid", group: "keys", kind: "secret", help: "Monid-backed research tools." },
  { name: "OPENALEX_API_KEY", label: "OpenAlex", group: "keys", kind: "secret", help: "Literature search." },
  { name: "NCBI_API_KEY", label: "NCBI (PubMed)", group: "keys", kind: "secret", help: "PubMed literature search." },
  { name: "GOOGLE_TRANSCRIPTION_MODEL_ID", label: "Transcription model", group: "google", kind: "model", help: "Gemini model for transcribing audio and video." },
  { name: "GOOGLE_KNOWLEDGE_EMBEDDING_MODEL_ID", label: "Knowledge embedding model", group: "google", kind: "model", placeholder: "models/…", help: "Used when a Knowledge store is created; an existing store keeps its model." },
  { name: "GOOGLE_KNOWLEDGE_QUERY_MODEL_ID", label: "Knowledge query model", group: "google", kind: "model", help: "Gemini model with File Search support." },
  { name: "CROSSREF_MAILTO", label: "Crossref", group: "contact", kind: "email", placeholder: "you@example.org", help: "Crossref and PubMed metadata requests." },
  { name: "OPENALEX_EMAIL", label: "OpenAlex", group: "contact", kind: "email", placeholder: "you@example.org", help: "OpenAlex literature search." },
  { name: "PUBLIC_TUNNEL_ORIGIN", label: "Public tunnel origin", group: "sharing", kind: "url", placeholder: "https://…", help: "HTTPS address of a tunnel to this computer. Microsoft and other people cannot reach localhost." },
] as const satisfies readonly SettingDefinition[];

export type SettingName = (typeof SETTINGS)[number]["name"];

const BY_NAME = new Map<string, SettingDefinition>(SETTINGS.map((setting) => [setting.name, setting]));

export function settingDefinition(name: string): SettingDefinition | undefined {
  return BY_NAME.get(name);
}

export function isSettingName(name: string): name is SettingName {
  return BY_NAME.has(name);
}

/** Where a setting's current value comes from; "env" means .env.local or the process environment. */
export type SettingSource = "settings" | "env" | null;

/** What the browser may learn about a setting: plain values, but only the end of a secret. */
export type SettingStatus = { source: SettingSource; value?: string; last4?: string };

export type SettingsSnapshot = {
  settings: Record<SettingName, SettingStatus>;
  /** Labels of required settings that have no value from anywhere. */
  missingRequired: string[];
};
