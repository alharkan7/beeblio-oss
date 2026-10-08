import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { readWorkspaceFile } from "../workspace-files";
import { timedModelFetch } from "../lib/model-timeout";
import { getAiTaskConfig } from "../../lib/local-ai-settings";
import {
  resolveAuthenticatedWorkspace,
  toWorkspaceRelativePath,
} from "../workspace-paths";

const defaultMaxImageBytes = 20 * 1024 * 1024;

export default defineTool({
  description:
    "Semantically analyze a JPEG, PNG, WebP, or GIF with a vision model. Use native Pillow/file/Tesseract through bash first for metadata, resizing, rotation, deterministic preprocessing, or OCR; call this tool when understanding visible content requires model reasoning. It does not modify the file.",
  inputSchema: z
    .object({
      imagePath: z
        .string()
        .min(1)
        .describe(
          "Image path inside /workspace. Prefer an absolute path such as /workspace/field-photo.jpg.",
        ),
      prompt: z
        .string()
        .min(1)
        .max(10_000)
        .describe(
          "The specific question to answer about the image, such as describing visible evidence or extracting text.",
        ),
    })
    .strict(),
  outputSchema: z.object({
    imagePath: z.string(),
    mediaType: z.string(),
    analysis: z.string(),
  }),
  async execute({ imagePath, prompt }, ctx) {
    const auth = ctx.session.auth.current;
    const { identity } = resolveAuthenticatedWorkspace({
      principalId: auth?.principalId,
      projectSlug: auth?.attributes?.projectSlug,
      sessionId: ctx.session.id,
    });
    const workspacePath = toWorkspaceRelativePath(imagePath);
    const resolvedPath = `/workspace/${workspacePath}`;
    const { content: image } = await readWorkspaceFile(
      identity.userId,
      identity.projectSlug,
      workspacePath,
    );

    const maxImageBytes = readMaxImageBytes();
    if (image.byteLength === 0) {
      throw new Error(`Image file is empty: ${resolvedPath}`);
    }
    if (image.byteLength > maxImageBytes) {
      throw new Error(
        `Image exceeds the ${formatMiB(maxImageBytes)} MiB vision limit: ${resolvedPath}`,
      );
    }

    const mediaType = detectImageMediaType(image);
    if (mediaType === null) {
      throw new Error(
        "Unsupported or invalid image. analyze_image accepts JPEG, PNG, WebP, and GIF files.",
      );
    }

    const { modelId, apiKey } = await getAiTaskConfig("imageAnalysis");
    if (!modelId) {
      throw new Error(
        "Set OPENROUTER_VISION_MODEL_ID (or OPENROUTER_MODEL_ID) to a vision-capable model.",
      );
    }

    const openrouter = createOpenRouter({
      apiKey: apiKey || "missing-openrouter-key",
      fetch: timedModelFetch(),
    });
    const result = await generateText({
      model: openrouter(modelId),
      abortSignal: ctx.abortSignal,
      system:
        "You analyze research images. Answer the requested question using only visible evidence. Clearly distinguish direct observation from inference, preserve uncertainty, and never invent unreadable text or obscured details.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "file", data: image, mediaType },
          ],
        },
      ],
    });

    const analysis = result.text.trim();
    if (!analysis) {
      throw new Error("The vision model returned an empty analysis.");
    }

    return { imagePath: resolvedPath, mediaType, analysis };
  },
});

function readMaxImageBytes(): number {
  const configured = Number(process.env.VISION_MAX_IMAGE_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : defaultMaxImageBytes;
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

function detectImageMediaType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
