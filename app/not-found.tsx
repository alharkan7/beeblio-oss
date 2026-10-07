import Link from "next/link";

import { Button } from "@/components/ui/button";
import { RouteFallback } from "./_components/route-fallback";

export default function NotFound() {
  return (
    <RouteFallback title="Page not found" description="This link does not lead anywhere in Beeblio. It may be out of date.">
      <Button asChild>
        <Link href="/workspace">Back to projects</Link>
      </Button>
    </RouteFallback>
  );
}
