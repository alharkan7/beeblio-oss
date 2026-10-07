"use client";

import { useEffect, useMemo, useState } from "react";
import { Focus, Loader2, Network, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildLiteratureMap,
  type LiteratureMapEdgeKind,
  type LiteratureMapSource,
} from "@/lib/literature-map";
import { enrichLiteratureMap } from "../../../literature-map-actions";
import { errorDetail } from "@/lib/error-detail";

const WIDTH = 1_200;
const HEIGHT = 760;
const COLORS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#059669", "#0891b2", "#4f46e5", "#65a30d"];
const EDGE_LABELS: Record<LiteratureMapEdgeKind, string> = {
  author: "Authors",
  keyword: "Keywords",
  similarity: "Similarity",
  venue: "Venues",
  citation: "Citations",
};

type PositionedNode = ReturnType<typeof buildLiteratureMap>["nodes"][number] & { x: number; y: number };

export function LiteratureMap({
  citations,
  projectId,
  filePath,
  onOpen,
  allowEnrichment = true,
  emptyTitle = "No references to map",
  emptyHint = "Add references or adjust the bibliography search.",
}: {
  citations: LiteratureMapSource[];
  projectId: string;
  filePath: string;
  onOpen: (citationId: string) => void;
  allowEnrichment?: boolean;
  /** Empty-state overrides so non-bibliography contexts (e.g. the matrix) read naturally. */
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const graph = useMemo(() => buildLiteratureMap(citations), [citations]);
  const positions = useMemo(() => positionNodes(graph.nodes), [graph.nodes]);
  const byId = useMemo(() => new Map(positions.map((node) => [node.id, node])), [positions]);
  const [zoom, setZoom] = useState(1);
  const [edgeKinds, setEdgeKinds] = useState<Set<LiteratureMapEdgeKind>>(() => new Set(Object.keys(EDGE_LABELS) as LiteratureMapEdgeKind[]));
  const [citationEdges, setCitationEdges] = useState<Array<{ source: string; target: string }>>([]);
  const [enriching, setEnriching] = useState(false);
  const [enrichment, setEnrichment] = useState<{ resolvedCount: number; eligibleCount: number; remainingCount: number; failedCount: number; error?: string }>();
  useEffect(() => { setCitationEdges([]); setEnrichment(undefined); }, [projectId, filePath]);
  const edges = useMemo(() => [
    ...graph.edges,
    ...citationEdges.map((edge) => ({ ...edge, kind: "citation" as const, weight: 1, reasons: ["Verified citation relationship (OpenAlex)"] })),
  ], [graph.edges, citationEdges]);
  const enrich = async () => {
    setEnriching(true);
    try {
      const result = await enrichLiteratureMap({ projectId, filePath });
      setCitationEdges(result.citationEdges);
      setEnrichment(result);
    } catch (error) {
      setEnrichment({ resolvedCount: 0, eligibleCount: 0, remainingCount: 0, failedCount: 0, error: errorDetail(error, "Citation enrichment failed.") });
    } finally { setEnriching(false); }
  };

  if (citations.length === 0) {
    return <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground"><Network className="size-8 opacity-50" /><p className="text-sm font-medium">{emptyTitle}</p><p className="max-w-sm text-xs">{emptyHint}</p></div>;
  }

  return <div className="flex h-full min-h-0 flex-col bg-muted/20">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-3 py-2">
      <div className="mr-auto">
        <p className="text-xs font-medium">Literature Map</p>
        <p className="text-[10px] text-muted-foreground">{citations.length} Papers · {graph.edges.length} Local Relationships{citationEdges.length ? ` · ${citationEdges.length} Citations` : ""}</p>
      </div>
      {allowEnrichment && filePath.toLowerCase().endsWith(".bib") ? <div className="flex items-center gap-1.5">
        {enrichment ? <span className={cn("max-w-52 truncate text-[10px]", enrichment.error ? "text-destructive" : "text-muted-foreground")} title={enrichment.error}>{enrichment.error || `${enrichment.resolvedCount}/${enrichment.eligibleCount} DOI Resolved${enrichment.remainingCount ? "" : ""}`}</span> : null}
        <Button size="xs" variant="outline" disabled={enriching} onClick={() => void enrich()}>{enriching ? <Loader2 className="animate-spin" /> : enrichment ? <RefreshCw /> : <Network />}{enriching ? "Finding…" : enrichment ? "Refresh Citations" : "Find Citations"}</Button>
      </div> : null}
      {(Object.keys(EDGE_LABELS) as LiteratureMapEdgeKind[]).map((kind) => <button
        key={kind}
        type="button"
        aria-pressed={edgeKinds.has(kind)}
        onClick={() => setEdgeKinds((current) => {
          const next = new Set(current);
          if (next.has(kind)) next.delete(kind); else next.add(kind);
          return next;
        })}
        className={cn("rounded-full border px-2 py-1 text-[10px] transition-colors", edgeKinds.has(kind) ? "border-primary/30 bg-primary/10 text-foreground" : "border-border text-muted-foreground opacity-60")}
      >{EDGE_LABELS[kind]}</button>)}
      <div className="flex items-center rounded-lg border bg-background">
        <Button size="icon-xs" variant="ghost" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.65, value - 0.15))}><ZoomOut /></Button>
        <span className="w-10 text-center text-[10px] tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <Button size="icon-xs" variant="ghost" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(2, value + 0.15))}><ZoomIn /></Button>
        <Button size="icon-xs" variant="ghost" aria-label="Reset zoom" onClick={() => setZoom(1)}><Focus /></Button>
      </div>
    </div>
    <div className="relative min-h-0 flex-1 overflow-auto">
      <svg
        role="img"
        aria-label={`Literature map of ${citations.length} references`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block min-h-full min-w-full"
        style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
      >
        <defs><pattern id="literature-map-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M 28 0 L 0 0 0 28" fill="none" stroke="currentColor" strokeOpacity="0.05" strokeWidth="1" /></pattern></defs>
        <rect width={WIDTH} height={HEIGHT} fill="url(#literature-map-grid)" className="text-foreground" />
        <g>
          {edges.filter((edge) => edgeKinds.has(edge.kind)).map((edge) => {
            const source = byId.get(edge.source); const target = byId.get(edge.target);
            if (!source || !target) return null;
            return <line key={`${edge.kind}:${edge.source}:${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="currentColor" className={edge.kind === "citation" ? "text-primary" : "text-muted-foreground"} strokeDasharray={edge.kind === "citation" ? "7 4" : undefined} strokeOpacity={0.25 + edge.weight * 0.45} strokeWidth={1 + edge.weight * 4}><title>{edge.reasons.join(" · ")}</title></line>;
          })}
        </g>
        <g>
          {positions.map((node) => {
            const radius = Math.min(18, 9 + Math.sqrt(Math.max(0, node.citationCount || 0)) * 0.35);
            return <g key={node.id} transform={`translate(${node.x} ${node.y})`} className="cursor-pointer outline-none" role="button" tabIndex={0}
              aria-label={`Open ${node.title || node.id}`}
              onClick={() => onOpen(node.id)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(node.id); } }}>
              <circle r={radius} fill={COLORS[node.cluster % COLORS.length]} stroke="white" strokeWidth="2" className="drop-shadow-sm" />
              <text y={radius + 15} textAnchor="middle" className="select-none fill-foreground text-[10px] font-medium">{nodeLabel(node)}</text>
              <title>{[node.title || node.id, node.authors, node.year, node.keywords].filter(Boolean).join("\n")}</title>
            </g>;
          })}
        </g>
      </svg>
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border bg-card/80 px-2 py-1 text-[9px] text-muted-foreground backdrop-blur">Click a paper to view its reference</div>
    </div>
  </div>;
}

function nodeLabel(node: PositionedNode) {
  const author = node.authorsList[0];
  const year = node.year?.match(/\d{4}/)?.[0];
  if (author || year) return [author || "Unknown", year].filter(Boolean).join(" · ").slice(0, 34);
  return (node.title || node.id).slice(0, 34);
}

function positionNodes(nodes: ReturnType<typeof buildLiteratureMap>["nodes"]): PositionedNode[] {
  const clusters = new Map<number, typeof nodes>();
  for (const node of nodes) clusters.set(node.cluster, [...(clusters.get(node.cluster) || []), node]);
  const groups = [...clusters.values()].sort((left, right) => right.length - left.length);
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
  const rows = Math.max(1, Math.ceil(groups.length / columns));
  const cellWidth = WIDTH / columns;
  const cellHeight = HEIGHT / rows;
  return groups.flatMap((group, groupIndex) => {
    const centerX = (groupIndex % columns + 0.5) * cellWidth;
    const centerY = (Math.floor(groupIndex / columns) + 0.5) * cellHeight;
    const ring = Math.min(cellWidth, cellHeight) * Math.min(0.37, 0.13 + group.length * 0.018);
    return [...group].sort((a, b) => a.id.localeCompare(b.id)).map((node, index) => {
      if (group.length === 1) return { ...node, x: centerX, y: centerY };
      const angle = -Math.PI / 2 + index * Math.PI * 2 / group.length;
      const stagger = 0.72 + (index % 3) * 0.14;
      return { ...node, x: centerX + Math.cos(angle) * ring * stagger, y: centerY + Math.sin(angle) * ring * stagger };
    });
  });
}
