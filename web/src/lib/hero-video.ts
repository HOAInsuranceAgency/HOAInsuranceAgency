type DataConnection = EventTarget & { saveData?: boolean };

/** Poster-first enhancement: desktop motion begins only after initial input. */
export function initializeHeroVideo(hero: HTMLElement): () => void {
  const video = hero.querySelector<HTMLVideoElement>("[data-hero-video]");
  const toggle = hero.querySelector<HTMLButtonElement>("[data-hero-video-toggle]");
  if (!video || !toggle || !video.dataset.src) return () => {};

  const doc = hero.ownerDocument;
  const view = doc.defaultView;
  if (!view?.matchMedia) return () => {};

  const staticOnly = view.matchMedia(
    "(prefers-reduced-motion: reduce), (max-width: 768px)",
  );
  const connection = (view.navigator as Navigator & { connection?: DataConnection }).connection;
  let activated = false;
  let userPaused = false;
  let disposed = false;
  let generation = 0;

  const updateLabel = () => {
    toggle.textContent = activated && !userPaused && !video.paused
      ? "Pause background video"
      : "Play background video";
  };

  const pause = (release: boolean) => {
    generation += 1;
    video.pause();
    video.classList.remove("is-playing");
    if (release && video.hasAttribute("src")) {
      video.removeAttribute("src");
      video.load();
    }
    updateLabel();
  };

  const sync = async () => {
    const allowed = !staticOnly.matches && !connection?.saveData;
    toggle.hidden = !allowed;
    if (disposed || !allowed || doc.hidden || !activated || userPaused) {
      pause(!allowed || disposed);
      return;
    }
    if (!video.hasAttribute("src")) {
      video.src = video.dataset.src!;
      video.load();
    }
    video.muted = true;
    const attempt = ++generation;
    try {
      await video.play();
      if (attempt !== generation || disposed) return;
      video.classList.add("is-playing");
    } catch {
      // Browser playback policy or network failure leaves the poster usable.
      if (attempt !== generation || disposed) return;
      userPaused = true;
      video.classList.remove("is-playing");
    }
    updateLabel();
  };

  const removeInputListeners = () => {
    view.removeEventListener("pointerdown", onInitialInput);
    view.removeEventListener("keydown", onInitialInput);
  };
  const onInitialInput = (event: Event) => {
    if (event.target instanceof Node && toggle.contains(event.target)) return;
    activated = true;
    removeInputListeners();
    void sync();
  };
  const onToggle = () => {
    userPaused = activated ? !userPaused : false;
    activated = true;
    removeInputListeners();
    void sync();
  };
  const onChange = () => { void sync(); };

  // No source is assigned until input, so video bytes cannot delay initial LCP.
  view.addEventListener("pointerdown", onInitialInput, { passive: true });
  view.addEventListener("keydown", onInitialInput);
  toggle.addEventListener("click", onToggle);
  staticOnly.addEventListener("change", onChange);
  connection?.addEventListener("change", onChange);
  doc.addEventListener("visibilitychange", onChange);
  void sync();

  return () => {
    disposed = true;
    removeInputListeners();
    toggle.removeEventListener("click", onToggle);
    staticOnly.removeEventListener("change", onChange);
    connection?.removeEventListener("change", onChange);
    doc.removeEventListener("visibilitychange", onChange);
    pause(true);
  };
}
