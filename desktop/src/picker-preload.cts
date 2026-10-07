/// <reference lib="dom" />
// Runs in the picker window (a renderer), not in the main process.
import { ipcRenderer } from "electron";

/**
 * Renders the screen picker (static/screen-picker.html). The page itself runs
 * no script, so its content security policy can forbid scripts altogether;
 * this preload fills it in and reports the choice. Only sources the main
 * process offered can be chosen, and it checks the id again.
 */

type PickerSource = { id: string; name: string; kind: "screen" | "window"; thumbnail: string };

const choose = (id: string | null) => ipcRenderer.send("beeblio:screen-picker:choose", id);

function tile(source: PickerSource): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tile";
  button.addEventListener("click", () => choose(source.id));
  const image = document.createElement("img");
  image.src = source.thumbnail;
  image.alt = "";
  const label = document.createElement("span");
  // textContent, not innerHTML: window titles come from other apps.
  label.textContent = source.name || (source.kind === "screen" ? "Screen" : "Window");
  button.append(image, label);
  return button;
}

function section(title: string, sources: PickerSource[]): HTMLElement | undefined {
  if (!sources.length) return undefined;
  const wrapper = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = title;
  const grid = document.createElement("div");
  grid.className = "grid";
  grid.append(...sources.map(tile));
  wrapper.append(heading, grid);
  return wrapper;
}

window.addEventListener("DOMContentLoaded", async () => {
  const sources = (await ipcRenderer.invoke("beeblio:screen-picker:sources")) as PickerSource[];
  const list = document.getElementById("sources")!;
  const sections = [section("Screens", sources.filter((source) => source.kind === "screen")), section("Windows", sources.filter((source) => source.kind === "window"))];
  list.replaceChildren(...sections.filter((element): element is HTMLElement => element !== undefined));
  document.getElementById("cancel")!.addEventListener("click", () => choose(null));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") choose(null); });
  list.querySelector<HTMLButtonElement>(".tile")?.focus();
});
