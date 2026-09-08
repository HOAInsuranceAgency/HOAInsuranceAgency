import { readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeHeroVideo } from "../../../web/src/lib/hero-video";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const bytes = (path: string) => statSync(new URL(path, import.meta.url)).size;

describe("hero media markup", () => {
  it("makes the existing poster immediately discoverable and keeps video source deferred", () => {
    const hero = read("../../../web/src/components/Hero.astro");
    expect(hero).toMatch(/<img[\s\S]*?src=\{backgroundImage\}/);
    expect(hero).toContain('loading="eager"');
    expect(hero).toContain('fetchpriority="high"');
    expect(hero).toContain('preload="none"');
    expect(hero).toContain("data-src={backgroundVideo}");
    expect(hero).not.toMatch(/(?:^|\s)autoplay(?:\s|>)/);
    expect(hero).not.toMatch(/<source|\s+src=\{backgroundVideo\}/);
    expect(hero).toContain('aria-hidden="true"');
  });

  it.each(["terms-of-service", "privacy-policy"])("does not render a video on %s", (page) => {
    const source = read(`../../../web/src/pages/${page}.astro`);
    expect(source).toContain('backgroundImage="/images/about-hero.jpg"');
    expect(source).not.toContain("backgroundVideo");
    expect(source).not.toContain("hero-video.mp4");
  });

  it("keeps the compressed shared video below a 3 MiB budget", () => {
    expect(bytes("../../../web/public/images/hero-video.mp4"))
      .toBeLessThan(3 * 1024 * 1024);
  });

  it("hides motion and its control at mobile widths and for reduced motion", () => {
    expect(read("../../../web/src/components/Hero.css"))
      .toMatch(/@media \(prefers-reduced-motion: reduce\), \(max-width: 768px\)/);
  });
});

describe("poster-first hero playback", () => {
  let media: EventTarget & { matches: boolean };
  let connection: EventTarget & { saveData: boolean };
  let video: HTMLVideoElement;
  let toggle: HTMLButtonElement;
  let hero: HTMLElement;
  let paused: boolean;
  let cleanup: (() => void) | undefined;
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

  beforeEach(() => {
    media = Object.assign(new EventTarget(), { matches: false });
    connection = Object.assign(new EventTarget(), { saveData: false });
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.body.innerHTML = `<section data-hero>
      <video data-hero-video data-src="/images/hero-video.mp4" preload="none"></video>
      <button data-hero-video-toggle hidden>Play background video</button>
    </section>`;
    hero = document.querySelector("section")!;
    video = document.querySelector("video")!;
    toggle = document.querySelector("button")!;
    paused = true;
    vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
    vi.spyOn(video, "load").mockImplementation(() => {});
    vi.spyOn(video, "pause").mockImplementation(() => { paused = true; });
    vi.spyOn(video, "play").mockImplementation(async () => { paused = false; });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
    Reflect.deleteProperty(navigator, "connection");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not load any video bytes before a desktop interaction", async () => {
    cleanup = initializeHeroVideo(hero);
    await settle();
    expect(video.hasAttribute("src")).toBe(false);
    expect(video.load).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    expect(toggle.hidden).toBe(false);
    expect(window.matchMedia).toHaveBeenCalledWith(
      "(prefers-reduced-motion: reduce), (max-width: 768px)",
    );
  });

  it.each(["pointerdown", "keydown"])("starts muted inline motion only after %s", async (event) => {
    cleanup = initializeHeroVideo(hero);
    window.dispatchEvent(new Event(event));
    await settle();
    expect(video.getAttribute("src")).toBe("/images/hero-video.mp4");
    expect(video.load).toHaveBeenCalledTimes(1);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(true);
    expect(video.classList.contains("is-playing")).toBe(true);
    expect(toggle.textContent).toBe("Pause background video");
  });

  it.each(["reduced motion / mobile", "data saver"])("keeps the poster static with %s", async (mode) => {
    if (mode === "data saver") connection.saveData = true;
    else media.matches = true;
    cleanup = initializeHeroVideo(hero);
    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    expect(video.hasAttribute("src")).toBe(false);
    expect(video.load).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    expect(toggle.hidden).toBe(true);
  });

  it("offers explicit play and pause without the first pointer event double-toggling", async () => {
    cleanup = initializeHeroVideo(hero);
    toggle.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(video.play).not.toHaveBeenCalled();
    toggle.click();
    await settle();
    expect(video.play).toHaveBeenCalledTimes(1);
    toggle.click();
    await settle();
    expect(video.paused).toBe(true);
    expect(video.classList.contains("is-playing")).toBe(false);
    expect(toggle.textContent).toBe("Play background video");
    toggle.click();
    await settle();
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it.each(["media", "connection"])("stops playback and releases its source when %s preferences change", async (kind) => {
    cleanup = initializeHeroVideo(hero);
    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    if (kind === "media") media.matches = true;
    else connection.saveData = true;
    (kind === "media" ? media : connection).dispatchEvent(new Event("change"));
    await settle();
    expect(video.paused).toBe(true);
    expect(video.hasAttribute("src")).toBe(false);
    expect(video.classList.contains("is-playing")).toBe(false);
    expect(toggle.hidden).toBe(true);
  });

  it("pauses in a hidden tab", async () => {
    cleanup = initializeHeroVideo(hero);
    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(video.paused).toBe(true);
    expect(video.classList.contains("is-playing")).toBe(false);
  });

  it("leaves the poster and a retry control when playback is rejected", async () => {
    vi.mocked(video.play).mockRejectedValueOnce(new Error("Playback unavailable"));
    cleanup = initializeHeroVideo(hero);
    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    expect(video.classList.contains("is-playing")).toBe(false);
    expect(toggle.textContent).toBe("Play background video");
    toggle.click();
    await settle();
    expect(video.classList.contains("is-playing")).toBe(true);
  });

  it("removes listeners and releases the source on cleanup", async () => {
    cleanup = initializeHeroVideo(hero);
    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    cleanup();
    cleanup = undefined;
    expect(video.hasAttribute("src")).toBe(false);
    window.dispatchEvent(new Event("keydown"));
    expect(video.play).toHaveBeenCalledTimes(1);
  });
});
