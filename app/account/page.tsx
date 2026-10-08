import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Brand } from "@/app/_components/brand";
import { AiModelSettings } from "./settings";

export default function SettingsPage() {
  return <div className="min-h-screen bg-background">
    <header className="border-b"><div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-5"><Brand href="/workspace" /><Link href="/workspace" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="size-4" aria-hidden="true" />Back to Workspace</Link></div></header>
    <main className="mx-auto max-w-4xl px-5 py-10"><h1 className="text-3xl font-semibold">Settings</h1><p className="mt-2 text-sm text-muted-foreground">AI models for this local workspace</p><AiModelSettings /></main>
  </div>;
}
