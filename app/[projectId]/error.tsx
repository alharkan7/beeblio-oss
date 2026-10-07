"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConversationFallback } from "./_components/conversation-fallback";

/**
 * A conversation that fails to render takes down only the AI panel; the
 * project layout around it, and any unsaved edits in the editor, survive.
 */
export default function ConversationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { projectId } = useParams<{ projectId: string }>();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ConversationFallback title="This conversation could not be shown" description="Try again, or start a new conversation.">
      <Button type="button" size="sm" onClick={reset}>
        <RotateCcw />Try again
      </Button>
      <Button size="sm" variant="outline" asChild>
        <Link href={`/${projectId}`}>New conversation</Link>
      </Button>
    </ConversationFallback>
  );
}
