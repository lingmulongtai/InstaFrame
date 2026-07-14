/**
 * frame-engine.js — Canvas-based EXIF frame generator
 */

const FrameEngine = (() => {

  const MAX_CANVAS_DIMENSION = 16_384;
  const MAX_CANVAS_PIXELS = 64_000_000;
  const MAX_ESTIMATED_VIDEO_BYTES = 512 * 1024 * 1024;
  const MAX_PENDING_VIDEO_ENCODES = 4;
  const FONT_LOAD_GUARD_MS = 5_000;
  const IMAGE_LOAD_GUARD_MS = 15_000;
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

  function assertSafeCanvasSize(width, height) {
    if (
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width < 1 || height < 1 ||
      width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION ||
      width * height > MAX_CANVAS_PIXELS
    ) throw resourceLimitError();
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

  async function loadFrameFonts(settings, signal = null) {
    assertNotAborted(signal);
    if (!document.fonts) return;
    const family = settings.fontFamily || 'Inter';
    const fam = `'${family}'`;
    const cameraStyle = settings.cameraNameItalic ? 'italic ' : '';
    const exifStyle = settings.exifItalic ? 'italic ' : '';
    const specs = new Set([
      `${cameraStyle}${settings.cameraNameBold ? '700' : '300'} 16px ${fam}`,
      `${cameraStyle}${settings.cameraNameBold ? '700' : '500'} 16px ${fam}`,
      `${cameraStyle}400 16px ${fam}`,
      `${exifStyle}300 16px ${fam}`,
    ]);
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
   */
  function renderFrame(img, exif, settings, mapOverlayImg = null) {
    const {
      frameColor       = '#F0F0F0',
      thicknessScale   = 1.0,
      showLocation     = false,
      locationPosition = 'below-exif',
    } = settings;

    const W = img.naturalWidth || img.videoWidth || img.width;
    const H = img.naturalHeight || img.videoHeight || img.height;
    const isPortrait = H > W;

    const baseBorder      = Math.min(W, H) * 0.05 * 1.2 * thicknessScale;
    const sideBorder      = baseBorder * 0.5;
    const extraHeight     = H * 0.10 * thicknessScale;
    const locationExtra   = (showLocation && exif.location && locationPosition === 'below-exif')
                            ? H * 0.038 * thicknessScale : 0;
    const bottomBorder    = sideBorder * 4 + extraHeight + locationExtra;
    const pf           = isPortrait ? 0.75 : 1.0;
    const sB = sideBorder   * pf;
    const tB = sideBorder   * pf;
    const bB = bottomBorder * pf;
    const imageLayout = computeImageVerticalLayout(H, tB, bB, settings.imageOffsetY);

    const canvasW = Math.round(W + sB * 2);
    const canvasH = imageLayout.canvasH;
    assertSafeCanvasSize(canvasW, canvasH);

    const canvas = document.createElement('canvas');
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is unavailable');

    if (settings.frameBackground === 'blur') {
      drawBlurBackground(ctx, img, canvasW, canvasH, settings);
    } else {
      ctx.fillStyle = frameColor;
      ctx.fillRect(0, 0, canvasW, canvasH);
    }
    drawImageAtY(ctx, img, sB, imageLayout.imageTop, W, H);
    drawInnerShadow(ctx, sB, imageLayout.imageTop, W, H);

    // Map overlay (Passage-style): drawn in the bottom-right corner of the photo
    if (mapOverlayImg && settings.showMapOverlay) {
      drawMapOverlay(ctx, mapOverlayImg, settings, { sB, tB: imageLayout.imageTop, W, H });
    }

    drawExifText(ctx, exif, settings, {
      canvasW, canvasH,
      imageBottom: imageLayout.imageBottom,
      bottomAreaHeight: bB,
      isPortrait,
      frameColor,
    });

    return canvas;
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
  }

  /**
   * Load fonts needed for the current settings, then render.
   * Pass maxPreviewPx to scale the image down for fast live preview.
   * Pass mapOverlayImg (HTMLImageElement) to draw a Passage-style map overlay.
   */
  async function renderFrameWhenReady(img, exif, settings, { maxPreviewPx = null, mapOverlayImg = null, signal = null } = {}) {
    assertNotAborted(signal);
    await loadFrameFonts(settings, signal);
    assertNotAborted(signal);

    const renderImg = maxPreviewPx ? await scaleImage(img, maxPreviewPx, signal) : img;
    let base = null;
    let output = null;
    try {
      base = renderFrame(renderImg, exif, settings, mapOverlayImg);
      if (signal?.aborted) {
        base.width = 0;
        base.height = 0;
        assertNotAborted(signal);
      }
      const result = applyPostProcess(base, settings);
      if (result !== base) { base.width = 0; base.height = 0; }
      output = result;
      if (signal?.aborted) {
        result.width = 0;
        result.height = 0;
        assertNotAborted(signal);
      }
      return result;
    } catch (error) {
      const disposable = output || base;
      if (disposable) {
        disposable.width = 0;
        disposable.height = 0;
      }
      throw error;
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
    ctx.fillRect(x, y, w, h);
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
    ctx.filter = `${styleFilter}blur(${radius}px) brightness(${brightness}%)`;

    // Scale the source to cover the canvas (object-fit: cover)
    const srcW = src.naturalWidth  || src.videoWidth  || src.width  || canvasW;
    const srcH = src.naturalHeight || src.videoHeight || src.height || canvasH;
    const scale = Math.max(canvasW / srcW, canvasH / srcH);
    const dw = Math.ceil(srcW * scale);
    const dh = Math.ceil(srcH * scale);
    const dx = Math.round((canvasW - dw) / 2);
    const dy = Math.round((canvasH - dh) / 2);

    ctx.drawImage(src, dx, dy, dw, dh);
    ctx.filter = 'none';
    ctx.restore();
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

    // Target size: ~28% of the shorter side, capped at 320px
    const shortSide = Math.min(W, H);
    const ovW = Math.min(320, Math.round(shortSide * 0.28));
    const ovH = Math.round(ovW * (mapImg.naturalHeight / mapImg.naturalWidth));

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
      cameraNameBold   = false,
      cameraNameItalic = false,
      exifItalic       = false,
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
    const labelWeight = cameraNameBold ? '700' : '300';
    const camWeight   = cameraNameBold ? '700' : '500';
    const camStyle    = cameraNameItalic ? 'italic ' : '';
    const labelFont   = `${camStyle}${labelWeight} ${soSize}px ${stack}`;
    const camFont     = `${camStyle}${camWeight} ${soSize}px ${stack}`;
    const makerFont   = `${camStyle}400 ${soSize}px ${stack}`;
    const makerColor  = mixHexColor(primary, muted, 0.5);
    const exStyle    = exifItalic ? 'italic ' : '';
    const exifFont   = `${exStyle}300 ${exSize}px ${stack}`;

    // Determine if location goes below (needs 3-line layout)
    const hasLocationBelow = effectiveShowLocation && locationPosition === 'below-exif';
    // Y positions — when 3 lines, shift lines 1 & 2 up slightly to center the group
    const line1Y = hasLocationBelow ? centerY - gap * 0.85 : centerY - gap / 2;
    const line2Y = hasLocationBelow ? centerY              : centerY + gap / 2;
    const line3Y = centerY + gap * 0.85;

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
      const x0 = centerX - (lw + modelW + gapW + makeW) / 2;

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

        if (locationPosition === 'cam-right') {
          ctx.textAlign = 'right';
          ctx.fillText(exif.location, canvasW - sidePad, line1Y);
          const tw = ctx.measureText(exif.location).width;
          drawLocationPin(ctx, canvasW - sidePad - tw - pinSize * 1.1, line1Y, pinSize, muted, settings.locationIconStyle);
        } else {
          const pinCx = sidePad + pinSize * 0.6;
          drawLocationPin(ctx, pinCx, line1Y, pinSize, muted, settings.locationIconStyle);
          ctx.textAlign = 'left';
          ctx.fillText(exif.location, sidePad + pinSize * 1.5, line1Y);
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
      const coordinateScale = layout.canvasW ? ctx.canvas.width / layout.canvasW : 1;
      const sy = Math.max(0, Math.round(layout.imageBottom * coordinateScale));
      const sh = Math.max(1, Math.min(ctx.canvas.height - sy, Math.round(layout.bottomAreaHeight * coordinateScale)));
      sampleCtx.clearRect(0, 0, sample.width, sample.height);
      sampleCtx.drawImage(ctx.canvas, 0, sy, ctx.canvas.width, sh, 0, 0, sample.width, sample.height);
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

  function applyPostProcess(src, settings) {
    const { frameColor = '#F0F0F0' } = settings;
    const layout = computePostProcessLayout(src.width, src.height, settings);
    if (!layout.changed) return src;
    const { canvasW, canvasH, contentX, contentY } = layout;
    assertSafeCanvasSize(canvasW, canvasH);

    const out = document.createElement('canvas');
    out.width = canvasW; out.height = canvasH;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is unavailable');
    if (settings.frameBackground === 'blur') {
      drawBlurBackground(ctx, src, canvasW, canvasH, settings);
    } else {
      ctx.fillStyle = frameColor;
      ctx.fillRect(0, 0, canvasW, canvasH);
    }
    ctx.drawImage(src, contentX, contentY);
    return out;
  }

  function formatShutter(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return String(val);
    if (n >= 1) return `${n}s`;
    return `1/${Math.round(1 / n)}s`;
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

  function canvasToBlob(canvas, { format = 'jpeg', quality = 0.92, signal = null } = {}) {
    const mime = format === 'png'  ? 'image/png'
               : format === 'webp' ? 'image/webp'
               :                     'image/jpeg';
    // PNG is lossless — no quality arg
    assertNotAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', abort);
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
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        canvas.toBlob(async blob => {
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
        signal?.removeEventListener('abort', abort);
        img.onload = null;
        img.onerror = null;
        URL.revokeObjectURL(url);
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
        cleanup();
        reject(error);
      };
      const abort = () => {
        img.removeAttribute('src');
        fail(new DOMException('Image load cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      img.onload  = succeed;
      img.onerror = () => fail(new Error('Image load failed'));
      timeoutId = setTimeout(() => {
        img.removeAttribute('src');
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
      const url   = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted   = true;
      video.preload = 'metadata';
      let captured = false;
      let settled = false;
      let thumbnailCanvas = null;
      let thumbnailImage = null;
      let thumbnailUrl = null;
      let thumbnailLoaded = false;
      const timeout = setTimeout(() => fail(new Error('Video thumbnail timed out')), timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (thumbnailCanvas) {
          thumbnailCanvas.width = 0;
          thumbnailCanvas.height = 0;
          thumbnailCanvas = null;
        }
        if (thumbnailImage) {
          thumbnailImage.onload = null;
          thumbnailImage.onerror = null;
          if (!thumbnailLoaded) thumbnailImage.removeAttribute('src');
        }
        if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
        thumbnailUrl = null;
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.onerror = null;
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
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
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const t = Math.min(atSecond, Math.max(0, duration - 0.05));
        video.currentTime = t;
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
        c.toBlob(blob => {
          c.width = 0;
          c.height = 0;
          if (thumbnailCanvas === c) thumbnailCanvas = null;
          if (settled) return;
          if (!blob) { fail(new Error('Video thumbnail encoding failed')); return; }
          thumbnailUrl = URL.createObjectURL(blob);
          thumbnailImage = new Image();
          thumbnailImage.onload = () => {
            thumbnailLoaded = true;
            succeed(thumbnailImage);
          };
          thumbnailImage.onerror = () => fail(new Error('Video thumbnail load failed'));
          thumbnailImage.src = thumbnailUrl;
        }, 'image/jpeg', 0.88);
      };

      video.onerror = () => fail(new Error('Video load failed'));
      video.src  = url;
      video.load();
    });
  }

  /**
   * WebCodecs fast-path: VideoEncoder + WebMMuxer + requestVideoFrameCallback at 16× speed.
   * Falls back to _renderVideoMediaRecorder on any error.
   */
  async function _renderVideoWebCodecs(file, exif, settings, {
    onProgress,
    videoBitsPerSecond = 10_000_000,
    maxOutputBytes = MAX_ESTIMATED_VIDEO_BYTES,
    metadataTimeoutMs = VIDEO_METADATA_GUARD_MS,
    progressTimeoutMs = VIDEO_PROGRESS_GUARD_MS,
    signal,
  } = {}) {
    assertNotAborted(signal);
    await loadFrameFonts(settings, signal);
    assertNotAborted(signal);

    return new Promise((resolve, reject) => {
      const url   = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted   = true;
      video.preload = 'auto';
      let encoder = null;
      let canvas = null;
      let baseCanvas = null;
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
          video.cancelVideoFrameCallback(frameCallbackId);
        }
        frameCallbackId = null;
        if (metadataTimer != null) clearTimeout(metadataTimer);
        if (progressTimer != null) clearTimeout(progressTimer);
        metadataTimer = null;
        progressTimer = null;
        video.onloadedmetadata = null;
        video.onended = null;
        video.onerror = null;
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        if (encoder && encoder.state !== 'closed') {
          try { encoder.close(); } catch (_) {}
        }
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        if (baseCanvas) { baseCanvas.width = 0; baseCanvas.height = 0; }
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
          const layout = computeVideoFrameLayout(W, H, settings, exif);
          const { canvasW, canvasH } = layout;
          const duration = video.duration || 0;
          if (duration > 0 && duration * videoBitsPerSecond / 8 > maxOutputBytes) {
            throw resourceLimitError();
          }
          const fps        = 30;
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
            bitrate: videoBitsPerSecond,
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
              baseCanvas = drawVideoFrameSync(ctx, video, exif, settings, layout, baseCanvas);

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
      video.src  = url;
      video.load();
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

  async function renderVideoFrameWhenReady(file, exif, settings, {
    onProgress,
    preferredMime,
    videoBitsPerSecond = 10_000_000,
    preserveAudio = true,
    maxOutputBytes,
    metadataTimeoutMs,
    progressTimeoutMs,
    signal,
  } = {}) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const outputByteLimit = resolveVideoOutputLimit(maxOutputBytes);
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

    // ── MediaRecorder fallback (includes audio) ────────────────────────────────
    // Pre-load fonts (same as photo path)
    await loadFrameFonts(settings, signal);

    const sourceHasAudio = await _fileHasAudioTrackHint(file, signal);

    return new Promise((resolve, reject) => {
      const url   = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted   = true;   // must be muted for autoplay; source audio is captured separately
      video.preload = 'auto';
      let audioContext = null;
      let outputStream = null;
      let sourceStream = null;
      let canvas = null;
      let baseCanvas = null;
      let recorder = null;
      let rafId = null;
      let stopTimer = null;
      let metadataTimer = null;
      let progressTimer = null;
      let settled = false;
      let cleaned = false;

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        video.onloadedmetadata = null;
        video.onended = null;
        video.onerror = null;
        if (rafId != null) cancelAnimationFrame(rafId);
        if (stopTimer != null) clearTimeout(stopTimer);
        if (metadataTimer != null) clearTimeout(metadataTimer);
        if (progressTimer != null) clearTimeout(progressTimer);
        metadataTimer = null;
        progressTimer = null;
        if (recorder && recorder.state !== 'inactive') {
          try { recorder.stop(); } catch (_) {}
        }
        if (recorder) {
          recorder.ondataavailable = null;
          recorder.onstop = null;
          recorder.onerror = null;
        }
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        if (outputStream) outputStream.getTracks().forEach(track => track.stop());
        if (sourceStream) sourceStream.getTracks().forEach(track => track.stop());
        if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {});
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        if (baseCanvas) { baseCanvas.width = 0; baseCanvas.height = 0; }
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
        const layout = computeVideoFrameLayout(W, H, settings, exif);
        const { canvasW, canvasH } = layout;
        const duration = video.duration || 0;
        try {
          if (duration > 0 && duration * videoBitsPerSecond / 8 > outputByteLimit) {
            throw resourceLimitError();
          }
        } catch (error) {
          fail(error);
          return;
        }

        canvas = document.createElement('canvas');
        canvas.width  = canvasW;
        canvas.height = canvasH;
        const ctx     = canvas.getContext('2d');
        if (!ctx) { fail(new Error('Canvas rendering is unavailable')); return; }

        // ── Preserve the source audio without playing it on the page ──
        let audioTrack = null;
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

        // ── Build output stream: canvas video + original audio ──
        outputStream = canvas.captureStream(30);
        if (audioTrack) outputStream.addTrack(audioTrack);

        const candidates = preferredMime
          ? [preferredMime, 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
          : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        const mimeType = candidates.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
        if (!mimeType) { fail(new Error('Video export is not supported by this browser')); return; }

        recorder = new MediaRecorder(outputStream, {
          mimeType,
          videoBitsPerSecond,
        });
        const chunks = [];
        let recordedBytes = 0;
        let lastMediaTime = -1;
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
          fail(event.error || new Error('Video recording failed'));
        };
        video.onended = () => {
          stopRecorderAfterFlush();
        };

        function drawLoop() {
          try {
            rafId = null;
            assertNotAborted(signal);
            baseCanvas = drawVideoFrameSync(ctx, video, exif, settings, layout, baseCanvas);

            const mediaTime = Number(video.currentTime) || 0;
            if (mediaTime > lastMediaTime) {
              lastMediaTime = mediaTime;
              armProgressWatchdog();
            }

            if (onProgress && duration > 0) onProgress(Math.min(mediaTime / duration, 1));

            if (!video.ended && !video.paused) {
              rafId = requestAnimationFrame(drawLoop);
            } else {
              stopRecorderAfterFlush();
            }
          } catch (error) {
            fail(error);
          }
        }

          recorder.start(200);
          armProgressWatchdog();
          video.play()
            .then(() => {
              if (settled || signal?.aborted) return;
              rafId = requestAnimationFrame(drawLoop);
            })
            .catch(err => {
              if (recorder.state !== 'inactive') recorder.stop();
              fail(err);
            });
        } catch (error) {
          fail(error);
        }
      };

      video.onerror = () => fail(new Error('Video load failed'));
      metadataTimer = setTimeout(
        () => fail(mediaTimeoutError('metadata loading')),
        resolveGuardTimeout(metadataTimeoutMs, VIDEO_METADATA_GUARD_MS)
      );
      video.src  = url;
      video.load();
    });
  }

  /**
   * Compute the frame layout for a video given its pixel dimensions and current settings.
   * Returns the same shape used internally by _renderVideoWebCodecs / _renderVideoMediaRecorder.
   */
  function computeVideoFrameLayout(videoW, videoH, settings, exif = {}) {
    const W = videoW, H = videoH;
    const isPortrait    = H > W;
    const ts            = settings.thicknessScale || 1;
    const baseBorder    = Math.min(W, H) * 0.05 * 1.2 * ts;
    const sideBorder    = baseBorder * 0.5;
    const showLoc       = settings.showLocation && exif.location && settings.locationPosition === 'below-exif';
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
    assertSafeCanvasSize(baseCanvasW, baseCanvasH);
    const postProcess = computePostProcessLayout(baseCanvasW, baseCanvasH, settings);
    assertSafeCanvasSize(postProcess.canvasW, postProcess.canvasH);
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

  /**
   * Draw one video frame (with EXIF frame borders) synchronously onto ctx.
   * ctx must already be scaled so that 1 unit = 1 logical canvas pixel
   * (i.e. the caller handles DPR scaling before calling this).
   */
  function drawVideoBaseFrameSync(ctx, video, exif, settings, layout) {
    const {
      W, H, sB, baseCanvasW, baseCanvasH,
      imageTop, imageBottom, bB, isPortrait, frameColor,
    } = layout;

    if (settings.frameBackground === 'blur') {
      drawBlurBackground(ctx, video, baseCanvasW, baseCanvasH, settings);
    } else {
      ctx.fillStyle = frameColor;
      ctx.fillRect(0, 0, baseCanvasW, baseCanvasH);
    }
    drawImageAtY(ctx, video, sB, imageTop, W, H);
    drawInnerShadow(ctx, sB, imageTop, W, H);
    drawExifText(ctx, exif || {}, settings, {
      canvasW: baseCanvasW,
      canvasH: baseCanvasH,
      imageBottom,
      bottomAreaHeight: bB,
      isPortrait,
      frameColor,
    });
  }

  function drawVideoFrameSync(ctx, video, exif, settings, layout, reusableBaseCanvas = null, baseScale = 1) {
    if (!layout.hasPostProcess) {
      if (reusableBaseCanvas) {
        reusableBaseCanvas.width = 0;
        reusableBaseCanvas.height = 0;
      }
      drawVideoBaseFrameSync(ctx, video, exif, settings, layout);
      return null;
    }

    if (settings.frameBackground !== 'blur') {
      if (reusableBaseCanvas) {
        reusableBaseCanvas.width = 0;
        reusableBaseCanvas.height = 0;
      }
      ctx.fillStyle = layout.frameColor;
      ctx.fillRect(0, 0, layout.canvasW, layout.canvasH);
      ctx.save();
      ctx.translate(layout.frameX, layout.frameY);
      drawVideoBaseFrameSync(ctx, video, exif, settings, layout);
      ctx.restore();
      return null;
    }

    const baseCanvas = reusableBaseCanvas || document.createElement('canvas');
    const safeBaseScale = Math.max(0.01, Math.min(1, Number(baseScale) || 1));
    const scratchW = Math.max(1, Math.round(layout.baseCanvasW * safeBaseScale));
    const scratchH = Math.max(1, Math.round(layout.baseCanvasH * safeBaseScale));
    if (baseCanvas.width !== scratchW || baseCanvas.height !== scratchH) {
      baseCanvas.width = scratchW;
      baseCanvas.height = scratchH;
    }
    const baseContext = baseCanvas.getContext('2d');
    if (!baseContext) throw new Error('Canvas rendering is unavailable');
    baseContext.save();
    baseContext.scale(scratchW / layout.baseCanvasW, scratchH / layout.baseCanvasH);
    drawVideoBaseFrameSync(baseContext, video, exif, settings, layout);
    baseContext.restore();

    drawBlurBackground(ctx, baseCanvas, layout.canvasW, layout.canvasH, settings);
    ctx.drawImage(
      baseCanvas,
      0, 0, scratchW, scratchH,
      layout.frameX, layout.frameY, layout.baseCanvasW, layout.baseCanvasH
    );
    return baseCanvas;
  }

  return { renderFrame, renderFrameWhenReady, canvasToBlob, loadImage, captureVideoFrame, renderVideoFrameWhenReady, isColorDark, computeVideoFrameLayout, drawVideoFrameSync };
})();

if (typeof window !== 'undefined') window.FrameEngine = FrameEngine;
