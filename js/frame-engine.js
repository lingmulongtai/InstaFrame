/**
 * frame-engine.js — Canvas-based EXIF frame generator
 */

const FrameEngine = (() => {

  const engineScriptUrl = document.currentScript?.src || document.baseURI;

  const MAX_CANVAS_DIMENSION = 16_384;
  const MAX_CANVAS_PIXELS = 64_000_000;
  const MAX_ESTIMATED_VIDEO_BYTES = 512 * 1024 * 1024;
  const MAX_PENDING_VIDEO_ENCODES = 4;
  const DEFAULT_VIDEO_CAPTURE_FPS = 30;
  const FONT_LOAD_GUARD_MS = 5_000;
  const IMAGE_LOAD_GUARD_MS = 15_000;
  const IMAGE_ENCODE_GUARD_MS = 60_000;
  const _canvasEncodeLocks = new WeakMap();
  const VIDEO_METADATA_GUARD_MS = 15_000;
  const VIDEO_PROGRESS_GUARD_MS = 60_000;
  const VIDEO_RECORDER_FLUSH_DELAY_MS = 120;
  let textBackgroundSampler = null;

  function resourceLimitError() {
    const error = new Error('Media exceeds safe in-browser resource limits');
    error.code = 'MEDIA_RESOURCE_LIMIT';
    return error;
  }

  function mediaTimeoutError(phase) {
    const error = new Error(`Video ${phase} timed out`);
    error.code = 'MEDIA_TIMEOUT';
    return error;
  }

  function resolveGuardTimeout(value, fallback) {
    if (value == null) return fallback;
    const requested = Number(value);
    return Number.isFinite(requested) && requested > 0
      ? Math.max(1, Math.floor(requested))
      : fallback;
  }

  function resolveVideoOutputLimit(maxOutputBytes) {
    if (maxOutputBytes == null) return MAX_ESTIMATED_VIDEO_BYTES;
    const requested = Number(maxOutputBytes);
    if (!Number.isFinite(requested) || requested <= 0) throw resourceLimitError();
    return Math.min(MAX_ESTIMATED_VIDEO_BYTES, Math.floor(requested));
  }

  function assertNotAborted(signal, message = 'Export cancelled') {
    if (signal?.aborted) throw new DOMException(message, 'AbortError');
  }

  function runBestEffortCleanup(action) {
    try { return action(); }
    catch (_) { return undefined; }
  }

  function releaseCanvasBackingStore(canvas) {
    if (!canvas) return;
    runBestEffortCleanup(() => { canvas.width = 0; });
    runBestEffortCleanup(() => { canvas.height = 0; });
  }

  function releaseMediaElementSource(media) {
    if (!media) return;
    runBestEffortCleanup(() => media.pause());
    runBestEffortCleanup(() => media.removeAttribute('src'));
    runBestEffortCleanup(() => media.load());
  }

  function revokeObjectUrl(url) {
    if (url) runBestEffortCleanup(() => URL.revokeObjectURL(url));
  }

  function assertSafeCanvasSize(width, height) {
    if (
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width < 1 || height < 1 ||
      width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION ||
      width * height > MAX_CANVAS_PIXELS
    ) throw resourceLimitError();
  }

  function resizeReusableCanvas(canvas, width, height) {
    if (canvas.width === width && canvas.height === height) return;
    if (canvas.width > 0 && canvas.height > 0) {
      canvas.width = 0;
      canvas.height = 0;
    }
    canvas.width = width;
    canvas.height = height;
  }

  const FONT_STACKS = {
    'Inter':              "'Inter', Arial, sans-serif",
    'Montserrat':         "'Montserrat', Arial, sans-serif",
    'DM Sans':            "'DM Sans', Arial, sans-serif",
    'Lato':               "'Lato', Arial, sans-serif",
    'Playfair Display':   "'Playfair Display', Georgia, serif",
    'Cormorant Garamond': "'Cormorant Garamond', Georgia, serif",
    'EB Garamond':        "'EB Garamond', Georgia, serif",
    'Poppins':            "'Poppins', Arial, sans-serif",
    'Raleway':            "'Raleway', Arial, sans-serif",
    'Nunito':             "'Nunito', Arial, sans-serif",
    'Josefin Sans':       "'Josefin Sans', Arial, sans-serif",
    'Oswald':             "'Oswald', Arial, sans-serif",
    'Work Sans':          "'Work Sans', Arial, sans-serif",
    'Libre Baskerville':  "'Libre Baskerville', Georgia, serif",
    'Cinzel':             "'Cinzel', Georgia, serif",
    'Source Serif 4':     "'Source Serif 4', Georgia, serif",
  };

  /**
   * Font shorthands for each caption part. Each part has its own bold and
   * italic switch; regular weights keep the light label and EXIF line.
   */
  function captionFonts(settings, cameraSize, exifSize, stack) {
    const font = (italic, bold, regularWeight, size) =>
      `${italic ? 'italic ' : ''}${bold ? 700 : regularWeight} ${size}px ${stack}`;
    return {
      label: font(settings.shotOnItalic, settings.shotOnBold, 300, cameraSize),
      model: font(settings.modelItalic, settings.modelBold, 500, cameraSize),
      maker: font(settings.makerItalic, settings.makerBold, 400, cameraSize),
      exif: font(settings.exifItalic, settings.exifBold, 300, exifSize),
    };
  }

  async function loadFrameFonts(settings, signal = null) {
    assertNotAborted(signal);
    if (!document.fonts) return;
    const family = settings.fontFamily || 'Inter';
    const fam = `'${family}'`;
    const fonts = captionFonts(settings, 16, 16, fam);
    const specs = new Set([fonts.label, fonts.model, fonts.maker, fonts.exif]);
    const loads = [...specs].map(spec => {
      try { return document.fonts.load(spec); }
      catch { return Promise.resolve(); }
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      const cleanup = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abort);
      };
      const finish = callback => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const abort = () => finish(() => reject(new DOMException('Export cancelled', 'AbortError')));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timeoutId = setTimeout(() => finish(resolve), FONT_LOAD_GUARD_MS);
      Promise.all(loads).then(() => finish(resolve), () => finish(resolve));
    });
    assertNotAborted(signal);
  }

  /**
   * Core synchronous renderer — works at whatever resolution img was loaded at.
   * Draws the final canvas in one pass: aspect-ratio and padding space is part
   * of the same surface, so a blur background is one continuous blur of the
   * source photo instead of a blur of the already framed (captioned) image.
   */
  /**
   * eyeShift (stereo eyes only): horizontal offset of the photo behind the
   * frame's window, as a fraction of the photo width. Opposite signs for the
   * two eyes place the frame in front of the picture.
   */
  function renderFrame(img, exif, settings, mapOverlayImg = null, {
    eyeShift = 0, sourceWidth = null, sourceHeight = null,
  } = {}) {
    const W = sourceWidth || img.naturalWidth || img.videoWidth || img.width;
    const H = sourceHeight || img.naturalHeight || img.videoHeight || img.height;
    const layout = computeFrameLayout(W, H, settings, exif);

    const canvas = document.createElement('canvas');
    canvas.width  = layout.canvasW;
    canvas.height = layout.canvasH;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas rendering is unavailable');
      drawFrameBackground(ctx, img, settings, layout);
      canvas.layoutIssues = drawFrameContent(ctx, img, exif, settings, layout, mapOverlayImg, eyeShift);
      canvas.photoPlacement = photoPlacement(layout, eyeShift);
      return canvas;
    } catch (error) {
      canvas.width = 0;
      canvas.height = 0;
      throw error;
    }
  }

  /** Fill the whole output surface, including ratio and padding space. */
  function drawFrameBackground(ctx, src, settings, layout) {
    if (settings.frameBackground === 'blur') {
      drawBlurBackground(ctx, src, layout.canvasW, layout.canvasH, settings);
    } else {
      ctx.fillStyle = layout.frameColor;
      ctx.fillRect(0, 0, layout.canvasW, layout.canvasH);
    }
  }

  /**
   * Draw the photo, its shadow, the map overlay and the caption at the frame's
   * position inside the output. Returns the caption's layout issues.
   */
  function drawFrameContent(ctx, src, exif, settings, layout, mapOverlayImg = null, eyeShift = 0) {
    const { W, H, sB, imageTop, imageBottom, bB, isPortrait, frameColor } = layout;
    const issues = [];
    ctx.save();
    try {
      ctx.translate(layout.frameX, layout.frameY);
      // Keep the caption inside the frame exactly as an unpadded export would.
      ctx.beginPath();
      ctx.rect(0, 0, layout.baseCanvasW, layout.baseCanvasH);
      ctx.clip();
      if (eyeShift) drawWindowedPhoto(ctx, src, sB, imageTop, W, H, eyeShift * W);
      else drawImageAtY(ctx, src, sB, imageTop, W, H);
      drawInnerShadow(ctx, sB, imageTop, W, H);
      if (mapOverlayImg && settings.showMapOverlay) {
        drawMapOverlay(ctx, mapOverlayImg, settings, { sB, tB: imageTop, W, H });
      }
      drawExifText(ctx, exif || {}, settings, {
        canvasW: layout.baseCanvasW,
        canvasH: layout.baseCanvasH,
        imageBottom,
        bottomAreaHeight: bB,
        isPortrait,
        frameColor,
        issues,
      });
    } finally {
      ctx.restore();
    }
    return issues;
  }

  /**
   * Scale a decoded image down to maxPx on the longest side.
   * Returns the original img unchanged if it's already small enough.
   * Keep the intermediate pixels lossless: a JPEG round-trip here visibly
   * softens texture and text when the live preview is enlarged.
   */
  async function scaleImage(img, maxPx, signal = null) {
    assertNotAborted(signal);
    const sourceW = img.naturalWidth || img.videoWidth || img.width;
    const sourceH = img.naturalHeight || img.videoHeight || img.height;
    const longest = Math.max(sourceW, sourceH);
    if (longest <= maxPx) return img;

    const scale = maxPx / longest;
    const w = Math.round(sourceW * scale);
    const h = Math.round(sourceH * scale);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    try {
      const ctx = tmp.getContext('2d');
      if (!ctx) throw new Error('Preview scaling failed');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      if (signal?.aborted) {
        tmp.width = 0;
        tmp.height = 0;
        assertNotAborted(signal);
      }
      return tmp;
    } catch (error) {
      tmp.width = 0;
      tmp.height = 0;
      throw error;
    }
  }

  /**
   * Load fonts needed for the current settings, then render.
   * Pass maxPreviewPx to scale the image down for fast live preview.
   * Pass mapOverlayImg (HTMLImageElement) to draw a Passage-style map overlay.
   */
  async function renderFrameWhenReady(img, exif, settings, {
    maxPreviewPx = null, mapOverlayImg = null, signal = null, eyeShift = 0,
    photoLimits = null,
  } = {}) {
    assertNotAborted(signal);
    await loadFrameFonts(settings, signal);
    assertNotAborted(signal);

    const renderImg = maxPreviewPx ? await scaleImage(img, maxPreviewPx, signal) : img;
    try {
      const fitted = photoLimits ? computePhotoOutputSize(
        renderImg.naturalWidth || renderImg.width,
        renderImg.naturalHeight || renderImg.height,
        settings, exif, photoLimits
      ) : null;
      const result = renderFrame(renderImg, exif, settings, mapOverlayImg, {
        eyeShift,
        sourceWidth: fitted?.sourceWidth,
        sourceHeight: fitted?.sourceHeight,
      });
      if (signal?.aborted) {
        result.width = 0;
        result.height = 0;
        assertNotAborted(signal);
      }
      return result;
    } finally {
      if (renderImg !== img && renderImg instanceof HTMLCanvasElement) {
        renderImg.width = 0;
        renderImg.height = 0;
      }
    }
  }

  // ─── Drawing helpers ──────────────────────────────────────────────────────

  function drawInnerShadow(ctx, x, y, w, h) {
    const grad = ctx.createLinearGradient(x, y + h - 6, x, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.05)');
    ctx.fillStyle = grad;
    // The gradient is transparent above the bottom edge. Keep a small
    // transparent margin for fractional coordinates and rasterization.
    ctx.fillRect(x, Math.max(y, y + h - 8), w, Math.min(h, 8));
  }

  function computeImageVerticalLayout(h, topBorder, bottomBorder, imageOffsetY = 0) {
    const raw = Number(imageOffsetY);
    const pct = Number.isFinite(raw) ? Math.max(-100, Math.min(100, raw)) : 0;
    const offsetPx = Math.round(h * (pct / 100));
    const imageTop = Math.max(0, topBorder + offsetPx);
    const imageBottom = imageTop + h;
    const baseCanvasH = Math.round(h + topBorder + bottomBorder);
    const canvasH = Math.max(baseCanvasH, Math.round(imageBottom + bottomBorder));
    return { imageTop, imageBottom, canvasH };
  }

  function drawImageAtY(ctx, src, x, y, w, h) {
    ctx.drawImage(src, x, y, w, h);
  }

  /** Where the photo lands for a given eye shift: scale and top-left offset. */
  function photoPlacement(layout, eyeShift = 0) {
    const shift = eyeShift * layout.W;
    const depth = Math.abs(shift);
    const scale = depth ? (layout.W + depth * 2) / layout.W : 1;
    const drawW = layout.W * scale;
    const drawH = layout.H * scale;
    return {
      scale,
      x: layout.frameX + layout.sB - depth + shift,
      y: layout.frameY + layout.imageTop + (layout.H - drawH) / 2,
      width: drawW,
      height: drawH,
    };
  }

  /**
   * Draw the photo as if seen through the frame's window: zoomed just enough
   * that shifting it sideways by `shift` pixels never uncovers the window.
   */
  function drawWindowedPhoto(ctx, src, x, y, w, h, shift) {
    const depth = Math.abs(shift);
    const scale = (w + depth * 2) / w;
    const drawW = w * scale;
    const drawH = h * scale;
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(src, x - depth + shift, y + (h - drawH) / 2, drawW, drawH);
    } finally {
      ctx.restore();
    }
  }

  /**
   * Estimate horizontal disparities of a stereo pair from downscaled greyscale
   * block matching. Positive values mean the left eye sees a point further
   * right (it appears in front of the screen). Returns fractions of the width.
   */
  function estimateStereoDisparity(left, right, { sampleWidth = 320 } = {}) {
    const sourceW = left.naturalWidth || left.width;
    const sourceH = left.naturalHeight || left.height;
    if (!(sourceW > 0 && sourceH > 0)) return null;
    const width = Math.min(sampleWidth, sourceW);
    const height = Math.max(8, Math.round(sourceH * (width / sourceW)));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      const grey = image => {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        const data = ctx.getImageData(0, 0, width, height).data;
        const out = new Float32Array(width * height);
        for (let index = 0; index < out.length; index += 1) {
          out[index] = data[index * 4] * 0.299 + data[index * 4 + 1] * 0.587 + data[index * 4 + 2] * 0.114;
        }
        return out;
      };
      const L = grey(left);
      const R = grey(right);
      const block = 12;
      const range = Math.round(width * 0.08);
      const found = [];
      for (let by = 0; by + block <= height; by += block) {
        for (let bx = range; bx + block + range <= width; bx += block) {
          let mean = 0;
          for (let y = 0; y < block; y += 1) {
            for (let x = 0; x < block; x += 1) mean += L[(by + y) * width + bx + x];
          }
          mean /= block * block;
          let variance = 0;
          for (let y = 0; y < block; y += 1) {
            for (let x = 0; x < block; x += 1) variance += (L[(by + y) * width + bx + x] - mean) ** 2;
          }
          if (variance / (block * block) < 40) continue; // flat block: no reliable match
          let best = Infinity;
          let bestShift = 0;
          let total = 0;
          for (let d = -range; d <= range; d += 1) {
            let sad = 0;
            for (let y = 0; y < block; y += 1) {
              const row = (by + y) * width;
              for (let x = 0; x < block; x += 1) sad += Math.abs(L[row + bx + x] - R[row + bx + x - d]);
            }
            total += sad;
            if (sad < best) { best = sad; bestShift = d; }
          }
          // Keep distinct minima only; repetitive texture matches everywhere.
          if (best < (total / (range * 2 + 1)) * 0.6) found.push(bestShift);
        }
      }
      if (found.length < 3) return { near: 0, far: 0, samples: found.length };
      found.sort((a, b) => a - b);
      const pick = q => found[Math.min(found.length - 1, Math.max(0, Math.round((found.length - 1) * q)))];
      return { near: pick(0.92) / width, far: pick(0.08) / width, samples: found.length };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /**
   * Draw the source image blurred and scaled to cover the canvas as a background.
   * Uses ctx.filter for blur, grayscale/sepia/saturation, and brightness.
   */
  function drawBlurBackground(ctx, src, canvasW, canvasH, settings) {
    const radius     = Math.max(0, Math.min(100, settings.blurRadius     ?? 20));
    const brightness = Math.max(10, Math.min(200, settings.blurBrightness ?? 80));
    const style      = settings.blurStyle || 'normal';

    const styleFilter =
      style === 'grayscale' ? 'grayscale(100%) '  :
      style === 'sepia'     ? 'sepia(100%) '       :
      style === 'saturate'  ? 'saturate(250%) '    : '';

    ctx.save();
    try {
      ctx.filter = `${styleFilter}blur(${radius}px) brightness(${brightness}%)`;

      // Cover the canvas (object-fit: cover) plus a bleed of a few blur radii.
      // Blurring samples beyond the drawn image as transparent, so without the
      // bleed the edges fade out and JPEG exports show a dark rim.
      const srcW = src.naturalWidth  || src.videoWidth  || src.displayWidth  || src.width  || canvasW;
      const srcH = src.naturalHeight || src.videoHeight || src.displayHeight || src.height || canvasH;
      const bleed = Math.ceil(radius * 3);
      const scale = Math.max((canvasW + bleed * 2) / srcW, (canvasH + bleed * 2) / srcH);
      const dw = Math.ceil(srcW * scale);
      const dh = Math.ceil(srcH * scale);
      const dx = Math.round((canvasW - dw) / 2);
      const dy = Math.round((canvasH - dh) / 2);

      ctx.drawImage(src, dx, dy, dw, dh);
    } finally {
      ctx.restore();
    }
  }

  /**
   * Draw a Passage-style minimal map overlay in the bottom-right corner of the photo area.
   */
  function drawMapOverlay(ctx, mapImg, settings, { sB, tB, W, H }) {
    const opacity = (typeof settings.mapOverlayOpacity === 'number')
      ? Math.min(1, Math.max(0, settings.mapOverlayOpacity)) : 0.7;
    const posRaw = settings.mapOverlayPosition || 'bottom-right';
    const pos = ['bottom-right', 'top-right', 'top-left', 'bottom-left'].includes(posRaw)
      ? posRaw : 'bottom-right';

    // Target size: about a quarter of the photo's shorter side
    const shortSide = Math.min(W, H);
    const mapW = mapImg.naturalWidth || mapImg.width;
    const mapH = mapImg.naturalHeight || mapImg.height;
    if (!(mapW > 0 && mapH > 0)) return;
    const ovW = Math.round(shortSide * 0.26);
    const ovH = Math.round(ovW * (mapH / mapW));

    // Position: corner with a small inset
    const inset = Math.round(shortSide * 0.025);
    const isRight = pos === 'bottom-right' || pos === 'top-right';
    const isBottom = pos === 'bottom-right' || pos === 'bottom-left';
    const ox = isRight ? (sB + W - ovW - inset) : (sB + inset);
    const oy = isBottom ? (tB + H - ovH - inset) : (tB + inset);

    ctx.save();
    // Clip to rounded rect
    const r = Math.round(ovW * 0.08);
    ctx.beginPath();
    ctx.moveTo(ox + r, oy);
    ctx.lineTo(ox + ovW - r, oy);
    ctx.quadraticCurveTo(ox + ovW, oy, ox + ovW, oy + r);
    ctx.lineTo(ox + ovW, oy + ovH - r);
    ctx.quadraticCurveTo(ox + ovW, oy + ovH, ox + ovW - r, oy + ovH);
    ctx.lineTo(ox + r, oy + ovH);
    ctx.quadraticCurveTo(ox, oy + ovH, ox, oy + ovH - r);
    ctx.lineTo(ox, oy + r);
    ctx.quadraticCurveTo(ox, oy, ox + r, oy);
    ctx.closePath();
    ctx.clip();

    ctx.globalAlpha = opacity;
    ctx.drawImage(mapImg, ox, oy, ovW, ovH);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawExifText(ctx, exif, settings, layout) {
    const { canvasW, imageBottom, bottomAreaHeight, isPortrait, frameColor } = layout;
    const {
      fontFamily       = 'Inter',
      shotOnFontScale  = 1.0,
      exifFontScale    = 1.0,
      textOffsetY      = 0,
      lineGapScale     = 1.0,
      showShotOn       = true,
      showExifInfo     = true,
      showLocation     = false,
      locationPosition = 'below-exif',
      textColorMode    = 'auto',
      textColor        = '#FFFFFF',
    } = settings;

    const showShotOnLabel = !!showShotOn;
    const effectiveShowExifInfo = !!showExifInfo;
    const effectiveShowLocation = showLocation && !!(exif.location);

    const backgroundIsDark = detectTextBackgroundDark(ctx, layout, settings);
    let primary;
    if (textColorMode === 'light') primary = '#F7F7F7';
    else if (textColorMode === 'dark') primary = '#111111';
    else if (textColorMode === 'custom') {
      primary = typeof InstaFrameCore !== 'undefined'
        ? InstaFrameCore.normalizeHexColor(textColor, '#FFFFFF')
        : textColor;
    } else {
      primary = backgroundIsDark ? '#F7F7F7' : '#111111';
    }
    const muted = mixHexColor(primary, backgroundIsDark ? '#FFFFFF' : '#000000', 0.38);

    const stack  = FONT_STACKS[fontFamily] || `'${fontFamily}', Arial, sans-serif`;
    const baseFs = canvasW * 0.022;
    const soSize = Math.round(baseFs * 1.15 * shotOnFontScale);
    const exSize = Math.round(baseFs * 0.92 * exifFontScale);
    const gap    = soSize * (isPortrait ? 1.4 : 1.7) * lineGapScale;

    const centerY = imageBottom + bottomAreaHeight * 0.50 + textOffsetY * soSize;
    const centerX = canvasW / 2;

    // Build font strings — CSS shorthand: [style] [weight] [size] [family]
    const {
      label: labelFont,
      model: camFont,
      maker: makerFont,
      exif: exifFont,
    } = captionFonts(settings, soSize, exSize, stack);
    const makerColor  = mixHexColor(primary, muted, 0.5);

    // Determine if location goes below (needs 3-line layout)
    const hasLocationBelow = effectiveShowLocation && locationPosition === 'below-exif';
    // Y positions — when 3 lines, shift lines 1 & 2 up slightly to center the group
    const line1Y = hasLocationBelow ? centerY - gap * 0.85 : centerY - gap / 2;
    const line2Y = hasLocationBelow ? centerY              : centerY + gap / 2;
    const line3Y = centerY + gap * 0.85;

    // Layout checks: callers pass layout.issues to learn when the caption is
    // clipped by the frame edges, runs into the photo, or overlaps itself.
    const issues = Array.isArray(layout.issues) ? layout.issues : null;
    const report = code => { if (issues && !issues.includes(code)) issues.push(code); };
    const edgeMargin = Math.max(2, canvasW * 0.012);
    const checkSpan = (left, right) => {
      if (left < edgeMargin || right > canvasW - edgeMargin) report('text-overflow');
    };
    const drawnLines = [];

    ctx.save();
    ctx.textBaseline = 'middle';

    // Line 1: Camera (with optional "Shot on" label only)
    const camModel = String(exif.model || '').trim();
    const camMake  = String(exif.make || '').trim();
    if (camModel || camMake) {
      const label = 'Shot on';
      const labelText = showShotOnLabel ? (label + '  ') : '';
      const makerGap = (camModel && camMake) ? ' ' : '';
      ctx.font = labelFont;
      const lw = showShotOnLabel ? ctx.measureText(labelText).width : 0;
      ctx.font = camFont;
      const modelW = camModel ? ctx.measureText(camModel).width : 0;
      const gapW = makerGap ? ctx.measureText(makerGap).width : 0;
      ctx.font = makerFont;
      const makeW = camMake ? ctx.measureText(camMake).width : 0;
      const cameraW = lw + modelW + gapW + makeW;
      const x0 = centerX - cameraW / 2;
      checkSpan(x0, x0 + cameraW);
      drawnLines.push({ y: line1Y, half: soSize * 0.6 });

      if (showShotOnLabel) {
        ctx.textAlign = 'left';
        ctx.font      = labelFont;
        ctx.fillStyle = muted;
        ctx.fillText(labelText, x0, line1Y);
      }

      ctx.textAlign = 'left';
      ctx.font      = camFont;
      ctx.fillStyle = primary;
      if (camModel) ctx.fillText(camModel, x0 + lw, line1Y);
      if (camMake) {
        ctx.font = makerFont;
        ctx.fillStyle = makerColor;
        ctx.fillText(camMake, x0 + lw + modelW + gapW, line1Y);
      }

      // Location beside camera name (cam-right / cam-left)
      if (effectiveShowLocation && (locationPosition === 'cam-right' || locationPosition === 'cam-left')) {
        const locFont = `300 ${Math.round(soSize * 0.82)}px ${stack}`;
        ctx.font      = locFont;
        ctx.fillStyle = muted;
        const pinSize = soSize * 0.52;
        const sidePad = canvasW * 0.04;

        const locationGap = soSize * 0.6;
        if (locationPosition === 'cam-right') {
          ctx.textAlign = 'right';
          ctx.fillText(exif.location, canvasW - sidePad, line1Y);
          const tw = ctx.measureText(exif.location).width;
          drawLocationPin(ctx, canvasW - sidePad - tw - pinSize * 1.1, line1Y, pinSize, muted, settings.locationIconStyle);
          const locationLeft = canvasW - sidePad - tw - pinSize * 1.6;
          if (locationLeft < x0 + cameraW + locationGap) report('location-overlaps-camera');
          checkSpan(locationLeft, canvasW - sidePad);
        } else {
          const pinCx = sidePad + pinSize * 0.6;
          drawLocationPin(ctx, pinCx, line1Y, pinSize, muted, settings.locationIconStyle);
          ctx.textAlign = 'left';
          ctx.fillText(exif.location, sidePad + pinSize * 1.5, line1Y);
          const locationRight = sidePad + pinSize * 1.5 + ctx.measureText(exif.location).width;
          if (locationRight + locationGap > x0) report('location-overlaps-camera');
          checkSpan(sidePad, locationRight);
        }
      }
    }

    // Line 2: EXIF data
    if (effectiveShowExifInfo) {
      const parts = [];
      if (exif.lensModel)    parts.push(exif.lensModel);
      if (exif.focalLength)  parts.push(`${exif.focalLength}mm`);
      if (exif.fNumber)      parts.push(`f/${exif.fNumber}`);
      if (exif.exposureTime) parts.push(formatShutter(exif.exposureTime));
      if (exif.iso)          parts.push(`ISO\u2009${exif.iso}`);
      const line = parts.join('  \u2003  ');
      if (line) {
        ctx.font      = exifFont;
        ctx.fillStyle = muted;
        ctx.textAlign = 'center';
        ctx.fillText(line, centerX, line2Y);
        const lineW = ctx.measureText(line).width;
        checkSpan(centerX - lineW / 2, centerX + lineW / 2);
        drawnLines.push({ y: line2Y, half: exSize * 0.6 });
      }
    }

    // Line 3: Location (below EXIF)
    if (hasLocationBelow) {
      const locFont = `300 ${Math.round(soSize * 0.82)}px ${stack}`;
      ctx.font      = locFont;
      ctx.fillStyle = muted;
      const pinSize = soSize * 0.52;
      const textW   = ctx.measureText(exif.location).width;
      const totalW  = pinSize * 1.5 + textW;
      const startX  = centerX - totalW / 2;
      drawLocationPin(ctx, startX + pinSize * 0.6, line3Y, pinSize, muted, settings.locationIconStyle);
      ctx.textAlign = 'left';
      ctx.fillText(exif.location, startX + pinSize * 1.5, line3Y);
      checkSpan(startX, startX + totalW);
      drawnLines.push({ y: line3Y, half: Math.round(soSize * 0.82) * 0.6 });
    }

    if (drawnLines.length) {
      const captionTop = Math.min(...drawnLines.map(line => line.y - line.half));
      const captionBottom = Math.max(...drawnLines.map(line => line.y + line.half));
      if (captionTop < imageBottom) report('text-overlaps-photo');
      if (captionBottom > layout.canvasH) report('text-below-frame');
    }

    ctx.restore();
  }

  /** Estimate the luminance behind the text block for automatic contrast. */
  function detectTextBackgroundDark(ctx, layout, settings) {
    if (settings.frameBackground !== 'blur') return isColorDark(layout.frameColor || '#F0F0F0');
    try {
      if (!textBackgroundSampler) {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 4;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas sampling is unavailable');
        textBackgroundSampler = { canvas, context };
      }
      const { canvas: sample, context: sampleCtx } = textBackgroundSampler;
      // Map the caption band through the current transform: the frame may be
      // offset inside a padded output and scaled to a preview backing store.
      const matrix = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
      const toDevice = (x, y) => (matrix
        ? { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }
        : { x, y });
      const start = toDevice(0, layout.imageBottom);
      const end = toDevice(layout.canvasW, layout.imageBottom + layout.bottomAreaHeight);
      const sx = Math.max(0, Math.min(ctx.canvas.width - 1, Math.round(Math.min(start.x, end.x))));
      const sy = Math.max(0, Math.min(ctx.canvas.height - 1, Math.round(Math.min(start.y, end.y))));
      const sw = Math.max(1, Math.min(ctx.canvas.width - sx, Math.round(Math.abs(end.x - start.x))));
      const sh = Math.max(1, Math.min(ctx.canvas.height - sy, Math.round(Math.abs(end.y - start.y))));
      sampleCtx.clearRect(0, 0, sample.width, sample.height);
      sampleCtx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sample.width, sample.height);
      const pixels = sampleCtx.getImageData(0, 0, sample.width, sample.height).data;
      let luminance = 0;
      let weight = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3] / 255;
        luminance += (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) * alpha;
        weight += alpha;
      }
      return weight ? (luminance / weight) < 145 : (settings.blurBrightness ?? 80) < 105;
    } catch {
      return (settings.blurBrightness ?? 80) < 105;
    }
  }

  function drawLocationPin(ctx, cx, cy, size, color, style) {
    ctx.save();
    ctx.fillStyle = color;

    if (style === 'dot') {
      // Ring + center dot
      ctx.beginPath();
      ctx.arc(cx, cy - size * 0.1, size * 0.42, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, size * 0.12);
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy - size * 0.1, size * 0.14, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else if (style === 'compass') {
      // Diamond marker
      const r = size * 0.52;
      ctx.translate(cx, cy - size * 0.15);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.lineWidth = Math.max(1, size * 0.1);
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else if (style === 'globe') {
      // Flag marker
      const topY = cy - size * 0.6;
      const baseY = cy + size * 0.48;
      const poleX = cx - size * 0.18;
      const w = size * 0.8;
      const h = size * 0.45;
      ctx.beginPath();
      ctx.moveTo(poleX, topY);
      ctx.lineTo(poleX, baseY);
      ctx.lineWidth = Math.max(1, size * 0.1);
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(poleX, topY + size * 0.05);
      ctx.lineTo(poleX + w, topY + size * 0.05);
      ctx.lineTo(poleX + w * 0.72, topY + h);
      ctx.lineTo(poleX + w, topY + h + size * 0.02);
      ctx.lineTo(poleX, topY + h + size * 0.02);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(poleX, baseY, size * 0.12, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Default 'pin': teardrop pin with circle head
      ctx.beginPath();
      ctx.arc(cx, cy - size * 0.55, size * 0.44, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.28, cy - size * 0.2);
      ctx.lineTo(cx + size * 0.28, cy - size * 0.2);
      ctx.lineTo(cx, cy + size * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.arc(cx, cy - size * 0.55, size * 0.17, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function computePostProcessLayout(sourceW, sourceH, settings) {
    const {
      outerPadding = 0,
      aspectRatio = 'original',
      aspectOrientation = 'auto',
    } = settings;
    const W = sourceW;
    const H = sourceH;

    let tW = W, tH = H;
    if (aspectRatio && aspectRatio !== 'original') {
      let [aw, ah] = aspectRatio.split(':').map(Number);
      if (Number.isFinite(aw) && Number.isFinite(ah) && aw > 0 && ah > 0) {
        const sourceLandscape = W >= H;
        if (
          (aspectOrientation === 'portrait' && aw > ah) ||
          (aspectOrientation === 'landscape' && aw < ah) ||
          (aspectOrientation === 'auto' && ((sourceLandscape && aw < ah) || (!sourceLandscape && aw > ah)))
        ) {
          [aw, ah] = [ah, aw];
        }
      }
      const tr = aw / ah, sr = W / H;
      if (tr > sr) { tW = Math.round(H * tr); tH = H; }
      else if (tr < sr) { tW = W; tH = Math.round(W / tr); }
    }

    const pad = Math.round(Math.max(tW, tH) * (outerPadding || 0) / 100);
    const canvasW = tW + pad * 2;
    const canvasH = tH + pad * 2;
    return {
      canvasW,
      canvasH,
      contentX: Math.round((canvasW - W) / 2),
      contentY: Math.round((canvasH - H) / 2),
      changed: canvasW !== W || canvasH !== H,
    };
  }

  function formatShutter(val) {
    if (typeof InstaFrameCore === 'undefined') return String(val);
    const seconds = InstaFrameCore.parseExposureSeconds(val);
    if (seconds == null) return String(val);
    return `${InstaFrameCore.formatExposureTime(seconds)}s`;
  }

  function isColorDark(hex) {
    const c = (hex || '#f0f0f0').replace('#', '');
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
  }

  function mixHexColor(a, b, t = 0.5) {
    const ta = Math.min(1, Math.max(0, Number(t)));
    const p = (hex, i) => parseInt((hex || '#000000').replace('#', '').slice(i, i + 2), 16) || 0;
    const ch = i => Math.round((1 - ta) * p(a, i) + ta * p(b, i));
    const toHex = v => v.toString(16).padStart(2, '0');
    return `#${toHex(ch(0))}${toHex(ch(2))}${toHex(ch(4))}`;
  }

  function hasImageSignature(bytes, format) {
    if (format === 'png') {
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      return signature.every((value, index) => bytes[index] === value);
    }
    if (format === 'webp') {
      return bytes.length >= 12
        && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    }
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  async function canvasToBlob(canvas, {
    format = 'jpeg',
    quality = 0.92,
    signal = null,
    timeoutMs = IMAGE_ENCODE_GUARD_MS,
  } = {}) {
    const mime = format === 'png'  ? 'image/png'
               : format === 'webp' ? 'image/webp'
               :                     'image/jpeg';
    // PNG is lossless — no quality arg
    assertNotAborted(signal);
    const priorEncode = _canvasEncodeLocks.get(canvas);
    if (priorEncode) {
      await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const finish = callback => value => {
          if (settled) return;
          settled = true;
          cleanup();
          callback(value);
        };
        const succeed = finish(resolve);
        const fail = finish(reject);
        const abort = () => fail(new DOMException('Export cancelled', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else priorEncode.then(succeed, fail);
      });
      assertNotAborted(signal);
    }

    let releaseNativeEncode;
    const nativeEncode = new Promise(resolve => { releaseNativeEncode = resolve; });
    let nativeEncodeSettled = false;
    let nativeEncodeTimeoutId = null;
    const finishNativeEncode = () => {
      if (nativeEncodeSettled) return;
      nativeEncodeSettled = true;
      clearTimeout(nativeEncodeTimeoutId);
      nativeEncodeTimeoutId = null;
      if (_canvasEncodeLocks.get(canvas) === nativeEncode) _canvasEncodeLocks.delete(canvas);
      releaseNativeEncode();
    };
    _canvasEncodeLocks.set(canvas, nativeEncode);

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
      };
      const succeed = blob => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(blob);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => fail(new DOMException('Export cancelled', 'AbortError'));
      nativeEncodeTimeoutId = setTimeout(() => {
        const error = new Error('Image encoding timed out');
        error.code = 'IMAGE_ENCODE_TIMEOUT';
        finishNativeEncode();
        fail(error);
      }, resolveGuardTimeout(timeoutMs, IMAGE_ENCODE_GUARD_MS));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        canvas.toBlob(async blob => {
          finishNativeEncode();
          if (settled) return;
          if (!blob) { fail(new Error('Image encoding failed')); return; }
          try {
            const bytes = await _readBlobBytesWithSignal(blob.slice(0, 16), signal);
            if (!hasImageSignature(bytes, format)) {
              fail(new Error(`Browser did not encode the requested ${mime} format`));
              return;
            }
            succeed(blob.type.toLowerCase() === mime ? blob : new Blob([blob], { type: mime }));
          } catch (error) {
            fail(error);
          }
        }, mime, format === 'png' ? undefined : quality);
      } catch (error) {
        finishNativeEncode();
        fail(error);
      }
    });
  }

  function loadImage(file, { signal, timeoutMs = IMAGE_LOAD_GUARD_MS } = {}) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      let settled = false;
      let timeoutId = null;
      const cleanup = () => {
        clearTimeout(timeoutId);
        runBestEffortCleanup(() => signal?.removeEventListener('abort', abort));
        img.onload = null;
        img.onerror = null;
        revokeObjectUrl(url);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(img);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        runBestEffortCleanup(() => img.removeAttribute('src'));
        cleanup();
        reject(error);
      };
      const abort = () => fail(new DOMException('Image load cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      img.onload  = succeed;
      img.onerror = () => fail(new Error('Image load failed'));
      timeoutId = setTimeout(() => {
        const error = new Error('Image load timed out');
        error.code = 'IMAGE_DECODE_TIMEOUT';
        fail(error);
      }, timeoutMs);
      try { img.src = url; }
      catch (error) { fail(error); }
    });
  }

  // ─── Video helpers ────────────────────────────────────────────────────────

  /**
   * Capture a single frame from a video file as an HTMLImageElement.
   * @param {File}   file      - video file
   * @param {number} [atSecond=0] - timestamp to seek to
   */
  function captureVideoFrame(file, atSecond = 0, { signal, timeoutMs = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const url   = URL.createObjectURL(file);
      video.muted   = true;
      video.preload = 'metadata';
      let captured = false;
      let settled = false;
      let thumbnailCanvas = null;
      let thumbnailImage = null;
      let thumbnailUrl = null;
      let thumbnailLoaded = false;
      let sourceInfo = null;
      const timeout = setTimeout(() => fail(new Error('Video thumbnail timed out')), timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (thumbnailCanvas) {
          releaseCanvasBackingStore(thumbnailCanvas);
          thumbnailCanvas = null;
        }
        if (thumbnailImage) {
          thumbnailImage.onload = null;
          thumbnailImage.onerror = null;
          if (!thumbnailLoaded) runBestEffortCleanup(() => thumbnailImage.removeAttribute('src'));
        }
        revokeObjectUrl(thumbnailUrl);
        thumbnailUrl = null;
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.onerror = null;
        releaseMediaElementSource(video);
        revokeObjectUrl(url);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const succeed = img => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(img);
      };
      const abort = () => fail(new DOMException('Thumbnail cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }

      video.onloadedmetadata = () => {
        try {
          const sourceW = video.videoWidth;
          const sourceH = video.videoHeight;
          if (!sourceW || !sourceH) throw new Error('Invalid video dimensions');
          assertSafeCanvasSize(sourceW, sourceH);
          const duration = Number.isFinite(video.duration) ? video.duration : 0;
          sourceInfo = { width: sourceW, height: sourceH, duration };
          const t = Math.min(atSecond, Math.max(0, duration - 0.05));
          video.currentTime = t;
        } catch (error) {
          fail(error);
        }
      };

      video.onseeked = () => {
        if (captured) return;
        captured = true;
        const sourceW = video.videoWidth || 1280;
        const sourceH = video.videoHeight || 720;
        const scale = Math.min(1, 640 / sourceW, 360 / sourceH);
        const c = document.createElement('canvas');
        thumbnailCanvas = c;
        c.width  = Math.max(1, Math.round(sourceW * scale));
        c.height = Math.max(1, Math.round(sourceH * scale));
        const context = c.getContext('2d');
        if (!context) { c.width = 0; c.height = 0; fail(new Error('Canvas rendering is unavailable')); return; }
        try {
          context.drawImage(video, 0, 0, c.width, c.height);
        } catch (error) {
          c.width = 0;
          c.height = 0;
          fail(error);
          return;
        }
        try {
          c.toBlob(blob => {
            releaseCanvasBackingStore(c);
            if (thumbnailCanvas === c) thumbnailCanvas = null;
            if (settled) return;
            if (!blob) { fail(new Error('Video thumbnail encoding failed')); return; }
            try {
              thumbnailUrl = URL.createObjectURL(blob);
              thumbnailImage = new Image();
              // The thumbnail is downscaled; callers still need the real size.
              if (sourceInfo) {
                thumbnailImage.sourceWidth = sourceInfo.width;
                thumbnailImage.sourceHeight = sourceInfo.height;
                thumbnailImage.sourceDuration = sourceInfo.duration;
              }
              thumbnailImage.onload = () => {
                thumbnailLoaded = true;
                succeed(thumbnailImage);
              };
              thumbnailImage.onerror = () => fail(new Error('Video thumbnail load failed'));
              thumbnailImage.src = thumbnailUrl;
            } catch (error) {
              fail(error);
            }
          }, 'image/jpeg', 0.88);
        } catch (error) {
          releaseCanvasBackingStore(c);
          if (thumbnailCanvas === c) thumbnailCanvas = null;
          fail(error);
        }
      };

      video.onerror = () => fail(new Error('Video load failed'));
      try {
        video.src = url;
        video.load();
      } catch (error) {
        fail(error);
      }
    });
  }

  /**
   * WebCodecs fast-path: VideoEncoder + WebMMuxer + requestVideoFrameCallback at 16× speed.
   * Falls back to _renderVideoMediaRecorder on any error.
   */
  async function _renderVideoWebCodecs(file, exif, settings, {
    onProgress,
    frameRate = DEFAULT_VIDEO_CAPTURE_FPS,
    videoBitsPerSecond = 10_000_000,
    sourceBitrate = false,
    maxOutputBytes = MAX_ESTIMATED_VIDEO_BYTES,
    metadataTimeoutMs = VIDEO_METADATA_GUARD_MS,
    progressTimeoutMs = VIDEO_PROGRESS_GUARD_MS,
    signal,
  } = {}) {
    assertNotAborted(signal);
    await loadFrameFonts(settings, signal);
    assertNotAborted(signal);

    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const url   = URL.createObjectURL(file);
      video.muted   = true;
      video.preload = 'auto';
      let encoder = null;
      let canvas = null;
      let frameCallbackId = null;
      let settled = false;
      let finalizing = false;
      let backpressurePauseGeneration = 0;
      let metadataTimer = null;
      let progressTimer = null;

      const playVideo = () => {
        const pauseGeneration = backpressurePauseGeneration;
        return video.play().catch(error => {
          if (error?.name === 'AbortError' && backpressurePauseGeneration !== pauseGeneration) return;
          throw error;
        });
      };

      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        if (frameCallbackId != null && typeof video.cancelVideoFrameCallback === 'function') {
          runBestEffortCleanup(() => video.cancelVideoFrameCallback(frameCallbackId));
        }
        frameCallbackId = null;
        if (metadataTimer != null) clearTimeout(metadataTimer);
        if (progressTimer != null) clearTimeout(progressTimer);
        metadataTimer = null;
        progressTimer = null;
        video.onloadedmetadata = null;
        video.onended = null;
        video.onerror = null;
        releaseMediaElementSource(video);
        revokeObjectUrl(url);
        runBestEffortCleanup(() => {
          if (encoder && encoder.state !== 'closed') encoder.close();
        });
        releaseCanvasBackingStore(canvas);
      };
      const succeed = blob => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(blob);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => fail(new DOMException('Export cancelled', 'AbortError'));
      const armProgressWatchdog = () => {
        if (progressTimer != null) clearTimeout(progressTimer);
        progressTimer = setTimeout(
          () => fail(mediaTimeoutError('frame progress')),
          resolveGuardTimeout(progressTimeoutMs, VIDEO_PROGRESS_GUARD_MS)
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }

      video.onloadedmetadata = () => {
        if (metadataTimer != null) clearTimeout(metadataTimer);
        metadataTimer = null;
        try {
          assertNotAborted(signal);
          const W = video.videoWidth, H = video.videoHeight;
          if (!W || !H) throw new Error('Invalid video dimensions');
          const layout = computeFrameLayout(W, H, settings, exif);
          const { canvasW, canvasH } = layout;
          const duration = video.duration || 0;
          const effectiveBitrate = sourceBitrate
            ? (InstaFrameCore.estimateVideoBitrateFromFile(file.size, duration) || videoBitsPerSecond)
            : videoBitsPerSecond;
          if (duration > 0 && duration * effectiveBitrate / 8 > maxOutputBytes) {
            throw resourceLimitError();
          }
          const fps        = frameRate;
          const frameDurUs = Math.round(1_000_000 / fps);

          // This optional fast path is enabled only when a compatible muxer
          // global has been supplied by the host application.
          const MuxerCls = (typeof WebMMuxer !== 'undefined' && WebMMuxer.Muxer)
            ? WebMMuxer.Muxer : (typeof Muxer !== 'undefined' ? Muxer : null);
          const TargetCls = (typeof WebMMuxer !== 'undefined' && WebMMuxer.ArrayBufferTarget)
            ? WebMMuxer.ArrayBufferTarget : (typeof ArrayBufferTarget !== 'undefined' ? ArrayBufferTarget : null);
          if (!MuxerCls || !TargetCls) throw new Error('WebMMuxer not available');

          const muxTarget = new TargetCls();
          const muxer = new MuxerCls({
            target: muxTarget,
            video: { codec: 'V_VP9', width: canvasW, height: canvasH, frameRate: fps },
            firstTimestampBehavior: 'permissive',
          });
          let encodedBytes = 0;

          encoder = new VideoEncoder({
            output: (chunk, meta) => {
              if (settled) return;
              try {
                const chunkBytes = Number(chunk?.byteLength) || 0;
                if (chunkBytes > maxOutputBytes - encodedBytes) {
                  fail(resourceLimitError());
                  return;
                }
                encodedBytes += chunkBytes;
                muxer.addVideoChunk(chunk, meta);
              } catch (error) {
                fail(error);
              }
            },
            error: fail,
          });
          encoder.configure({
            codec: 'vp09.00.10.08',
            width: canvasW,
            height: canvasH,
            bitrate: effectiveBitrate,
            latencyMode: 'quality',
          });

          canvas = document.createElement('canvas');
          canvas.width  = canvasW;
          canvas.height = canvasH;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas rendering is unavailable');
          let frameIndex = 0;

          const finalize = async () => {
            if (settled || finalizing) return;
            finalizing = true;
            try {
              assertNotAborted(signal);
              if (frameIndex === 0) throw new Error('WebCodecs produced no video frames');
              await encoder.flush();
              assertNotAborted(signal);
              muxer.finalize();
              const { buffer } = muxTarget;
              if (!buffer) throw new Error('WebM muxing produced no output');
              const byteLength = buffer.byteLength ?? buffer.length ?? 0;
              if (byteLength > maxOutputBytes) throw resourceLimitError();
              if (onProgress) onProgress(1);
              succeed(new Blob([buffer], { type: 'video/webm' }));
            } catch (error) {
              fail(error);
            }
          };

          const onFrame = async (_now, metadata) => {
            frameCallbackId = null;
            if (settled || finalizing) return;
            try {
              assertNotAborted(signal);
              const timestamp = Math.round((metadata.mediaTime || 0) * 1_000_000);
              drawVideoFrameSync(ctx, video, exif, settings, layout);

              let resumeAfterDrain = false;
              if ((Number(encoder.encodeQueueSize) || 0) >= MAX_PENDING_VIDEO_ENCODES) {
                resumeAfterDrain = !video.ended;
                backpressurePauseGeneration += 1;
                video.pause();
                await encoder.flush();
                if (settled || finalizing) return;
                assertNotAborted(signal);
              }

              let frame = null;
              try {
                frame = new VideoFrame(canvas, { timestamp, duration: frameDurUs });
                encoder.encode(frame, { keyFrame: frameIndex % 60 === 0 });
              } finally {
                frame?.close();
              }
              frameIndex += 1;
              armProgressWatchdog();
              if (onProgress && duration > 0) onProgress(Math.min((metadata.mediaTime || 0) / duration, 0.99));
              if (settled || finalizing) return;

              if (!video.ended) {
                if (resumeAfterDrain && video.paused) await playVideo();
                if (settled || finalizing) return;
                frameCallbackId = video.requestVideoFrameCallback(onFrame);
              } else {
                await finalize();
              }
            } catch (error) {
              fail(error);
            }
          };

          video.onended = finalize;
          video.playbackRate = 16;
          armProgressWatchdog();
          frameCallbackId = video.requestVideoFrameCallback(onFrame);
          playVideo().catch(fail);
        } catch (error) {
          fail(error);
        }
      };

      video.onerror = () => fail(new Error('Video load failed'));
      metadataTimer = setTimeout(
        () => fail(mediaTimeoutError('metadata loading')),
        resolveGuardTimeout(metadataTimeoutMs, VIDEO_METADATA_GUARD_MS)
      );
      try {
        video.src = url;
        video.load();
      } catch (error) {
        fail(error);
      }
    });
  }

  /**
   * Render a video with EXIF frame borders using the Canvas + MediaRecorder pipeline.
   * Resolves with a Blob (video/webm) that includes the original audio track.
   * @param {File}     file
   * @param {object}   exif
   * @param {object}   settings
   * @param {object}   [opts]
   * @param {function} [opts.onProgress]  called with 0..1 during encoding
   */
  async function _readBlobBytesWithSignal(blob, signal) {
    assertNotAborted(signal);
    if (!signal) return new Uint8Array(await blob.arrayBuffer());
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', abort);
      const succeed = buffer => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(new Uint8Array(buffer));
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => fail(new DOMException('Export cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      blob.arrayBuffer().then(succeed, fail);
    });
  }

  async function _fileHasAudioTrackHint(file, signal) {
    const sampleSize = 1024 * 1024;
    const extension = String(file.name || '').split('.').pop().toLowerCase();
    const mime = String(file.type || '').toLowerCase();
    const isWebM = mime.includes('webm') || ['webm', 'mkv'].includes(extension);
    const isMp4 = mime.includes('mp4') || mime.includes('quicktime') || ['mp4', 'mov', 'm4v', '3gp'].includes(extension);
    const isAvi = mime.includes('avi') || extension === 'avi';
    if (!isWebM && !isMp4 && !isAvi) return null;

    const contains = (bytes, pattern) => {
      outer: for (let index = 0; index <= bytes.length - pattern.length; index += 1) {
        for (let offset = 0; offset < pattern.length; offset += 1) {
          if (bytes[index + offset] !== pattern[offset]) continue outer;
        }
        return true;
      }
      return false;
    };

    try {
      const head = await _readBlobBytesWithSignal(file.slice(0, sampleSize), signal);
      const samples = [head];
      if (file.size > sampleSize) {
        samples.push(await _readBlobBytesWithSignal(file.slice(Math.max(0, file.size - sampleSize)), signal));
      }
      if (isWebM) return samples.some(bytes => contains(bytes, [0x83, 0x81, 0x02])) || null; // EBML TrackType = audio
      if (isMp4) return samples.some(bytes => contains(bytes, [0x73, 0x6f, 0x75, 0x6e])) || null; // MP4 handler "soun"
      return samples.some(bytes => contains(bytes, [0x61, 0x75, 0x64, 0x73])) || null; // AVI stream "auds"
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return null;
    }
  }

  async function renderVideoFrameWhenReady(file, exif, settings, options = {}) {
    try {
      return await _renderVideoFrameWhenReady(file, exif, settings, options);
    } catch (error) {
      if (error?.code !== 'VIDEO_ENCODER_FAILED' || options.signal?.aborted) throw error;
      options.onRetry?.();
      assertNotAborted(options.signal);
      try {
        return await _renderVideoFrameWhenReady(file, exif, settings, { ...options, outputScale: 0.75 });
      } catch (retryError) {
        if (retryError?.name === 'AbortError') throw retryError;
        const failure = new Error(`${retryError?.message || 'Video export failed'} (first attempt: ${error.message})`);
        failure.name = retryError?.name || 'Error';
        if (retryError?.code) failure.code = retryError.code;
        throw failure;
      }
    }
  }

  function videoEncoderError(error) {
    const failure = new Error(error?.message || 'Video recorder failed');
    failure.code = 'VIDEO_ENCODER_FAILED';
    return failure;
  }

  // StreamTarget may rewrite container headers. Keep Blob slices for the
  // changed ranges rather than allocating another full-size output buffer.
  function createBoundedVideoTarget(maxBytes) {
    let parts = [];
    let length = 0;
    return {
      write({ data, position }) {
        const end = position + data.byteLength;
        if (!Number.isSafeInteger(position) || position < 0 || end > maxBytes) throw resourceLimitError();
        if (!data.byteLength) return;
        const replacement = { start: position, end, blob: new Blob([data]) };
        if (position === length) {
          parts.push(replacement);
          length = end;
          return;
        }
        const next = [];
        for (const part of parts) {
          if (part.end <= position || part.start >= end) {
            next.push(part);
          } else {
            if (part.start < position) next.push({ start: part.start, end: position, blob: part.blob.slice(0, position - part.start) });
            if (part.end > end) next.push({ start: end, end: part.end, blob: part.blob.slice(end - part.start) });
          }
        }
        next.push(replacement);
        next.sort((a, b) => a.start - b.start);
        parts = next;
        length = Math.max(length, end);
      },
      finish(type) {
        let offset = 0;
        for (const part of parts) {
          if (part.start !== offset) throw new Error('Video output contains an unwritten range');
          offset = part.end;
        }
        if (!length || offset !== length) throw new Error('Video output is empty');
        const result = new Blob(parts.map(part => part.blob), { type });
        parts = [];
        return result;
      },
      clear() { parts = []; },
    };
  }

  /** Decode and encode each input frame without depending on playback speed. */
  async function renderVideoFramesOffline(file, exif, settings, options) {
    const { onProgress, preferredMime, videoBitsPerSecond, sourceBitrate, preserveAudio,
      outputByteLimit, outputScale, signal, metadataTimeoutMs, progressTimeoutMs, onAutoScale, onSourceAudio,
      hardwareAcceleration = 'no-preference' } = options;
    if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined' ||
        typeof VideoFrame === 'undefined' || typeof WritableStream === 'undefined') return null;
    const isMp4 = String(preferredMime || '').startsWith('video/mp4');
    const isWebm = String(preferredMime || '').startsWith('video/webm');
    if (!isMp4 && !isWebm) return null;

    let input = null;
    const sink = createBoundedVideoTarget(outputByteLimit);
    let canvas = null;
    let conversion = null;
    let started = false;
    let interruptionError = null;
    let timer = null;
    let rejectInterruption;
    const interruption = new Promise((_, reject) => { rejectInterruption = reject; });
    const interrupt = error => {
      if (interruptionError) return;
      interruptionError = error;
      if (conversion) void conversion.cancel().catch(() => {});
      rejectInterruption(error);
    };
    const abort = () => interrupt(new DOMException('Export cancelled', 'AbortError'));
    const assertActive = () => { if (interruptionError) throw interruptionError; assertNotAborted(signal); };
    const armGuard = (phase, timeout) => {
      clearTimeout(timer);
      timer = setTimeout(() => interrupt(mediaTimeoutError(phase)), timeout);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    armGuard('metadata loading', resolveGuardTimeout(metadataTimeoutMs, VIDEO_METADATA_GUARD_MS));
    try {
      return await Promise.race([(async () => {
        const libraryUrl = new URL('vendor/mediabunny.min.js', document.baseURI);
        libraryUrl.search = new URL(engineScriptUrl).search;
        let media;
        try { media = await import(libraryUrl.href); }
        catch (_) { return null; }
        assertActive();
        input = new media.Input({ source: new media.BlobSource(file, { maxCacheSize: 4 * 1024 * 1024 }), formats: media.ALL_FORMATS });
        const videoTrack = await input.getPrimaryVideoTrack();
        const audioTrack = preserveAudio ? await input.getPrimaryAudioTrack() : null;
        assertActive();
        onSourceAudio?.(!!audioTrack);
        if (!videoTrack || !await videoTrack.canDecode()) {
          console.warn('Frame-by-frame video decoding is unavailable');
          return null;
        }
        const [width, height, duration] = await Promise.all([
          videoTrack.getDisplayWidth(), videoTrack.getDisplayHeight(), input.computeDuration(),
        ]);
        assertActive();
        armGuard('encoder setup', resolveGuardTimeout(progressTimeoutMs, VIDEO_PROGRESS_GUARD_MS));
        const layout = computeFrameLayout(width, height, settings, exif);
        const bitrate = sourceBitrate
          ? (InstaFrameCore.estimateVideoBitrateFromFile(file.size, duration) || videoBitsPerSecond)
          : videoBitsPerSecond;
        if (duration > 0 && duration * bitrate / 8 > outputByteLimit) throw resourceLimitError();
        const scale = Math.max(0.1, Math.min(1, Number(outputScale) || 1));
        const codec = isMp4 ? 'avc' : (preferredMime.includes('vp9') ? 'vp9' : 'vp8');
        const dimensions = factor => ({
          width: Math.max(2, Math.floor(layout.canvasW * factor / 2) * 2),
          height: Math.max(2, Math.floor(layout.canvasH * factor / 2) * 2),
        });
        const supported = async factor => {
          const size = dimensions(factor);
          return media.canEncodeVideo(codec, { ...size, bitrate, hardwareAcceleration });
        };
        let chosenScale = scale;
        if (!await supported(scale)) {
          let low = 0.5 * scale;
          let high = scale;
          if (!await supported(low)) return null;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const middle = (low + high) / 2;
            if (await supported(middle)) low = middle;
            else high = middle;
            assertActive();
          }
          chosenScale = low;
        }
        const { width: outWidth, height: outHeight } = dimensions(chosenScale);
        assertSafeCanvasSize(outWidth, outHeight);
        canvas = document.createElement('canvas');
        canvas.width = outWidth;
        canvas.height = outHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas rendering is unavailable');
        ctx.scale(outWidth / layout.canvasW, outHeight / layout.canvasH);
        await loadFrameFonts(settings, signal);
        const writable = new WritableStream({ write: chunk => { assertActive(); sink.write(chunk); } });
        const format = isMp4 ? new media.Mp4OutputFormat({ fastStart: false }) : new media.WebMOutputFormat();
        const output = new media.Output({ format, target: new media.StreamTarget(writable) });
        conversion = await media.Conversion.init({
          input, output, tracks: 'primary', showWarnings: false,
          copy: { shiftTolerance: 0.1 },
          audio: { discard: !preserveAudio },
          video: {
            codec, bitrate, hardwareAcceleration, processedWidth: outWidth, processedHeight: outHeight,
            allowTransformationMetadata: false,
            process(sample) {
              assertActive();
              armGuard('frame progress', resolveGuardTimeout(progressTimeoutMs, VIDEO_PROGRESS_GUARD_MS));
              drawVideoFrameSync(ctx, sample.toCanvasImageSource(), exif, settings, layout);
              return canvas;
            },
          },
        });
        if (interruptionError) await conversion.cancel().catch(() => {});
        assertActive();
        if (!conversion.isValid || !conversion.utilizedTracks.includes(videoTrack) ||
            (audioTrack && !conversion.utilizedTracks.includes(audioTrack))) {
          console.warn('Frame-by-frame video export is unsupported:', conversion.discardedTracks.map(track => track.reason).join(', '));
          return null;
        }
        conversion.onProgress = progress => onProgress?.(Math.min(progress, 0.99));
        started = true;
        armGuard('frame progress', resolveGuardTimeout(progressTimeoutMs, VIDEO_PROGRESS_GUARD_MS));
        await conversion.execute();
        assertActive();
        const blob = sink.finish(isMp4 ? 'video/mp4' : 'video/webm');
        if (chosenScale < 1) onAutoScale?.(outWidth, outHeight);
        onProgress?.(1);
        return blob;
      })(), interruption]);
    } catch (error) {
      if (interruptionError) throw interruptionError;
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (error?.code === 'MEDIA_RESOURCE_LIMIT' || error?.code === 'MEDIA_TIMEOUT') throw error;
      if (started) throw videoEncoderError(error);
      console.warn('Frame-by-frame video export could not be initialized:', error);
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (conversion && conversion.state !== 'done') {
        if (interruptionError) void conversion.cancel().catch(() => {});
        else await conversion.cancel().catch(() => {});
      }
      input?.dispose();
      sink.clear();
      releaseCanvasBackingStore(canvas);
    }
  }

  async function _renderVideoFrameWhenReady(file, exif, settings, {
    onProgress,
    preferredMime,
    videoBitsPerSecond = 10_000_000,
    sourceBitrate = false,
    preserveAudio = true,
    maxOutputBytes,
    metadataTimeoutMs,
    progressTimeoutMs,
    frameRate = DEFAULT_VIDEO_CAPTURE_FPS,
    outputScale = 1,
    onAutoScale,
    onRealtimeFallback,
    preferHardware = false,
    onMemoryFallback,
    signal,
  } = {}) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const outputByteLimit = resolveVideoOutputLimit(maxOutputBytes);
    const outputFrameRate = Number(frameRate) === 60 ? 60 : 30;
    let offlineSourceHasAudio = null;
    if (outputFrameRate === 60) {
      const offlineOptions = {
        onProgress, preferredMime, videoBitsPerSecond, sourceBitrate, preserveAudio,
        outputByteLimit, outputScale, signal, metadataTimeoutMs, progressTimeoutMs, onAutoScale,
        onSourceAudio: hasAudio => { offlineSourceHasAudio = hasAudio; },
      };
      let offline = null;
      if (preferHardware && typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined' &&
          typeof VideoFrame !== 'undefined' && typeof WritableStream !== 'undefined') {
        try {
          offline = await renderVideoFramesOffline(file, exif, settings, {
            ...offlineOptions, hardwareAcceleration: 'prefer-hardware',
          });
        } catch (error) {
          if (error?.code !== 'VIDEO_ENCODER_FAILED') throw error;
          assertNotAborted(signal);
          onProgress?.(0);
        }
        if (!offline) onMemoryFallback?.();
      }
      if (!offline) offline = await renderVideoFramesOffline(file, exif, settings, offlineOptions);
      if (offline) return offline;
      onRealtimeFallback?.();
    }
    // The WebCodecs fast path currently muxes video only. Use it exclusively
    // when a caller explicitly opts out of preserving the source audio.
    const canUseWebCodecs = typeof VideoEncoder !== 'undefined'
      && typeof VideoFrame !== 'undefined'
      && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function'
      && (typeof WebMMuxer !== 'undefined' || typeof Muxer !== 'undefined');
    if (!preserveAudio && canUseWebCodecs) {
      try {
        return await _renderVideoWebCodecs(file, exif, settings, {
          onProgress,
          videoBitsPerSecond,
          sourceBitrate,
          frameRate: outputFrameRate,
          maxOutputBytes: outputByteLimit,
          metadataTimeoutMs,
          progressTimeoutMs,
          signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (error?.code === 'MEDIA_RESOURCE_LIMIT') throw error;
        if (error?.code === 'MEDIA_TIMEOUT') throw error;
        assertNotAborted(signal);
        // Fall through to MediaRecorder path on any error
      }
    }

    // ── MediaRecorder fallback (can include source audio) ─────────────────────
    // Pre-load fonts (same as photo path)
    await loadFrameFonts(settings, signal);

    const sourceHasAudio = preserveAudio
      ? (offlineSourceHasAudio ?? await _fileHasAudioTrackHint(file, signal))
      : false;

    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const url   = URL.createObjectURL(file);
      video.muted   = true;   // must be muted for autoplay; source audio is captured separately
      video.preload = 'auto';
      let audioContext = null;
      let audioTrack = null;
      let outputStream = null;
      let sourceStream = null;
      let canvas = null;
      let recorder = null;
      let rafId = null;
      let frameCallbackId = null;
      let stopTimer = null;
      let metadataTimer = null;
      let progressTimer = null;
      let visibilityHandler = null;
      let visibilityPaused = false;
      let settled = false;
      let cleaned = false;

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        video.onloadedmetadata = null;
        video.onended = null;
        video.onerror = null;
        if (rafId != null) cancelAnimationFrame(rafId);
        if (frameCallbackId != null) runBestEffortCleanup(() => video.cancelVideoFrameCallback?.(frameCallbackId));
        frameCallbackId = null;
        if (stopTimer != null) clearTimeout(stopTimer);
        if (metadataTimer != null) clearTimeout(metadataTimer);
        if (progressTimer != null) clearTimeout(progressTimer);
        metadataTimer = null;
        progressTimer = null;
        if (visibilityHandler) {
          document.removeEventListener('visibilitychange', visibilityHandler);
          visibilityHandler = null;
        }
        if (recorder && recorder.state !== 'inactive') {
          try { recorder.stop(); } catch (_) {}
        }
        if (recorder) {
          recorder.ondataavailable = null;
          recorder.onstop = null;
          recorder.onerror = null;
        }
        releaseMediaElementSource(video);
        revokeObjectUrl(url);
        const mediaTracks = new Set();
        try { outputStream?.getTracks().forEach(track => mediaTracks.add(track)); } catch (_) {}
        try { sourceStream?.getTracks().forEach(track => mediaTracks.add(track)); } catch (_) {}
        if (audioTrack) mediaTracks.add(audioTrack);
        for (const track of mediaTracks) {
          try { track.stop(); } catch (_) {}
        }
        runBestEffortCleanup(() => {
          if (audioContext && audioContext.state !== 'closed') {
            audioContext.close()?.catch?.(() => {});
          }
        });
        releaseCanvasBackingStore(canvas);
        signal?.removeEventListener('abort', abort);
      };

      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = () => {
        if (recorder && recorder.state !== 'inactive') {
          try { recorder.stop(); } catch (_) {}
        }
        fail(new DOMException('Export cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }

      const armProgressWatchdog = () => {
        if (progressTimer != null) clearTimeout(progressTimer);
        progressTimer = setTimeout(
          () => fail(mediaTimeoutError('frame progress')),
          resolveGuardTimeout(progressTimeoutMs, VIDEO_PROGRESS_GUARD_MS)
        );
      };

      const armFinalizationWatchdog = () => {
        if (progressTimer != null) clearTimeout(progressTimer);
        progressTimer = setTimeout(
          () => fail(mediaTimeoutError('recorder finalization')),
          VIDEO_RECORDER_FLUSH_DELAY_MS +
            resolveGuardTimeout(progressTimeoutMs, VIDEO_PROGRESS_GUARD_MS)
        );
      };

      const stopRecorderAfterFlush = () => {
        if (settled || stopTimer != null) return;
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (frameCallbackId != null) {
          runBestEffortCleanup(() => video.cancelVideoFrameCallback?.(frameCallbackId));
          frameCallbackId = null;
        }
        armFinalizationWatchdog();
        stopTimer = setTimeout(() => {
          stopTimer = null;
          if (settled || !recorder || recorder.state === 'inactive') return;
          try { recorder.stop(); } catch (error) { fail(error); }
        }, VIDEO_RECORDER_FLUSH_DELAY_MS);
      };

      video.onloadedmetadata = () => {
        if (settled || signal?.aborted) return;
        if (metadataTimer != null) clearTimeout(metadataTimer);
        metadataTimer = null;
        try {
          assertNotAborted(signal);
          const W = video.videoWidth;
          const H = video.videoHeight;
          if (!W || !H) { fail(new Error('Invalid video dimensions')); return; }
        const layout = computeFrameLayout(W, H, settings, exif);
        const { canvasW, canvasH } = layout;
        const duration = video.duration || 0;
        const effectiveBitrate = sourceBitrate
          ? (InstaFrameCore.estimateVideoBitrateFromFile(file.size, duration) || videoBitsPerSecond)
          : videoBitsPerSecond;
        try {
          if (duration > 0 && duration * effectiveBitrate / 8 > outputByteLimit) {
            throw resourceLimitError();
          }
        } catch (error) {
          fail(error);
          return;
        }

        canvas = document.createElement('canvas');
        const scale = Math.max(0.1, Math.min(1, Number(outputScale) || 1));
        canvas.width = scale === 1 ? canvasW : Math.max(2, Math.floor(canvasW * scale / 2) * 2);
        canvas.height = scale === 1 ? canvasH : Math.max(2, Math.floor(canvasH * scale / 2) * 2);
        const ctx = canvas.getContext('2d');
        if (!ctx) { fail(new Error('Canvas rendering is unavailable')); return; }
        ctx.scale(canvas.width / canvasW, canvas.height / canvasH);

        // ── Preserve the source audio without playing it on the page ──
        try {
          const capture = video.captureStream || video.mozCaptureStream;
          if (capture && sourceHasAudio !== false) {
            sourceStream = capture.call(video);
            audioTrack = sourceStream.getAudioTracks()[0] || null;
          }
        } catch (_) { /* captureStream is not implemented consistently */ }

        // Older browsers without HTMLMediaElement.captureStream use Web Audio.
        try {
          if (!audioTrack && sourceHasAudio !== false) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            audioContext.resume().catch(() => {});
            const src  = audioContext.createMediaElementSource(video);
            const dest = audioContext.createMediaStreamDestination();
            src.connect(dest);   // route to MediaStream (recorded)
            // NOT connecting to audioContext.destination keeps page muted
            audioTrack = dest.stream.getAudioTracks()[0] || null;
          }
        } catch (_) { /* no audio support or no audio track */ }

        if (sourceHasAudio !== false && !audioTrack) {
          fail(new Error('The source audio could not be captured for video export'));
          return;
        }

        // ── Build output stream: canvas video + original audio ──
        outputStream = canvas.captureStream(outputFrameRate);
        const videoTrack = outputStream.getVideoTracks?.()[0];
        if (audioTrack) outputStream.addTrack(audioTrack);

        const candidates = preferredMime
          ? [preferredMime, 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
          : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        const mimeType = candidates.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
        if (!mimeType) { fail(new Error('Video export is not supported by this browser')); return; }

        try {
          recorder = new MediaRecorder(outputStream, { mimeType, videoBitsPerSecond: effectiveBitrate });
        } catch (error) {
          fail(videoEncoderError(error));
          return;
        }
        const chunks = [];
        let recordedBytes = 0;
        let lastMediaTime = -1;
        let lastDrawnFrame = -1;
        let lastDrawnMediaTime = -Infinity;
        recorder.ondataavailable = event => {
          if (event.data.size <= 0 || settled) return;
          recordedBytes += event.data.size;
          if (recordedBytes > outputByteLimit) {
            if (recorder.state !== 'inactive') {
              try { recorder.stop(); } catch (_) {}
            }
            fail(resourceLimitError());
            return;
          }
          chunks.push(event.data);
        };
        recorder.onstop = () => {
          if (settled) { cleanup(); return; }
          const blob = new Blob(chunks, { type: mimeType });
          if (blob.size > outputByteLimit) {
            fail(resourceLimitError());
            return;
          }
          settled = true;
          cleanup();
          resolve(blob);
        };
        recorder.onerror = event => {
          fail(videoEncoderError(event.error));
        };
        video.onended = () => {
          if (visibilityPaused || document.visibilityState === 'hidden') {
            fail(new Error('Video export was interrupted while the page was hidden'));
            return;
          }
          stopRecorderAfterFlush();
        };

        const useVideoFrames = outputFrameRate === 60 &&
          typeof video.requestVideoFrameCallback === 'function' &&
          typeof video.cancelVideoFrameCallback === 'function';
        function scheduleFrame() {
          if (useVideoFrames) frameCallbackId = video.requestVideoFrameCallback(drawLoop);
          else rafId = requestAnimationFrame(drawLoop);
        }
        function drawLoop(_now, metadata) {
          try {
            rafId = null;
            frameCallbackId = null;
            if (settled || visibilityPaused) return;
            assertNotAborted(signal);
            const mediaTime = Number(metadata?.mediaTime ?? video.currentTime) || 0;
            const frameIndex = Math.floor(mediaTime * outputFrameRate);
            const shouldDraw = useVideoFrames
              ? mediaTime - lastDrawnMediaTime >= 1 / outputFrameRate - 0.002
              : frameIndex !== lastDrawnFrame;
            if (shouldDraw) {
              drawVideoFrameSync(ctx, video, exif, settings, layout);
              if (outputFrameRate === 60 && typeof videoTrack?.requestFrame === 'function') {
                runBestEffortCleanup(() => videoTrack.requestFrame());
              }
              lastDrawnFrame = frameIndex;
              lastDrawnMediaTime = mediaTime;
            }
            if (mediaTime > lastMediaTime) {
              lastMediaTime = mediaTime;
              armProgressWatchdog();
            }

            if (onProgress && duration > 0) onProgress(Math.min(mediaTime / duration, 1));

            if (!video.ended && !video.paused) {
              scheduleFrame();
            } else {
              stopRecorderAfterFlush();
            }
          } catch (error) {
            fail(error);
          }
        }

        const startVisiblePlayback = () => {
          if (settled || signal?.aborted || visibilityPaused || document.visibilityState === 'hidden') return;
          try {
            if (recorder.state === 'paused') recorder.resume();
            armProgressWatchdog();
            video.play()
              .then(() => {
                if (settled || signal?.aborted) return;
                if (document.visibilityState === 'hidden') {
                  visibilityHandler?.();
                  return;
                }
                if (!visibilityPaused && rafId == null && frameCallbackId == null) scheduleFrame();
              })
              .catch(error => {
                if (visibilityPaused || document.visibilityState === 'hidden') return;
                if (recorder.state !== 'inactive') recorder.stop();
                fail(error);
              });
          } catch (error) {
            fail(error);
          }
        };

        visibilityHandler = () => {
          if (settled || signal?.aborted) return;
          if (document.visibilityState === 'hidden') {
            if (visibilityPaused) return;
            visibilityPaused = true;
            if (rafId != null) {
              cancelAnimationFrame(rafId);
              rafId = null;
            }
            if (frameCallbackId != null) {
              runBestEffortCleanup(() => video.cancelVideoFrameCallback?.(frameCallbackId));
              frameCallbackId = null;
            }
            if (progressTimer != null) {
              clearTimeout(progressTimer);
              progressTimer = null;
            }
            try {
              video.pause();
              if (recorder.state === 'recording') recorder.pause();
            } catch (error) {
              fail(error);
            }
            return;
          }
          if (!visibilityPaused) return;
          visibilityPaused = false;
          startVisiblePlayback();
        };
        document.addEventListener('visibilitychange', visibilityHandler);

          try { recorder.start(200); }
          catch (error) { fail(videoEncoderError(error)); return; }
          if (document.visibilityState === 'hidden') visibilityHandler();
          else startVisiblePlayback();
        } catch (error) {
          fail(error);
        }
      };

      video.onerror = () => fail(new Error('Video load failed'));
      metadataTimer = setTimeout(
        () => fail(mediaTimeoutError('metadata loading')),
        resolveGuardTimeout(metadataTimeoutMs, VIDEO_METADATA_GUARD_MS)
      );
      try {
        video.src = url;
        video.load();
      } catch (error) {
        fail(error);
      }
    });
  }

  /**
   * Compute the frame layout for a photo or video of the given pixel size:
   * the caption frame (base*) and the final output after aspect ratio and
   * outer padding, with the frame's offset inside it (frameX / frameY).
   */
  function computeUnboundedFrameLayout(sourceW, sourceH, settings, exif = {}) {
    const W = sourceW, H = sourceH;
    const isPortrait    = H > W;
    const ts            = settings.thicknessScale || 1;
    const baseBorder    = Math.min(W, H) * 0.05 * 1.2 * ts;
    const sideBorder    = baseBorder * 0.5;
    const showLoc       = settings.showLocation && exif?.location && settings.locationPosition === 'below-exif';
    const locationExtra = showLoc ? H * 0.038 * ts : 0;
    const bottomBorder  = sideBorder * 4 + H * 0.10 * ts + locationExtra;
    const pf            = isPortrait ? 0.75 : 1.0;
    const sB            = sideBorder   * pf;
    const tB            = sideBorder   * pf;
    const bB            = bottomBorder * pf;
    const imageLayout   = computeImageVerticalLayout(H, tB, bB, settings.imageOffsetY);
    const baseCanvasW   = Math.round(W + sB * 2);
    const baseCanvasH   = imageLayout.canvasH;
    const frameColor    = settings.frameColor || '#F0F0F0';
    const postProcess = computePostProcessLayout(baseCanvasW, baseCanvasH, settings);
    return {
      W, H, sB, tB, bB,
      baseCanvasW,
      baseCanvasH,
      canvasW: postProcess.canvasW,
      canvasH: postProcess.canvasH,
      frameX: postProcess.contentX,
      frameY: postProcess.contentY,
      hasPostProcess: postProcess.changed,
      imageTop:    imageLayout.imageTop,
      imageBottom: imageLayout.imageBottom,
      isPortrait,
      frameColor,
    };
  }

  function computeFrameLayout(sourceW, sourceH, settings, exif = {}) {
    const layout = computeUnboundedFrameLayout(sourceW, sourceH, settings, exif);
    assertSafeCanvasSize(layout.baseCanvasW, layout.baseCanvasH);
    assertSafeCanvasSize(layout.canvasW, layout.canvasH);
    return layout;
  }

  /** Fit a 2D photo and its frame inside the browser's Canvas budget. */
  function computePhotoOutputSize(sourceW, sourceH, settings, exif = {}, {
    maxPixels = MAX_CANVAS_PIXELS,
    maxSide = MAX_CANVAS_DIMENSION,
  } = {}) {
    if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) ||
        sourceW < 1 || sourceH < 1 || !Number.isFinite(maxPixels) ||
        !Number.isFinite(maxSide) || maxPixels < 1 || maxSide < 1) {
      throw resourceLimitError();
    }
    const pixelLimit = Math.min(MAX_CANVAS_PIXELS, maxPixels);
    const sideLimit = Math.min(MAX_CANVAS_DIMENSION, maxSide);
    const fits = layout => layout.baseCanvasW <= sideLimit &&
      layout.baseCanvasH <= sideLimit && layout.canvasW <= sideLimit &&
      layout.canvasH <= sideLimit &&
      layout.baseCanvasW * layout.baseCanvasH <= pixelLimit &&
      layout.canvasW * layout.canvasH <= pixelLimit;
    const output = (width, height, layout) => ({
      width: layout.canvasW,
      height: layout.canvasH,
      sourceWidth: width,
      sourceHeight: height,
      scaled: width !== sourceW || height !== sourceH,
    });
    const original = computeUnboundedFrameLayout(sourceW, sourceH, settings, exif);
    if (fits(original)) return output(sourceW, sourceH, original);

    let low = 0;
    let high = 1;
    let best = null;
    for (let attempt = 0; attempt < 28; attempt += 1) {
      const scale = (low + high) / 2;
      const width = Math.max(1, Math.floor(sourceW * scale));
      const height = Math.max(1, Math.floor(sourceH * scale));
      const layout = computeUnboundedFrameLayout(width, height, settings, exif);
      if (fits(layout)) {
        best = output(width, height, layout);
        low = scale;
      } else {
        high = scale;
      }
    }
    if (!best) throw resourceLimitError();
    return best;
  }

  /**
   * Draw one video frame (with EXIF frame borders) synchronously onto ctx.
   * ctx must already be scaled so that 1 unit = 1 logical canvas pixel
   * (i.e. the caller handles DPR scaling before calling this). The output is
   * drawn in one pass, so no scratch canvas is needed. The caption's layout
   * issues are stored on layout.layoutIssues.
   */
  function drawVideoFrameSync(ctx, video, exif, settings, layout) {
    drawFrameBackground(ctx, video, settings, layout);
    layout.layoutIssues = drawFrameContent(ctx, video, exif, settings, layout);
  }

  /** Pixel size of the exported frame for a sourceW × sourceH photo or video. */
  function computeOutputSize(sourceW, sourceH, settings, exif = {}) {
    const layout = computeFrameLayout(sourceW, sourceH, settings, exif);
    return { width: layout.canvasW, height: layout.canvasH };
  }

  const computeVideoFrameLayout = computeFrameLayout;

  return {
    renderFrame,
    renderFrameWhenReady,
    canvasToBlob,
    loadImage,
    captureVideoFrame,
    renderVideoFrameWhenReady,
    isColorDark,
    computeFrameLayout,
    computeVideoFrameLayout,
    computeOutputSize,
    computePhotoOutputSize,
    drawVideoFrameSync,
    estimateStereoDisparity,
  };
})();

if (typeof window !== 'undefined') window.FrameEngine = FrameEngine;
