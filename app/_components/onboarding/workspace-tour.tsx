"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ArrowLeft, ArrowRight, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { completeOnboarding, getOnboarding } from "@/app/onboarding-actions";
import { TOUR_STEPS, type TourStep } from "./tour-steps";

/** Dispatched by "Show tour" in the account menu and the desktop app's Help menu. */
export const START_TOUR_EVENT = "beeblio:start-tour";

/** Lets the workspace finish laying out (panels animate open) before measuring. */
const START_DELAY_MS = 700;
const SPOTLIGHT_PADDING = 6;
/** The card's width (w-80) plus its gap to the target; less room than this on a side means the card goes elsewhere. */
const CARD_SPACE = 320 + 24;

type Rect = { top: number; left: number; width: number; height: number };
type Side = NonNullable<TourStep["side"]>;

/**
 * Spotlight tour of a project's workspace. Starts by itself until the person
 * finishes or skips it once, and again on START_TOUR_EVENT. It only points:
 * it never opens panels or clicks for the person, so it cannot leave the
 * workspace in a state they did not choose.
 */
export function WorkspaceTour() {
  const [index, setIndex] = useState<number>();
  const [rect, setRect] = useState<Rect>();
  const direction = useRef<1 | -1>(1);

  const start = useCallback(() => {
    direction.current = 1;
    setIndex(firstVisible(0, 1));
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    void getOnboarding()
      .then((state) => {
        if (!cancelled && !state.tour) timer = setTimeout(start, START_DELAY_MS);
      })
      .catch(() => {
        // The tour is optional; without its state it simply does not start.
      });
    const replay = () => start();
    window.addEventListener(START_TOUR_EVENT, replay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(START_TOUR_EVENT, replay);
    };
  }, [start]);

  const step = index === undefined ? undefined : TOUR_STEPS[index];
  // Counted over the steps that can be shown now, so "3 of 9" matches what the person sees.
  const visibleSteps = useMemo(() => (step ? TOUR_STEPS.filter((candidate) => targetsOf(candidate).length) : []), [step]);
  const position = step ? visibleSteps.indexOf(step) : -1;

  const finish = useCallback((outcome: "done" | "skipped") => {
    setIndex(undefined);
    setRect(undefined);
    void completeOnboarding("tour", outcome).catch(() => {
      // Not recorded: the tour offers itself again next time, which is harmless.
    });
  }, []);

  const move = useCallback((by: 1 | -1) => {
    if (index === undefined) return;
    direction.current = by;
    const next = firstVisible(index + by, by);
    if (next === undefined) {
      if (by === 1) finish("done");
      return;
    }
    setIndex(next);
  }, [finish, index]);

  // Follows the target as the layout moves: window resizes, scrolling panels, and the target resizing.
  useLayoutEffect(() => {
    if (!step) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const elements = targetsOf(step);
        if (!elements.length) {
          // The target went away (a panel closed); continue in the direction the person was going.
          const next = index === undefined ? undefined : firstVisible(index + direction.current, direction.current);
          if (next === undefined) finish("done");
          else setIndex(next);
          return;
        }
        setRect(unionRect(elements));
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of targetsOf(step)) observer.observe(element);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [finish, index, step]);

  useEffect(() => {
    if (!step) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") move(1);
      else if (event.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, step]);

  const anchor = useMemo(() => ({ current: { getBoundingClientRect: () => toDomRect(rect) } }), [rect]);

  if (!step || !rect) return null;
  const target = resolveTarget(step)?.target;
  const body = (target && step.bodyFor?.[target]) || step.body;
  const isLast = position === visibleSteps.length - 1;
  const hole = { x: rect.left - SPOTLIGHT_PADDING, y: rect.top - SPOTLIGHT_PADDING, width: rect.width + SPOTLIGHT_PADDING * 2, height: rect.height + SPOTLIGHT_PADDING * 2 };

  return (
    <>
      {/* Dims everything but the target. It also takes the clicks, so the page cannot change under the tour. */}
      <svg className="pointer-events-auto fixed inset-0 z-[90] size-full" aria-hidden="true">
        <defs>
          <mask id="beeblio-tour-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect {...hole} rx="10" fill="black" className="motion-safe:transition-all motion-safe:duration-200" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgb(10 18 24 / 0.55)" mask="url(#beeblio-tour-mask)" />
        <rect {...hole} rx="10" fill="none" stroke="var(--primary)" strokeWidth="2" className="motion-safe:transition-all motion-safe:duration-200" />
      </svg>
      <Popover open modal>
        <PopoverPrimitive.Anchor virtualRef={anchor} />
        <PopoverContent
          key={step.id}
          side={chooseSide(rect, step.side ?? "bottom")}
          sideOffset={SPOTLIGHT_PADDING + 8}
          collisionPadding={12}
          className="z-[91] w-[min(20rem,calc(100vw-24px))] p-4"
          aria-labelledby="beeblio-tour-title"
          aria-describedby="beeblio-tour-body"
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={() => finish("skipped")}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11px] font-medium text-muted-foreground" aria-live="polite">{position + 1} of {visibleSteps.length}</p>
            <button type="button" onClick={() => finish("skipped")} className="-mt-1 -mr-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="End the tour">
              <X className="size-3.5" />
            </button>
          </div>
          <h2 id="beeblio-tour-title" className="mt-1 text-sm font-semibold tracking-[-0.01em]">{step.title}</h2>
          <p id="beeblio-tour-body" className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
          <div className="mt-4 flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" onClick={() => finish("skipped")}>
              Skip tour
            </Button>
            <div className="flex items-center gap-1.5">
              {position > 0 ? (
                <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => move(-1)}>
                  <ArrowLeft className="size-3.5" />Back
                </Button>
              ) : null}
              <Button type="button" size="sm" className="h-8 text-xs" onClick={() => (isLast ? finish("done") : move(1))} autoFocus>
                {isLast ? "Done" : <>Next<ArrowRight className="size-3.5" /></>}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** Elements of the step's first target that are on screen. */
function targetsOf(step: TourStep): HTMLElement[] {
  return resolveTarget(step)?.elements ?? [];
}

function resolveTarget(step: TourStep): { target: string; elements: HTMLElement[] } | undefined {
  for (const target of step.targets) {
    const elements = [...document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)].filter(isOnScreen);
    if (elements.length) return { target, elements };
  }
  return undefined;
}

function isOnScreen(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth;
}

/** The first step from `from` in `by`'s direction that has something on screen. */
function firstVisible(from: number, by: 1 | -1): number | undefined {
  for (let candidate = from; candidate >= 0 && candidate < TOUR_STEPS.length; candidate += by) {
    if (targetsOf(TOUR_STEPS[candidate]).length) return candidate;
  }
  return undefined;
}

function unionRect(elements: HTMLElement[]): Rect {
  const boxes = elements.map((element) => element.getBoundingClientRect());
  const top = Math.min(...boxes.map((box) => box.top));
  const left = Math.min(...boxes.map((box) => box.left));
  return { top, left, width: Math.max(...boxes.map((box) => box.right)) - left, height: Math.max(...boxes.map((box) => box.bottom)) - top };
}

/**
 * The step's preferred side if the card fits there, else the side with the
 * most room. Radix only slides a card along the target's edge, so a side
 * without room (a phone, or a target at the screen's edge) would push it off
 * screen.
 */
function chooseSide(rect: Rect, preferred: Side): Side {
  const room: Record<Side, number> = {
    left: rect.left,
    right: window.innerWidth - (rect.left + rect.width),
    top: rect.top,
    bottom: window.innerHeight - (rect.top + rect.height),
  };
  const needed = (side: Side) => (side === "left" || side === "right" ? CARD_SPACE : 220);
  if (room[preferred] >= needed(preferred)) return preferred;
  const fitting = (["bottom", "top", "right", "left"] as const).filter((side) => room[side] >= needed(side));
  return fitting[0] ?? (room.bottom >= room.top ? "bottom" : "top");
}

function toDomRect(rect: Rect | undefined): DOMRect {
  return rect ? new DOMRect(rect.left, rect.top, rect.width, rect.height) : new DOMRect();
}
