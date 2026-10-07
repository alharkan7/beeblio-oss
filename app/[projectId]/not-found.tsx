"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { ConversationFallback } from "./_components/conversation-fallback";

/** A link to a deleted conversation lands here rather than on a full-page 404 that hides the project. */
export default function ConversationNotFound() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <ConversationFallback title="Conversation not found" description="It may have been deleted.">
      <Button size="sm" asChild>
        <Link href={`/${projectId}`}>New conversation</Link>
      </Button>
    </ConversationFallback>
  );
}
