/**
 * Endless Gallery Configuration — Muck Memorial
 * 
 * Customized for displaying uploaded memorial photos.
 */

const GALLERY_CONFIG = {
  // Layout
  columns: 5,
  columnWidth: 280,
  gap: 18,
  responsive: {
    enabled: true,
    breakpoints: [
      { maxWidth: 640, columns: 1 },
      { maxWidth: 1024, columns: 3 },
      { maxWidth: 1440, columns: 4 },
      { maxWidth: 1920, columns: 5 },
      { maxWidth: Infinity, columns: 6 }
    ]
  },

  // Scrolling
  scrollSensitivity: 1.0,
  smoothScroll: true,
  friction: 0.95,
  minVelocity: 0.5,
  respectReducedMotion: true,

  // Loading & Performance
  preloadCount: 20,
  lazyLoadThreshold: 500,
  renderBuffer: 2000,
  maxVelocity: 4,
  tilesPerSegment: 8,

  // Media — paths are already absolute from the API
  mediaPath: '',
  useOptimizedImages: false,
  imageSizes: [280, 560, 840],

  // Video
  video: {
    autoplay: true,
    muted: true,
    loop: true,
    playInView: true,
    pauseOutOfView: true
  },

  // Accessibility
  keyboardNavigation: true,
  keyboardScrollSpeed: 100,
  debugMode: false
};
