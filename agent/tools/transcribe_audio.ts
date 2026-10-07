import { defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import path from "node:path";
import { z } from "zod";

import { runLocalSandboxCommand } from "../lib/local-sandbox-runner";
import { readWorkspaceFile, writeWorkspaceFile } from "../workspace-files";
import {
  resolveAuthenticatedWorkspace,
  toWorkspaceRelativePath,
} from "../workspace-paths";
import { appSetting } from "../../lib/app-settings";

const defaultMaxAudioBytes = 25 * 1024 * 1024;
const geminiApiBase = "https://generativelanguage.googleapis.com/v1beta";
// Base64 inflates bytes by 4/3 and the whole JSON request must stay under the
// API's 20 MB inline limit; larger audio goes through the Files API instead.
const inlineAudioLimitBytes = 14 * 1024 * 1024;

// MIME types from the Gemini transcription docs. Video containers and other
// formats are rejected upstream; extract_audio converts video to MP3 first.
const supportedAudioTypes: Record<string, string> = {
  mp3: "audio/mp3",
  mpeg: "audio/mpeg",
  m4a: "audio/m4a",
  wav: "audio/wav",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  opus: "audio/opus",
  webm: "audio/webm",
};

const supportedOutputExtensions = new Set(["txt", "md", "srt", "vtt"]);

const inputSchema = z
  .object({
    filePath: z
      .string()
      .min(1)
      .describe(
        "Path to the audio file inside /workspace. Prefer an absolute path such as /workspace/interview.mp3. Formats: MP3, WAV, M4A, AIFF, AAC, OGG, FLAC, Opus, WebM. For video files, extract the audio track to MP3 with extract_audio first.",
      ),
    outputPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional destination inside /workspace where the tool writes the transcript directly. The extension picks the format: .txt (timestamped speaker lines), .md (markdown with speaker turns), .srt or .vtt (subtitles with word-accurate timings). Example: /workspace/2-Data/interview.srt. When set, only a short preview is returned in chat; read the file for the full transcript.",
      ),
    language: z
      .string()
      .min(2)
      .max(35)
      .optional()
      .describe(
        "Optional BCP-47 code of the spoken language (e.g. 'id-ID', 'en-US') to improve recognition. Omit to auto-detect.",
      ),
    diarize: z
      .boolean()
      .default(true)
      .describe(
        "Label distinct speakers (default true). Speaker labels and word timestamps limit audio to about 30 minutes; set false for single-speaker audio up to 1 hour.",
      ),
  })
  .strict();

type Word = {
  text: string;
  speaker?: string;
  start: number;
  end: number;
};

type Turn = {
  speaker?: string;
  start: number;
  end: number;
  words: Word[];
};

type Cue = {
  speaker?: string;
  start: number;
  end: number;
  text: string;
};

/**
 * Transcription is priced per minute of audio, not per call
 * (docs/entitlements-plan.md §5): estimate -> pre-flight affordability ->
 * supplier call -> meter actual duration. The local sandbox image includes ffprobe,
 * so affordability uses the media container duration when available and only
 * falls back to a compressed-speech size heuristic for malformed containers.
 */
export default defineTool({
  description:
    "Transcribe an audio file in the project workspace with automatic language detection, speaker labels, and word-level timestamps. Optionally writes the transcript directly to a .txt, .md, .srt, or .vtt file in /workspace. Returns the transcript and the audio duration in seconds; it does not modify the audio file.",
  inputSchema,
  outputSchema: z.object({
    status: z.string(),
    transcript: z.string(),
    durationSeconds: z.number(),
    speakerCount: z.number().optional(),
    outputPath: z.string().optional(),
    outputFormat: z.string().optional(),
    transcriptTruncated: z.boolean().optional(),
  }),
  async execute({ filePath, outputPath, language, diarize }, ctx: ToolContext) {
    const auth = ctx.session.auth.current;
    const { identity } = resolveAuthenticatedWorkspace({
      principalId: auth?.principalId,
      projectSlug: auth?.attributes?.projectSlug,
      sessionId: ctx.session.id,
    });
    const workspacePath = toWorkspaceRelativePath(filePath);
    const resolvedPath = `/workspace/${workspacePath}`;

    const mediaType = audioMediaTypeFor(resolvedPath);
    if (!mediaType) {
      throw new Error(
        `Unsupported audio format "${path.extname(resolvedPath)}". transcribe_audio accepts MP3, WAV, M4A, AIFF, AAC, OGG, FLAC, Opus, and WebM files; convert other formats (including video) to MP3 first.`,
      );
    }

    const apiKey = appSetting("GOOGLE_API_KEY");
    if (!apiKey) {
      throw new Error(
        "Transcription needs a Google Gemini API key. Add one in Settings → API Keys.",
      );
    }
    const modelId = appSetting("GOOGLE_TRANSCRIPTION_MODEL_ID");
    if (!modelId) {
      throw new Error("Set the transcription model in Settings → Google AI.");
    }

    // Timestamps are needed for subtitle formats even without speaker labels;
    // diarization needs them to build speaker turns. Both features cap audio
    // at ~30 minutes, so plain single-speaker requests omit them (1 hour).
    const needsWordTimestamps = diarize || outputPathEndsWith(outputPath, [".srt", ".vtt"]);

    const outputWorkspacePath = outputPath
      ? resolveOutputPath(outputPath)
      : undefined;
    const resolvedOutputPath = outputWorkspacePath
      ? `/workspace/${outputWorkspacePath}`
      : undefined;

    const probedDurationSeconds = await probeAudioDuration(ctx, resolvedPath);
    const { content: audio } = await readWorkspaceFile(
      identity.userId,
      identity.projectSlug,
      workspacePath,
    );

    const maxAudioBytes = readMaxAudioBytes();
    if (audio.byteLength === 0) {
      throw new Error(`Audio file is empty: ${resolvedPath}`);
    }
    if (audio.byteLength > maxAudioBytes) {
      throw new Error(
        `Audio exceeds the ${formatMiB(maxAudioBytes)} MiB transcription limit: ${resolvedPath}`,
      );
    }

    const estimatedDurationSeconds =
      probedDurationSeconds ?? estimateDurationFromBytes(audio.byteLength);

    const transcriptionConfig: Record<string, unknown> = {};
    if (language) {
      transcriptionConfig.language_codes = [language];
    }
    if (diarize || needsWordTimestamps) {
      const mode: Record<string, unknown> = { type: "verbatim" };
      if (diarize) {
        mode.diarization_mode = "speaker";
      }
      if (needsWordTimestamps) {
        mode.timestamp_granularities = ["word"];
      }
      transcriptionConfig.mode = mode;
    }

    const fileName = resolvedPath.split("/").pop() ?? "audio";
    let uploadedFile: { name: string } | null = null;
    let audioInput: Record<string, unknown>;
    if (audio.byteLength <= inlineAudioLimitBytes) {
      audioInput = {
        type: "audio",
        data: Buffer.from(audio).toString("base64"),
        mime_type: mediaType,
      };
    } else {
      uploadedFile = await uploadAudioFile(
        apiKey,
        audio,
        mediaType,
        fileName,
        ctx.abortSignal,
      );
      audioInput = {
        type: "audio",
        uri: `${geminiApiBase}/${uploadedFile.name}`,
        mime_type: mediaType,
      };
    }

    let interaction: GeminiInteraction;
    try {
      const response = await fetch(`${geminiApiBase}/interactions`, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          input: [audioInput],
          generation_config: { transcription_config: transcriptionConfig },
        }),
        signal: ctx.abortSignal,
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          `Transcription request failed (${response.status}): ${summarizeApiError(responseText)}`,
        );
      }
      try {
        interaction = JSON.parse(responseText) as GeminiInteraction;
      } catch {
        throw new Error("Transcription endpoint returned a non-JSON response");
      }
    } finally {
      if (uploadedFile) {
        // Uploaded audio is single-use; clean it up so it never lingers.
        void deleteUploadedFile(apiKey, uploadedFile.name).catch(() => undefined);
      }
    }

    const { transcript, words } = extractTranscript(interaction);
    if (!transcript.trim()) {
      throw new Error("The transcription model returned an empty transcript.");
    }

    const durationSeconds = probedDurationSeconds ?? (words.length
      ? Math.max(...words.map((word) => word.end))
      : estimatedDurationSeconds);

    const speakerCount = countSpeakers(words);
    let resultTranscript = transcript.trim();

    if (resolvedOutputPath) {
      const format = resolvedOutputPath.split(".").pop() ?? "";
      const content = renderTranscript(format, {
        sourcePath: resolvedPath,
        transcript,
        words,
        durationSeconds,
      });
      await writeWorkspaceFile(
        identity.userId,
        identity.projectSlug,
        outputWorkspacePath!,
        new TextEncoder().encode(content),
        { contentType: transcriptContentType(format) },
      );
      resultTranscript = previewText(resultTranscript);
      return {
        status: "success",
        transcript: resultTranscript,
        durationSeconds,
        ...(speakerCount > 0 ? { speakerCount } : {}),
        outputPath: resolvedOutputPath,
        outputFormat: format,
      };
    }

    const transcriptTruncated = resultTranscript.length > 25_000;
    if (transcriptTruncated) resultTranscript = `${resultTranscript.slice(0, 25_000)}\n[transcript truncated; provide outputPath to save the full transcript]`;
    return {
      status: "success",
      transcript: resultTranscript,
      durationSeconds,
      ...(speakerCount > 0 ? { speakerCount } : {}),
      ...(transcriptTruncated ? { transcriptTruncated: true } : {}),
    };
  },
});

type GeminiInteraction = {
  error?: { message?: unknown };
  steps?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        text?: unknown;
        speaker?: unknown;
        start_offset?: unknown;
        end_offset?: unknown;
      }>;
    }>;
  }>;
};

function extractTranscript(interaction: GeminiInteraction): {
  transcript: string;
  words: Word[];
} {
  const texts: string[] = [];
  const words: Word[] = [];
  for (const step of interaction.steps ?? []) {
    for (const content of step.content ?? []) {
      if (typeof content.text === "string" && content.text) {
        texts.push(content.text);
      }
      for (const annotation of content.annotations ?? []) {
        if (annotation.type !== "word_info") continue;
        const text = typeof annotation.text === "string" ? annotation.text : null;
        const start = parseOffsetSeconds(annotation.start_offset);
        const end = parseOffsetSeconds(annotation.end_offset);
        if (text === null || start === null || end === null) continue;
        words.push({
          text,
          speaker:
            typeof annotation.speaker === "string" && annotation.speaker
              ? annotation.speaker
              : undefined,
          start,
          end,
        });
      }
    }
  }
  return { transcript: texts.join("\n").trim(), words };
}

// Offsets arrive as "7.200s"-style strings.
function parseOffsetSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function audioMediaTypeFor(resolvedPath: string): string | undefined {
  const extension = resolvedPath.split(".").pop()?.toLowerCase() ?? "";
  return supportedAudioTypes[extension];
}

function resolveOutputPath(outputPath: string): string {
  const resolved = toWorkspaceRelativePath(outputPath);
  const extension = resolved.split(".").pop()?.toLowerCase() ?? "";
  if (!supportedOutputExtensions.has(extension)) {
    throw new Error(
      `Unsupported transcript output format ".${extension}". Use .txt, .md, .srt, or .vtt.`,
    );
  }
  return resolved;
}

function transcriptContentType(format: string): string {
  if (format === "md") return "text/markdown; charset=utf-8";
  if (format === "vtt") return "text/vtt; charset=utf-8";
  if (format === "srt") return "application/x-subrip; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function outputPathEndsWith(
  outputPath: string | undefined,
  endings: string[],
): boolean {
  if (!outputPath) return false;
  const lower = outputPath.toLowerCase();
  return endings.some((ending) => lower.endsWith(ending));
}

function countSpeakers(words: Word[]): number {
  const speakers = new Set(
    words
      .map((word) => word.speaker)
      .filter((speaker): speaker is string => speaker !== undefined),
  );
  return speakers.size;
}

function speakerLabel(speaker: string | undefined): string | null {
  if (!speaker) return null;
  const match = /(\d+)/.exec(speaker);
  return match ? `Speaker ${Number(match[1]) + 1}` : speaker;
}

function buildTurns(words: Word[]): Turn[] {
  const turns: Turn[] = [];
  for (const word of words) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === word.speaker) {
      last.words.push(word);
      last.end = word.end;
    } else {
      turns.push({
        speaker: word.speaker,
        start: word.start,
        end: word.end,
        words: [word],
      });
    }
  }
  return turns;
}

function turnText(turn: Turn): string {
  return turn.words.map((word) => word.text).join(" ");
}

// The /workspace prefix is agent-facing plumbing; users see their project
// files as paths relative to it.
function displayPath(resolvedPath: string): string {
  return resolvedPath.replace(/^\/workspace\//, "");
}

// Cues split at sentence punctuation, or after 12 words so long turns stay
// readable as subtitles.
function buildCues(turns: Turn[]): Cue[] {
  const cues: Cue[] = [];
  for (const turn of turns) {
    let current: Word[] = [];
    const flush = () => {
      if (current.length === 0) return;
      cues.push({
        speaker: turn.speaker,
        start: current[0].start,
        end: current[current.length - 1].end,
        text: current.map((word) => word.text).join(" "),
      });
      current = [];
    };
    for (const word of turn.words) {
      current.push(word);
      if (/[.?!]["')\]]?$/.test(word.text) || current.length >= 12) {
        flush();
      }
    }
    flush();
  }
  return cues;
}

function renderTranscript(
  format: string,
  input: {
    sourcePath: string;
    transcript: string;
    words: Word[];
    durationSeconds: number;
  },
): string {
  const turns = buildTurns(input.words);
  // Speaker labels only carry information with two or more voices; a lone
  // "Speaker 1" prefix on every line is noise.
  const labelSpeakers = countSpeakers(input.words) > 1;

  if (format === "txt") {
    if (turns.length === 0) {
      return `${input.transcript}\n`;
    }
    const lines = turns.map((turn) => {
      const stamp = `[${formatClock(turn.start)}]`;
      const label = labelSpeakers ? speakerLabel(turn.speaker) : null;
      return label ? `${stamp} ${label}: ${turnText(turn)}` : `${stamp} ${turnText(turn)}`;
    });
    return `${lines.join("\n")}\n`;
  }

  if (format === "md") {
    const header = [
      `# Transcript — ${input.sourcePath.split("/").pop()}`,
      "",
      `- Source: ${displayPath(input.sourcePath)}`,
      `- Duration: ${input.durationSeconds.toFixed(1)} seconds`,
      ...(labelSpeakers ? [`- Speakers: ${countSpeakers(input.words)}`] : []),
      "",
    ].join("\n");
    if (turns.length === 0) {
      return `${header}\n${input.transcript}\n`;
    }
    const body = turns
      .map((turn) => {
        const prefix = labelSpeakers
          ? `**[${formatClock(turn.start)}] ${speakerLabel(turn.speaker) ?? "Speech"}:**`
          : `**[${formatClock(turn.start)}]:**`;
        return `${prefix} ${turnText(turn)}`;
      })
      .join("\n\n");
    return `${header}\n${body}\n`;
  }

  const cues = buildCues(turns);
  if (format === "srt") {
    requireCues(cues);
    return `${cues
      .map((cue, index) => {
        const label = labelSpeakers ? speakerLabel(cue.speaker) : null;
        const text = label ? `${label}: ${cue.text}` : cue.text;
        return `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${text}\n`;
      })
      .join("\n")}\n`;
  }

  if (format === "vtt") {
    requireCues(cues);
    const body = cues
      .map((cue) => {
        const label = labelSpeakers ? speakerLabel(cue.speaker) : null;
        const text = label ? `${label}: ${cue.text}` : cue.text;
        return `${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}\n${text}\n`;
      })
      .join("\n");
    return `WEBVTT\n\n${body}`;
  }

  throw new Error(`Unsupported transcript output format: ${format}`);
}

function requireCues(cues: Cue[]): void {
  if (cues.length === 0) {
    throw new Error(
      "Subtitle output requires word timestamps; the model returned none for this audio.",
    );
  }
}

function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatSrtTime(seconds: number): string {
  const millis = Math.round((seconds % 1) * 1000);
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function formatVttTime(seconds: number): string {
  return formatSrtTime(seconds).replace(",", ".");
}

function previewText(transcript: string): string {
  const collapsed = transcript.replace(/\s+/g, " ").trim();
  return collapsed.length <= 400
    ? collapsed
    : `${collapsed.slice(0, 400)}…`;
}

async function uploadAudioFile(
  apiKey: string,
  audio: Uint8Array,
  mediaType: string,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<{ name: string; uri: string; state?: string }> {
  const form = new FormData();
  form.set(
    "metadata",
    new Blob([JSON.stringify({ display_name: fileName })], {
      type: "application/json",
    }),
  );
  form.set(
    "file",
    // slice() re-bases Node's Buffer onto a plain ArrayBuffer-compatible view,
    // which the DOM BlobPart type requires.
    new Blob([audio.slice()], { type: mediaType }),
    fileName,
  );

  const response = await fetch(
    "https://generativelanguage.googleapis.com/upload/v1beta/files",
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey },
      body: form,
      signal,
    },
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Audio upload failed (${response.status}): ${summarizeApiError(responseText)}`,
    );
  }
  let file: { name: string; uri: string; state?: string };
  try {
    file = (JSON.parse(responseText) as { file: typeof file }).file;
  } catch {
    throw new Error("Audio upload returned a non-JSON response");
  }
  if (!file?.name) {
    throw new Error("Audio upload response missing file reference");
  }

  // Wait for server-side preprocessing before the audio can be transcribed.
  for (let attempt = 0; file.state === "PROCESSING" && attempt < 120; attempt++) {
    await sleep(1000, signal);
    const status = await fetch(`${geminiApiBase}/${file.name}`, {
      headers: { "x-goog-api-key": apiKey },
      signal,
    });
    const statusText = await status.text();
    if (!status.ok) {
      throw new Error(
        `Audio upload status check failed (${status.status}): ${summarizeApiError(statusText)}`,
      );
    }
    file = {
      ...file,
      ...(JSON.parse(statusText) as { file?: Partial<typeof file> }).file,
    } as typeof file;
  }
  if (file.state === "PROCESSING") {
    throw new Error("Uploaded audio was still processing after 2 minutes");
  }
  if (file.state && file.state !== "ACTIVE") {
    throw new Error(`Uploaded audio processing failed (${file.state})`);
  }
  return file;
}

async function deleteUploadedFile(
  apiKey: string,
  fileName: string,
): Promise<void> {
  const response = await fetch(`${geminiApiBase}/${fileName}`, {
    method: "DELETE",
    headers: { "x-goog-api-key": apiKey },
  });
  if (!response.ok) {
    console.error(`Cleaning up uploaded audio ${fileName} failed (${response.status})`);
  }
}

function sleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

async function probeAudioDuration(
  ctx: ToolContext,
  resolvedPath: string,
): Promise<number | null> {
  try {
    const result = await runLocalSandboxCommand({
      ctx,
      command: `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${shellQuote(resolvedPath.replace(/^\/workspace\//, ""))}`,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) return null;
    const duration = Number.parseFloat(result.stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

/**
 * Fallback duration estimate at ~64 kbps, typical of compressed speech
 * (MP3/Opus voice recordings). Uncompressed WAV is ~10x larger, so the
 * estimate runs low there. It is used only when ffprobe cannot read the media.
 */
function estimateDurationFromBytes(byteLength: number): number {
  return byteLength / (8 * 1024);
}

function readMaxAudioBytes(): number {
  const configured = Number(process.env.TRANSCRIPTION_MAX_AUDIO_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : defaultMaxAudioBytes;
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

function summarizeApiError(responseText: string): string {
  try {
    const parsed = JSON.parse(responseText) as {
      error?: { message?: unknown } | string;
    };
    const error = parsed.error;
    if (typeof error === "string") {
      const text = error.trim();
      if (text) return text.slice(0, 500);
    } else if (
      error &&
      typeof error.message === "string" &&
      error.message.trim()
    ) {
      return error.message.slice(0, 500);
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return responseText.slice(0, 500) || "no error details";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
