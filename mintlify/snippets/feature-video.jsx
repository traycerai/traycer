// A muted, looping feature clip that loads only its metadata up front and
// plays only while it is on screen, so a page with several clips does not
// download all of them on first paint. A clip the reader paused stays paused
// when it scrolls back into view.
export const FeatureVideo = ({ src, label }) => {
  const videoRef = React.useRef(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      return undefined;
    }
    let pausingOffScreen = false;
    let pausedByReader = false;
    const onPause = () => {
      if (pausingOffScreen) {
        pausingOffScreen = false;
        return;
      }
      pausedByReader = true;
    };
    const onPlay = () => {
      pausedByReader = false;
    };
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!pausedByReader) {
              video.play().catch(() => {
                // Autoplay can be refused; the controls still let the reader start it.
              });
            }
          } else if (!video.paused) {
            pausingOffScreen = true;
            video.pause();
          }
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(video);
    return () => {
      observer.disconnect();
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
    };
  }, []);

  return (
    <video
      ref={videoRef}
      className="w-full aspect-video rounded-xl"
      controls
      loop
      muted
      playsInline
      preload="metadata"
      aria-label={label}
    >
      <source src={src} type="video/mp4" />
      Unable to load video.
    </video>
  );
};
