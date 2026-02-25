/**
 * Endless Gallery - Core Engine
 *
 * A lightweight infinite scrolling gallery with lazy loading
 * and responsive layout support.
 */

class EndlessGallery {
  constructor(container, mediaItems, config = GALLERY_CONFIG) {
    this.container = container;
    this.mediaItems = mediaItems;
    this.config = config;

    // State
    this.scroll = { x: 0, y: 0 };
    this.velocity = { x: 0, y: 0 };
    this.viewport = { width: window.innerWidth, height: window.innerHeight };
    this.visibleTiles = new Map();
    this.loadedImages = new Set();
    this.observers = new Map();

    // Mouse/Touch state
    this.isDragging = false;
    this.lastMousePosition = { x: 0, y: 0 };
    this.lastMoveTime = 0;

    // Performance
    this.rafId = null;
    this.momentumRafId = null;
    this.lastFrameTime = 0;
    this.segmentCache = new Map();
    this.segmentHeightCache = new Map(); // Cache segment heights per column+segment
    this.columnSequenceCache = new Map(); // Cache shuffled sequences per column

    // Momentum constants
    this.friction = config.friction || 0.95;
    this.minVelocity = config.minVelocity || 0.5;

    // Debug
    this.debugMode = config.debugMode;

    this.init();
  }

  /**
   * Initialize the gallery
   */
  init() {
    this.setupContainer();
    this.setupEventListeners();
    this.setupIntersectionObserver();
    this.calculateLayout();
    this.render();

    console.log('✨ Endless Gallery initialized', {
      items: this.mediaItems.length,
      columns: this.getColumnCount(),
      viewport: this.viewport
    });
  }

  /**
   * Setup container element
   */
  setupContainer() {
    this.container.style.position = 'fixed';
    this.container.style.inset = '0';
    this.container.style.overflow = 'hidden';
    this.container.style.touchAction = 'none';
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', 'Infinite scroll gallery');
    this.container.setAttribute('tabindex', '0');
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Prevent context menu (right-click)
    this.container.addEventListener('contextmenu', (e) => e.preventDefault());

    // Prevent default drag behavior on images
    this.container.addEventListener('dragstart', (e) => e.preventDefault());

    // Mouse drag scrolling
    this.container.addEventListener('mousedown', this.handleMouseDown.bind(this));
    window.addEventListener('mousemove', this.handleMouseMove.bind(this));
    window.addEventListener('mouseup', this.handleMouseUp.bind(this));

    // Mouse wheel scrolling
    this.container.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });

    // Touch scrolling
    this.container.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: true });
    this.container.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
    this.container.addEventListener('touchend', this.handleTouchEnd.bind(this), { passive: true });

    // Keyboard navigation
    if (this.config.keyboardNavigation) {
      this.container.addEventListener('keydown', this.handleKeyboard.bind(this));
    }

    // Window resize
    window.addEventListener('resize', this.debounce(this.handleResize.bind(this), 250));

    // Debug mode toggle
    window.addEventListener('keydown', (e) => {
      if (e.key === 'd' || e.key === 'D') {
        this.debugMode = !this.debugMode;
        console.log('Debug mode:', this.debugMode ? 'ON' : 'OFF');

        // Recalculate layout to log fresh values
        this.calculateLayout();

        // Clear all tiles to force re-render with/without debug outlines
        this.visibleTiles.forEach((element) => {
          this.intersectionObserver.unobserve(element);
          element.remove();
        });
        this.visibleTiles.clear();

        this.render();
      }
    });
  }

  /**
   * Setup Intersection Observer for lazy loading
   */
  setupIntersectionObserver() {
    const options = {
      root: null,
      rootMargin: `${this.config.lazyLoadThreshold}px`,
      threshold: 0.01
    };

    this.intersectionObserver = new IntersectionObserver(
      this.handleIntersection.bind(this),
      options
    );
  }

  /**
   * Handle mouse down - start dragging
   */
  handleMouseDown(e) {
    e.preventDefault(); // Prevent default drag behavior

    // Cancel any ongoing momentum animation
    if (this.momentumRafId) {
      cancelAnimationFrame(this.momentumRafId);
      this.momentumRafId = null;
    }

    this.isDragging = true;
    this.lastMousePosition = { x: e.clientX, y: e.clientY };
    this.lastMoveTime = performance.now();
    this.velocity = { x: 0, y: 0 };

    this.container.style.cursor = 'grabbing';
  }

  /**
   * Handle mouse move - drag scrolling
   */
  handleMouseMove(e) {
    if (!this.isDragging) return;

    const now = performance.now();
    const timeDelta = now - this.lastMoveTime;
    this.lastMoveTime = now;

    const deltaX = e.clientX - this.lastMousePosition.x;
    const deltaY = e.clientY - this.lastMousePosition.y;
    this.lastMousePosition = { x: e.clientX, y: e.clientY };

    // Calculate velocity (normalized to ~60fps)
    const sensitivity = this.config.scrollSensitivity;
    if (timeDelta > 0 && timeDelta < 100) {
      const velocityScale = 16 / timeDelta;
      this.velocity = {
        x: deltaX * sensitivity * velocityScale,
        y: deltaY * sensitivity * velocityScale
      };
    }

    this.scroll.x += deltaX * sensitivity;
    this.scroll.y += deltaY * sensitivity;

    this.render();
  }

  /**
   * Handle mouse up - stop dragging and start momentum
   */
  handleMouseUp() {
    if (!this.isDragging) return;

    this.isDragging = false;
    this.container.style.cursor = 'grab';

    // Start momentum animation if there's velocity
    if (Math.abs(this.velocity.x) > this.minVelocity ||
      Math.abs(this.velocity.y) > this.minVelocity) {
      this.startMomentum();
    }
  }

  /**
   * Handle wheel scroll
   */
  handleWheel(e) {
    e.preventDefault();

    // Cancel any ongoing momentum animation
    if (this.momentumRafId) {
      cancelAnimationFrame(this.momentumRafId);
      this.momentumRafId = null;
    }

    const sensitivity = this.config.scrollSensitivity;
    const deltaX = e.deltaX * sensitivity;
    const deltaY = e.deltaY * sensitivity;

    this.scroll.x -= deltaX;
    this.scroll.y -= deltaY;

    // Set velocity for momentum
    this.velocity = {
      x: -deltaX * 0.3,
      y: -deltaY * 0.3
    };

    this.render();

    // Start momentum animation
    if (Math.abs(this.velocity.x) > this.minVelocity ||
      Math.abs(this.velocity.y) > this.minVelocity) {
      this.startMomentum();
    }
  }

  /**
   * Handle touch start
   */
  handleTouchStart(e) {
    // Cancel any ongoing momentum animation
    if (this.momentumRafId) {
      cancelAnimationFrame(this.momentumRafId);
      this.momentumRafId = null;
    }

    if (e.touches.length === 1) {
      this.isDragging = true;
      this.lastMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      this.touchStart = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        scrollX: this.scroll.x,
        scrollY: this.scroll.y
      };
      this.lastMoveTime = performance.now();
      this.velocity = { x: 0, y: 0 };
    }
  }

  /**
   * Handle touch move
   */
  handleTouchMove(e) {
    if (!this.touchStart || e.touches.length !== 1) return;
    e.preventDefault();

    const now = performance.now();
    const timeDelta = now - this.lastMoveTime;
    this.lastMoveTime = now;

    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;

    const deltaX = currentX - this.touchStart.x;
    const deltaY = currentY - this.touchStart.y;

    this.scroll.x = this.touchStart.scrollX + deltaX;
    this.scroll.y = this.touchStart.scrollY + deltaY;

    // Calculate velocity (normalized to ~60fps)
    if (timeDelta > 0 && timeDelta < 100) {
      const velocityScale = 16 / timeDelta;
      const currentDeltaX = currentX - this.lastMousePosition.x;
      const currentDeltaY = currentY - this.lastMousePosition.y;
      this.velocity = {
        x: currentDeltaX * velocityScale,
        y: currentDeltaY * velocityScale
      };
    }

    this.lastMousePosition = { x: currentX, y: currentY };
    this.render();
  }

  /**
   * Handle touch end
   */
  handleTouchEnd() {
    this.isDragging = false;
    this.touchStart = null;

    // Start momentum animation if there's velocity
    if (Math.abs(this.velocity.x) > this.minVelocity ||
      Math.abs(this.velocity.y) > this.minVelocity) {
      this.startMomentum();
    }
  }

  /**
   * Start momentum scrolling animation
   */
  startMomentum() {
    if (this.momentumRafId) {
      cancelAnimationFrame(this.momentumRafId);
    }
    this.animateMomentum();
  }

  /**
   * Animate momentum scrolling with friction
   */
  animateMomentum() {
    // Apply friction to velocity
    this.velocity.x *= this.friction;
    this.velocity.y *= this.friction;

    // Stop if velocity is negligible
    if (Math.abs(this.velocity.x) < this.minVelocity &&
      Math.abs(this.velocity.y) < this.minVelocity) {
      this.velocity = { x: 0, y: 0 };
      this.momentumRafId = null;
      return;
    }

    // Apply velocity to scroll position
    this.scroll.x += this.velocity.x;
    this.scroll.y += this.velocity.y;

    this.render();

    // Continue animation
    this.momentumRafId = requestAnimationFrame(() => this.animateMomentum());
  }

  /**
   * Handle keyboard navigation
   */
  handleKeyboard(e) {
    const speed = this.config.keyboardScrollSpeed;

    switch (e.key) {
      case 'ArrowLeft':
        this.scroll.x += speed;
        break;
      case 'ArrowRight':
        this.scroll.x -= speed;
        break;
      case 'ArrowUp':
        this.scroll.y += speed;
        break;
      case 'ArrowDown':
        this.scroll.y -= speed;
        break;
      default:
        return;
    }

    e.preventDefault();
    this.render();
  }

  /**
   * Handle window resize
   */
  handleResize() {
    this.viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };
    this.calculateLayout();
    this.render();
  }

  /**
   * Handle intersection observer callback
   */
  handleIntersection(entries) {
    entries.forEach(entry => {
      const tile = entry.target;
      const img = tile.querySelector('img, video');

      if (entry.isIntersecting && img && !img.dataset.loaded) {
        this.loadMedia(img);
      }
    });
  }

  /**
   * Calculate layout dimensions — single source of truth for all positioning.
   *
   * Key formula:
   *   colSpacing  = columnWidth + gap
   *   totalWidth  = columns * columnWidth + (columns - 1) * gap
   *   hOffset     = (viewportWidth - totalWidth) / 2
   *   tileX(col)  = col * colSpacing + scrollX + hOffset
   */
  calculateLayout() {
    const columns = this.getColumnCount();
    const { columnWidth, gap } = this.config;
    const colSpacing = columnWidth + gap;
    const totalWidth = columns * columnWidth + (columns - 1) * gap;
    const horizontalOffset = (this.viewport.width - totalWidth) / 2;

    this.layout = {
      columns,
      columnWidth,
      gap,
      colSpacing,          // single spacing constant used everywhere
      totalWidth,
      horizontalOffset
    };

    // Always log layout on calculation so we can diagnose issues
    console.log('📐 Layout calculated:', {
      viewportWidth: this.viewport.width,
      columns,
      columnWidth,
      gap,
      colSpacing,
      totalWidth,
      horizontalOffset,
      formula: `hOffset = (${this.viewport.width} - ${totalWidth}) / 2 = ${horizontalOffset}`
    });
  }

  /**
   * Get current column count based on viewport
   */
  getColumnCount() {
    if (!this.config.responsive.enabled) {
      return this.config.columns;
    }

    const breakpoint = this.config.responsive.breakpoints.find(
      bp => this.viewport.width <= bp.maxWidth
    );

    return breakpoint ? breakpoint.columns : this.config.columns;
  }

  /**
   * Seeded random for consistent layouts
   */
  seededRandom(seed) {
    const x = Math.sin(seed * 9999) * 10000;
    return x - Math.floor(x);
  }

  /**
   * Get aspect ratio for a tile
   */
  getAspectRatio(seed) {
    const rand = this.seededRandom(seed);
    // Range from 0.6 (wide) to 1.6 (tall)
    return 0.6 + rand * 1.0;
  }

  /**
   * Get shuffled sequence for a column (cached)
   */
  getColumnSequence(columnIndex) {
    if (this.columnSequenceCache.has(columnIndex)) {
      return this.columnSequenceCache.get(columnIndex);
    }

    // Create deterministic shuffle per column
    const columnSeed = columnIndex * 73856093;
    const shuffled = [...Array(this.mediaItems.length).keys()];

    // Fisher-Yates shuffle with seeded random
    for (let i = shuffled.length - 1; i > 0; i--) {
      const seed = columnSeed + i * 19349663;
      const j = Math.floor(this.seededRandom(seed) * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Cache the sequence
    this.columnSequenceCache.set(columnIndex, shuffled);
    return shuffled;
  }

  /**
   * Get media item for a specific column and tile index
   */
  getMediaForTile(columnIndex, tileIndex) {
    const sequence = this.getColumnSequence(columnIndex);

    // Offset by column to prevent horizontal adjacency
    const columnOffset = (columnIndex * 3) % this.mediaItems.length;
    const index = Math.abs((tileIndex + columnOffset) % sequence.length);

    return this.mediaItems[sequence[index]];
  }

  /**
   * Generate tiles for visible area
   */
  generateVisibleTiles() {
    const tiles = [];
    const { columnWidth, gap, colSpacing, horizontalOffset } = this.layout;
    const { tilesPerSegment } = this.config;

    // Calculate visible columns using the single-source colSpacing
    const scrolledX = -this.scroll.x;
    const startCol = Math.floor((scrolledX - horizontalOffset) / colSpacing) - 1;
    const endCol = Math.ceil((scrolledX - horizontalOffset + this.viewport.width) / colSpacing) + 1;

    // Calculate visible segments
    const scrolledY = -this.scroll.y;
    const avgTileHeight = columnWidth * 1.1;
    const avgSegmentHeight = avgTileHeight * tilesPerSegment;
    const startSeg = Math.floor(scrolledY / avgSegmentHeight) - 2;
    const endSeg = Math.ceil((scrolledY + this.viewport.height) / avgSegmentHeight) + 2;

    // ── Overlap assertions (run once per render when debug is on) ──
    if (this.debugMode && !this._overlapChecked) {
      this._overlapChecked = true;

      // Horizontal overlap check
      console.log('🔍 Horizontal column overlap check:');
      for (let c = startCol; c < endCol; c++) {
        const leftX = c * colSpacing + this.scroll.x + horizontalOffset;
        const rightX = leftX + columnWidth;
        const nextLeftX = (c + 1) * colSpacing + this.scroll.x + horizontalOffset;
        const gapActual = nextLeftX - rightX;
        const overlaps = gapActual < gap - 0.5;
        console.log(
          `  col ${c}: left=${leftX.toFixed(1)}, right=${rightX.toFixed(1)} | ` +
          `col ${c + 1}: left=${nextLeftX.toFixed(1)} | ` +
          `gap=${gapActual.toFixed(1)}px ${overlaps ? '❌ OVERLAP' : '✅ OK'}`
        );
        if (overlaps) {
          console.error(`❌ H-OVERLAP between col ${c} and col ${c + 1}!`);
        }
      }

      // Vertical overlap check — verify segment boundaries for col 0
      console.log('🔍 Vertical segment overlap check (col 0):');
      for (let seg = startSeg; seg < endSeg; seg++) {
        const segTiles = this.generateSegmentTiles(0, seg);
        const nextSegTiles = this.generateSegmentTiles(0, seg + 1);
        if (segTiles.length > 0 && nextSegTiles.length > 0) {
          const lastTile = segTiles[segTiles.length - 1];
          const lastBottom = lastTile.y + lastTile.height;
          const nextTop = nextSegTiles[0].y;
          const vGap = nextTop - lastBottom;
          const overlaps = vGap < gap - 0.5;
          console.log(
            `  seg ${seg} bottom=${lastBottom.toFixed(1)} | ` +
            `seg ${seg + 1} top=${nextTop.toFixed(1)} | ` +
            `gap=${vGap.toFixed(1)}px ${overlaps ? '❌ OVERLAP' : '✅ OK'}`
          );
          if (overlaps) {
            console.error(`❌ V-OVERLAP between seg ${seg} and seg ${seg + 1}! ` +
              `Expected gap ~${gap}px, got ${vGap.toFixed(1)}px`);
          }
        }
      }
    }

    // Generate tiles for each visible column and segment
    for (let col = startCol; col <= endCol; col++) {
      // Single formula: x = col * colSpacing + scrollX + horizontalOffset
      const colX = col * colSpacing + this.scroll.x + horizontalOffset;

      for (let seg = startSeg; seg <= endSeg; seg++) {
        const segmentTiles = this.generateSegmentTiles(col, seg);

        segmentTiles.forEach(tile => {
          const screenX = colX;
          const screenY = tile.y + this.scroll.y;

          if (this.isVisible(screenX, screenY, tile.width, tile.height)) {
            tiles.push({
              ...tile,
              key: `${col}-${seg}-${tile.key}`,
              x: screenX,
              y: screenY
            });
          }
        });
      }
    }

    return tiles;
  }

  /**
   * Generate tiles for a specific segment
   */
  generateSegmentTiles(columnIndex, segmentIndex) {
    const cacheKey = `${columnIndex}-${segmentIndex}`;
    if (this.segmentCache.has(cacheKey)) {
      return this.segmentCache.get(cacheKey);
    }

    const tiles = [];
    const { columnWidth, gap, tilesPerSegment } = this.config;
    const columnSeed = columnIndex * 73856093;

    let yOffset = this.getSegmentYOffset(columnIndex, segmentIndex);

    for (let i = 0; i < tilesPerSegment; i++) {
      const tileIndex = segmentIndex * tilesPerSegment + i;
      const tileSeed = columnSeed + tileIndex * 19349663;

      const media = this.getMediaForTile(columnIndex, tileIndex);
      const aspectRatio = this.getAspectRatio(tileSeed);
      const height = columnWidth * aspectRatio;

      tiles.push({
        key: `tile-${tileIndex}`,
        media,
        x: 0,
        y: yOffset,
        width: columnWidth,
        height
      });

      yOffset += height + gap;
    }

    this.segmentCache.set(cacheKey, tiles);
    return tiles;
  }

  /**
   * Get Y offset for a segment — matches React original exactly.
   *
   * For positive segments: sum heights of segments 0..(segmentIndex-1)
   * For negative segments: subtract heights of segments -1..segmentIndex (inclusive)
   */
  getSegmentYOffset(columnIndex, segmentIndex) {
    if (segmentIndex === 0) return 0;

    let offset = 0;
    if (segmentIndex > 0) {
      for (let seg = 0; seg < segmentIndex; seg++) {
        offset += this.getSegmentHeight(columnIndex, seg);
      }
    } else {
      // For negative segments, calculate backwards (inclusive of segmentIndex)
      for (let seg = -1; seg >= segmentIndex; seg--) {
        offset -= this.getSegmentHeight(columnIndex, seg);
      }
    }
    return offset;
  }

  /**
   * Get height of a segment (cached for performance).
   *
   * Height = sum of (tileHeight + gap) for each tile in the segment.
   * The trailing gap after the last tile acts as the gap between segments.
   */
  getSegmentHeight(columnIndex, segmentIndex) {
    const cacheKey = `${columnIndex}-${segmentIndex}`;
    if (this.segmentHeightCache.has(cacheKey)) {
      return this.segmentHeightCache.get(cacheKey);
    }

    const { columnWidth, gap, tilesPerSegment } = this.config;
    const columnSeed = columnIndex * 73856093;
    let height = 0;

    for (let i = 0; i < tilesPerSegment; i++) {
      const tileIndex = segmentIndex * tilesPerSegment + i;
      const tileSeed = columnSeed + tileIndex * 19349663;
      const aspectRatio = this.getAspectRatio(tileSeed);
      height += columnWidth * aspectRatio + gap;
    }

    this.segmentHeightCache.set(cacheKey, height);
    return height;
  }

  /**
   * Check if tile is visible in viewport
   */
  isVisible(x, y, w, h) {
    const buffer = this.config.renderBuffer;
    return (
      x > -w - buffer &&
      x < this.viewport.width + buffer &&
      y > -h - buffer &&
      y < this.viewport.height + buffer
    );
  }

  /**
   * Load media element
   */
  loadMedia(element) {
    if (element.dataset.loaded) return;

    const src = element.dataset.src;
    const srcset = element.dataset.srcset;

    if (element.tagName === 'IMG') {
      if (srcset) element.srcset = srcset;
      element.src = src;
    } else if (element.tagName === 'VIDEO') {
      element.src = src;
      if (this.config.video.autoplay) {
        element.play().catch(() => { });
      }
    }

    element.dataset.loaded = 'true';
    this.loadedImages.add(src);
  }

  /**
   * Create tile element
   */
  createTileElement(tile) {
    const div = document.createElement('div');
    div.className = 'gallery-tile';

    // Debug: outline instead of border so it doesn't affect box size
    const debugStyle = this.debugMode
      ? 'outline: 2px solid rgba(255,0,0,0.7); outline-offset: -2px;'
      : '';

    div.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: ${tile.width}px;
      height: ${tile.height}px;
      box-sizing: border-box;
      transform: translate3d(${tile.x}px, ${tile.y}px, 0);
      will-change: transform;
      contain: layout;
      content-visibility: auto;
      contain-intrinsic-size: ${tile.width}px ${tile.height}px;
      ${debugStyle}
    `;

    const media = tile.media;
    const isVideo = media.type === 'video' || media.src.match(/\.(mp4|webm|mov)$/i);

    if (isVideo) {
      const video = document.createElement('video');
      video.className = 'gallery-media';
      video.dataset.src = this.config.mediaPath + media.src;
      video.muted = this.config.video.muted;
      video.loop = this.config.video.loop;
      video.playsInline = true;
      video.draggable = false;
      video.setAttribute('draggable', 'false');

      if (media.poster) {
        video.poster = this.config.mediaPath + media.poster;
      }

      div.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.className = 'gallery-media';
      img.alt = media.alt || `Gallery image ${media.id}`;
      img.dataset.src = this.config.mediaPath + media.src;
      img.draggable = false;
      img.setAttribute('draggable', 'false');

      if (this.config.useOptimizedImages && media.srcset) {
        img.dataset.srcset = media.srcset.split(', ').map(s => {
          const [path, size] = s.trim().split(' ');
          return `${this.config.mediaPath}${path} ${size}`;
        }).join(', ');
      }

      // Show thumbnail immediately
      if (media.thumbnail) {
        img.src = media.thumbnail;
      }

      div.appendChild(img);
    }

    return div;
  }

  /**
   * Render the gallery
   */
  render() {
    // Reset overlap check flag so it runs once per debug toggle
    this._overlapChecked = false;

    const tiles = this.generateVisibleTiles();

    // Check for duplicate keys (debugging)
    if (this.debugMode) {
      const keys = new Set();
      const duplicates = [];
      tiles.forEach(tile => {
        if (keys.has(tile.key)) duplicates.push(tile.key);
        keys.add(tile.key);
      });
      if (duplicates.length > 0) {
        console.warn('⚠️ Duplicate tile keys detected:', duplicates);
      }
    }

    // Remove tiles that are no longer visible
    this.visibleTiles.forEach((element, key) => {
      if (!tiles.find(t => t.key === key)) {
        this.intersectionObserver.unobserve(element);
        element.remove();
        this.visibleTiles.delete(key);
      }
    });

    // Add or update visible tiles
    tiles.forEach(tile => {
      let element = this.visibleTiles.get(tile.key);

      if (!element) {
        element = this.createTileElement(tile);
        this.container.appendChild(element);
        this.intersectionObserver.observe(element); // Observe AFTER adding to DOM
        this.visibleTiles.set(tile.key, element);
      } else {
        // Update position
        element.style.transform = `translate3d(${tile.x}px, ${tile.y}px, 0)`;
      }
    });

    // Debug overlay
    if (this.debugMode) {
      this.renderDebugInfo(tiles);
    } else {
      // Remove debug overlay if it exists
      const debugEl = document.getElementById('gallery-debug');
      if (debugEl) {
        debugEl.remove();
      }
    }
  }

  /**
   * Render debug information
   */
  renderDebugInfo(tiles) {
    let debugEl = document.getElementById('gallery-debug');
    if (!debugEl) {
      debugEl = document.createElement('div');
      debugEl.id = 'gallery-debug';
      debugEl.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background: rgba(0,0,0,0.9);
        color: white;
        padding: 12px;
        font-family: monospace;
        font-size: 11px;
        z-index: 9999;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.2);
        max-width: 250px;
      `;
      document.body.appendChild(debugEl);
    }

    // Build column position summary for the centered columns (0..columns-1)
    const { colSpacing, columnWidth, horizontalOffset, columns } = this.layout;
    let colSummary = '';
    for (let c = 0; c < columns; c++) {
      const left = (c * colSpacing + this.scroll.x + horizontalOffset).toFixed(0);
      const right = (c * colSpacing + this.scroll.x + horizontalOffset + columnWidth).toFixed(0);
      colSummary += `<div style="color:#93c5fd;">  col${c}: ${left}–${right}px</div>`;
    }

    // Build segment Y summary for col 0 (segments around scroll position)
    const scrolledY = -this.scroll.y;
    const avgSegH = columnWidth * 1.1 * this.config.tilesPerSegment;
    const dbgStartSeg = Math.floor(scrolledY / avgSegH) - 1;
    const dbgEndSeg = dbgStartSeg + 4;
    let segSummary = '';
    for (let s = dbgStartSeg; s <= dbgEndSeg; s++) {
      const yOff = this.getSegmentYOffset(0, s);
      const h = this.getSegmentHeight(0, s);
      const top = (yOff + this.scroll.y).toFixed(0);
      const bot = (yOff + h + this.scroll.y).toFixed(0);
      segSummary += `<div style="color:#a5f3fc;">  seg${s}: ${top}–${bot}px</div>`;
    }

    debugEl.innerHTML = `
      <div style="margin-bottom: 8px; font-weight: bold; color: #4ade80;">Gallery Debug</div>
      <div>Visible Tiles: ${tiles.length}</div>
      <div>Loaded Images: ${this.loadedImages.size}</div>
      <div>Scroll: (${Math.round(this.scroll.x)}, ${Math.round(this.scroll.y)})</div>
      <div>Viewport: ${this.viewport.width}×${this.viewport.height}</div>
      <div>Columns: ${columns}</div>
      <div>Column Width: ${columnWidth}px</div>
      <div>Gap: ${this.config.gap}px</div>
      <div>Col Spacing: ${colSpacing}px</div>
      <div>Total Width: ${this.layout.totalWidth}px</div>
      <div>H-Offset: ${Math.round(horizontalOffset)}px</div>
      <div style="margin-top: 6px; font-weight: bold; color: #fbbf24;">Column X ranges:</div>
      ${colSummary}
      <div style="margin-top: 6px; font-weight: bold; color: #22d3ee;">Segment Y ranges (col 0):</div>
      ${segSummary}
      <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.2); font-size: 10px; color: rgba(255,255,255,0.6);">
        Press D to toggle | Red outlines show tile bounds
      </div>
    `;
  }

  /**
   * Utility: Debounce function
   */
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  /**
   * Destroy the gallery
   */
  destroy() {
    this.intersectionObserver.disconnect();
    this.visibleTiles.forEach(el => el.remove());
    this.visibleTiles.clear();
    this.container.innerHTML = '';
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EndlessGallery;
}

