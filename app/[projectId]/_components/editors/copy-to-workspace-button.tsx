"use client";

import { useState, useEffect } from "react";
import { Copy, FolderOpen, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listUserProjects } from "../../share-actions";
import { copyPublicFile } from "../../public-share-actions";
import { errorDetail } from "@/lib/error-detail";

const NEW_WORKSPACE_VALUE = "__new__";

function CopyButtonLabel() {
  return (
    <>
      <span className="sm:hidden">Copy</span>
      <span className="hidden sm:inline">Copy to Workspace</span>
    </>
  );
}

export function CopyToWorkspaceButton({ shareId }: { shareId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [projects, setProjects] = useState<{ slug: string; name: string }[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (isOpen) {
      listUserProjects().then(data => {
        setProjects(data);
        setSelectedSlug(data.length > 0 ? data[0].slug : NEW_WORKSPACE_VALUE);
        setProjectsLoaded(true);
      });
    }
  }, [isOpen]);

  const handleCreateProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name || isCreating) return;
    setIsCreating(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await response.json();
      if (!response.ok || !result.success || !result.slug) {
        throw new Error(result.error || "Failed to create project");
      }
      setProjects(previous => [{ slug: result.slug, name }, ...previous]);
      setSelectedSlug(result.slug);
    } catch (error) {
      toast.error(errorDetail(error, "Failed to create project"));
    } finally {
      setIsCreating(false);
    }
  };

  const handleConfirm = async () => {
    if (!selectedSlug) return;
    setIsLoading(true);
    try {
      const destPath = await copyPublicFile(shareId, selectedSlug);
      toast.success("File copied to your workspace!");
      router.push(`/${selectedSlug}?file=${encodeURIComponent(destPath)}`);
    } catch {
      toast.error("Failed to copy file");
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Copy />
          <CopyButtonLabel />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save Research Artifact</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {!projectsLoaded ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading Your Workspaces…
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Select a workspace to copy this file to.</p>
              <Select value={selectedSlug} onValueChange={setSelectedSlug}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a Workspace" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map(p => (
                    <SelectItem key={p.slug} value={p.slug}>
                      <FolderOpen className="size-4" />
                      {p.name}
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value={NEW_WORKSPACE_VALUE}>
                    <Plus className="size-4" />
                    Create New Workspace
                  </SelectItem>
                </SelectContent>
              </Select>
              {selectedSlug === NEW_WORKSPACE_VALUE ? (
                <form className="space-y-4" onSubmit={handleCreateProject}>
                  <Input
                    placeholder="Project Name"
                    value={newProjectName}
                    onChange={(event) => setNewProjectName(event.target.value)}
                    disabled={isCreating}
                    autoFocus
                  />
                  <Button type="submit" className="w-full" disabled={isCreating || !newProjectName.trim()}>
                    {isCreating && <Loader2 className="mr-2 size-4 animate-spin" />}
                    Create Workspace
                  </Button>
                </form>
              ) : (
                <Button className="w-full" onClick={handleConfirm} disabled={isLoading || !selectedSlug}>
                  {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Confirm Copy
                </Button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
