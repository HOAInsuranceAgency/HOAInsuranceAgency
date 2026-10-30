type DataConnection = EventTarget & { saveData?: boolean };

/**
 * Decorative in-page videos that download only when they near the viewport.
 *
 * Markup carries `data-lazy-video` and `data-src` instead of `src`/`autoplay`,
 * so the file never competes with the page's first paint. Reduced-motion and
 * save-data visitors keep the poster, matching the hero video.
 */
export function initializeLazyVideos(root: ParentNode = document): void {
  const videos = Array.from(root.querySelectorAll<HTMLVideoElement>("video[data-lazy-video][data-src]"));
  const view = typeof window === "undefined" ? undefined : window;
  if (!videos.length || !view) return;

  const reduced = view.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const connection = (view.navigator as Navigator & { connection?: DataConnection }).connection;
  if (reduced || connection?.saveData || !("IntersectionObserver" in view)) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target as HTMLVideoElement;
      if (entry.isIntersecting) {
        if (!video.hasAttribute("src")) video.src = video.dataset.src!;
        video.muted = true;
        // A refused play leaves the poster showing, which is fine.
        void video.play().catch(() => {});
      } else if (video.hasAttribute("src")) {
        video.pause();
      }
    }
  }, { rootMargin: "200px 0px" });

  videos.forEach((video) => observer.observe(video));
}
