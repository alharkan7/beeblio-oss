"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { ChevronLeft, ChevronRight, Maximize2, Presentation, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditorShell } from "./editor-shell";
import { EditorError, EditorLoading } from "./editor-states";
import { extensionOf, type WorkspaceEditorProps } from "./types";
import { errorDetail } from "@/lib/error-detail";

type SlideText = { text: string; x: number; y: number; width: number; height: number; fontSize: number };
type Slide = { title: string; elements: SlideText[] };

export function PresentationViewer({ file, sourceUrl }: WorkspaceEditorProps) {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(sourceUrl);
        if (!response.ok) throw new Error(`Unable to fetch presentation (${response.status})`);
        const zip = await JSZip.loadAsync(await response.arrayBuffer());
        const parsed = extensionOf(file.name) === "odp" ? await parseOdp(zip) : await parsePptx(zip);
        if (!cancelled) setSlides(parsed);
      } catch (cause) { if (!cancelled) setError(errorDetail(cause, "Unable to open presentation.")); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [file.name, sourceUrl]);

  const slide = slides[active];
  const matches = useMemo(() => slides.map((item, index) => ({ item, index })).filter(({ item }) => !query || item.elements.some((element) => element.text.toLowerCase().includes(query.toLowerCase()))), [query, slides]);
  return <EditorShell path={file.path} sourceUrl={sourceUrl} status={<span className="text-xs text-muted-foreground">Slide {slides.length ? active + 1 : 0} of {slides.length}</span>} actions={<Button size="sm" variant="ghost" onClick={() => void stageRef.current?.requestFullscreen()}><Maximize2 />Present</Button>}>
    {loading ? <EditorLoading /> : error ? <EditorError message={error} /> : !slide ? <EditorError message="The presentation contains no slides." /> : <div className="grid h-full min-h-0 grid-cols-[180px_minmax(0,1fr)]" onKeyDown={(event) => { if (event.key === "ArrowLeft") setActive((value) => Math.max(0, value - 1)); if (event.key === "ArrowRight") setActive((value) => Math.min(slides.length - 1, value + 1)); }} tabIndex={0}><aside className="flex min-h-0 flex-col border-r bg-muted/30"><div className="relative m-2"><Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search slides" className="h-7 pl-7 text-xs" /></div><div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{matches.map(({ item, index }) => <button key={index} className={`mb-2 block w-full rounded border p-1 text-left ${active === index ? "border-primary bg-accent" : "bg-card"}`} onClick={() => setActive(index)}><div className="aspect-video overflow-hidden bg-white p-2 text-[5px] text-neutral-900"><p className="line-clamp-5">{item.elements.map((element) => element.text).join(" ")}</p></div><span className="mt-1 block truncate px-1 text-[10px] text-muted-foreground">{index + 1} · {item.title}</span></button>)}</div></aside><div ref={stageRef} className="flex min-h-0 flex-col bg-neutral-200 p-5 dark:bg-neutral-900"><div className="relative mx-auto aspect-video w-full max-w-5xl overflow-hidden bg-white text-neutral-900 shadow-sm">{slide.elements.length ? slide.elements.map((element, index) => <div key={index} className="absolute overflow-hidden whitespace-pre-wrap" style={{ left: `${element.x * 100}%`, top: `${element.y * 100}%`, width: `${element.width * 100}%`, height: `${element.height * 100}%`, fontSize: `clamp(8px, ${element.fontSize / 9}vw, ${element.fontSize}px)` }}>{element.text}</div>) : <div className="flex h-full items-center justify-center"><Presentation className="size-10 text-neutral-300" /></div>}</div><div className="mt-3 flex items-center justify-center gap-2"><Button size="icon-sm" variant="outline" disabled={active === 0} onClick={() => setActive((value) => value - 1)}><ChevronLeft /></Button><span className="min-w-20 text-center text-xs text-muted-foreground">Slide {active + 1}</span><Button size="icon-sm" variant="outline" disabled={active === slides.length - 1} onClick={() => setActive((value) => value + 1)}><ChevronRight /></Button></div></div></div>}
  </EditorShell>;
}

async function parsePptx(zip: JSZip): Promise<Slide[]> {
  const files = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).toSorted((a, b) => slideNumber(a) - slideNumber(b));
  return Promise.all(files.map(async (name, index) => {
    const xml = await zip.file(name)!.async("text");
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const elements = Array.from(document.getElementsByTagName("p:sp")).map((shape) => {
      const text = Array.from(shape.getElementsByTagName("a:t")).map((node) => node.textContent ?? "").join(" ");
      const offset = shape.getElementsByTagName("a:off")[0];
      const extent = shape.getElementsByTagName("a:ext")[0];
      const sizeNode = shape.getElementsByTagName("a:defRPr")[0] || shape.getElementsByTagName("a:rPr")[0];
      return { text, x: Number(offset?.getAttribute("x") || 0) / 12_192_000, y: Number(offset?.getAttribute("y") || 0) / 6_858_000, width: Number(extent?.getAttribute("cx") || 6_000_000) / 12_192_000, height: Number(extent?.getAttribute("cy") || 1_000_000) / 6_858_000, fontSize: Number(sizeNode?.getAttribute("sz") || 1800) / 100 };
    }).filter((element) => element.text);
    return { title: elements[0]?.text || `Slide ${index + 1}`, elements };
  }));
}

async function parseOdp(zip: JSZip): Promise<Slide[]> {
  const xml = await zip.file("content.xml")?.async("text");
  if (!xml) throw new Error("The OpenDocument presentation content is missing.");
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(document.getElementsByTagName("*")).filter((node) => node.localName === "page").map((page, index) => {
    const text = Array.from(page.getElementsByTagName("*")).filter((node) => node.localName === "p" || node.localName === "h").map((node) => node.textContent ?? "").filter(Boolean);
    return { title: text[0] || `Slide ${index + 1}`, elements: text.map((value, item) => ({ text: value, x: 0.08, y: 0.1 + item * 0.1, width: 0.84, height: 0.09, fontSize: item === 0 ? 28 : 18 })) };
  });
}

function slideNumber(name: string) { return Number(name.match(/slide(\d+)\.xml/)?.[1] || 0); }
