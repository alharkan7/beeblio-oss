"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { requireUser } from "@/lib/auth/session";
import {
  listKnowledge,
  processKnowledgeDocument,
  queueKnowledgeFile,
  removeKnowledgeDocument,
} from "@/lib/knowledge";

export async function listKnowledgeDocuments(projectId: string) {
  const user = await requireUser();
  return listKnowledge(user.id, projectId);
}

export async function addFileToKnowledge(projectId: string, filePath: string) {
  const user = await requireUser();
  let result: Awaited<ReturnType<typeof queueKnowledgeFile>>;
  try {
    result = await queueKnowledgeFile(user.id, projectId, filePath);
  } catch (error) {
    if (error instanceof Error && /API_KEY_INVALID|API key not valid/i.test(error.message)) {
      return {
        kind: "configuration_error" as const,
        error: "Google rejected the Gemini API key. Create one in Google AI Studio and save it in Settings → API Keys.",
      };
    }
    throw error;
  }
  if (result.kind === "queued") {
    after(() => processKnowledgeDocument(user.id, projectId, result.document.id).catch((error) => {
      console.error("[knowledge] background processing failed", error);
    }));
  }
  revalidatePath(`/${projectId}`);
  return result;
}

export async function removeFileFromKnowledge(projectId: string, documentId: string) {
  const user = await requireUser();
  await removeKnowledgeDocument(user.id, projectId, documentId);
  revalidatePath(`/${projectId}`);
}
