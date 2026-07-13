/**
 * frame-engine.js — Canvas-based EXIF frame generator
 */

const FrameEngine = (() => {

  const MAX_CANVAS_DIMENSION = 16_384;
  const MAX_CANVAS_PIXELS = 64_000_000;
  const MAX_ESTIMATED_VIDEO_BYTES = 512 * 1024 * 1024;

  function resourceLimitError() {
    const error = new Error('Media exceeds safe in-browser resource limits');
    error.code = 'MEDIA_RESOURCE_LIMIT';
    return error;
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

  async function loadFrameFonts(settings) {
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
    await Promise.all([...specs].map(spec => document.fonts.load(spec).catch(() => {})));
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
    await loadFrameFonts(settings);
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
      const sample = document.createElement('canvas');
      sample.width = 8;
      sample.height = 4;
      const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
      const coordinateScale = layout.canvasW ? ctx.canvas.width / layout.canvasW : 1;
      const sy = Math.max(0, Math.round(layout.imageBottom * coordinateScale));
      const sh = Math.max(1, Math.min(ctx.canvas.height - sy, Math.round(layout.bottomAreaHeight * coordinateScale)));
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

  function applyPostProcess(src, settings) {
    const {
      frameColor = '#F0F0F0',
      outerPadding = 0,
      aspectRatio = 'original',
      aspectOrientation = 'auto',
    } = settings;
    let W = src.width, H = src.height;

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
    const fW = tW + pad * 2, fH = tH + pad * 2;
    if (fW === W && fH === H) return src;
    assertSafeCanvasSize(fW, fH);

    const out = document.createElement('canvas');
    out.width = fW; out.height = fH;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is unavailable');
    if (settings.frameBackground === 'blur') {
      drawBlurBackground(ctx, src, fW, fH, settings);
    } else {
      ctx.fillStyle = frameColor;
      ctx.fillRect(0, 0, fW, fH);
    }
    ctx.drawImage(src, Math.round((fW - W) / 2), Math.round((fH - H) / 2));
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

  function canvasToBlob(canvas, { format = 'jpeg', quality = 0.92 } = {}) {
    const mime = format === 'png'  ? 'image/png'
               : format === 'webp' ? 'image/webp'
               :                     'image/jpeg';
    // PNG is lossless — no quality arg
    return new Promise((resolve, reject) =>
      canvas.toBlob(async blob => {
        if (!blob) { reject(new Error('Image encoding failed')); return; }
        try {
          const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
          if (!hasImageSignature(bytes, format)) {
            reject(new Error(`Browser did not encode the requested ${mime} format`));
            return;
          }
          resolve(blob.type.toLowerCase() === mime ? blob : new Blob([blob], { type: mime }));
        } catch (error) {
          reject(error);
        }
      }, mime, format === 'png' ? undefined : quality)
    );
  }

  function loadImage(file, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      let settled = false;
      const cleanup = () => {
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
      img.src = url;
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
      const timeout = setTimeout(() => fail(new Error('Video thumbnail timed out')), timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
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
          if (!blob) { fail(new Error('Video thumbnail encoding failed')); return; }
          const thumbUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(thumbUrl); succeed(img); };
          img.onerror = () => { URL.revokeObjectURL(thumbUrl); fail(new Error('Video thumbnail load failed')); };
          img.src = thumbUrl;
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
  async function _renderVideoWebCodecs(file, exif, settings, { onProgress, videoBitsPerSecond = 10_000_000 } = {}) {
    // Font pre-load
    await loadFrameFonts(settings);

    return new Promise((resolve, reject) => {
      const url   = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted   = true;
      video.preload = 'auto';

      video.onloadedmetadata = () => {
        const W = video.videoWidth, H = video.videoHeight;
        if (!W || !H) { URL.revokeObjectURL(url); reject(new Error('Invalid video dimensions')); return; }

        const isPortrait    = H > W;
        const ts            = settings.thicknessScale || 1;
        const baseBorder    = Math.min(W, H) * 0.05 * 1.2 * ts;
        const sideBorder    = baseBorder * 0.5;
        const showLoc       = settings.showLocation && exif.location && settings.locationPosition === 'below-exif';
        const locationExtra = showLoc ? H * 0.038 * ts : 0;
        const bottomBorder  = sideBorder * 4 + H * 0.10 * ts + locationExtra;
        const pf  = isPortrait ? 0.75 : 1.0;
        const sB  = sideBorder   * pf;
        const tB  = sideBorder   * pf;
        const bB  = bottomBorder * pf;
        const imageLayout = computeImageVerticalLayout(H, tB, bB, settings.imageOffsetY);
        const canvasW = Math.round(W + sB * 2);
        const canvasH = imageLayout.canvasH;

        const layout = {
          canvasW, canvasH,
          imageBottom: imageLayout.imageBottom,
          bottomAreaHeight: bB,
          isPortrait,
          frameColor: settings.frameColor || '#F0F0F0',
        };
        const frameColor = settings.frameColor || '#F0F0F0';
        const duration   = video.duration || 0;
        const fps        = 30;
        const frameDurUs = Math.round(1_000_000 / fps);

        // Check WebMMuxer availability (loaded from CDN)
        const MuxerCls = (typeof WebMMuxer !== 'undefined' && WebMMuxer.Muxer)
          ? WebMMuxer.Muxer : (typeof Muxer !== 'undefined' ? Muxer : null);
        const TargetCls = (typeof WebMMuxer !== 'undefined' && WebMMuxer.ArrayBufferTarget)
          ? WebMMuxer.ArrayBufferTarget : (typeof ArrayBufferTarget !== 'undefined' ? ArrayBufferTarget : null);

        if (!MuxerCls || !TargetCls) {
          URL.revokeObjectURL(url);
          reject(new Error('WebMMuxer not available'));
          return;
        }

        const muxTarget = new TargetCls();
        const muxer = new MuxerCls({
          target: muxTarget,
          video: { codec: 'V_VP9', width: canvasW, height: canvasH, frameRate: fps },
          firstTimestampBehavior: 'permissive',
        });

        const encoder = new VideoEncoder({
          output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (_) {} },
          error: err => { URL.revokeObjectURL(url); reject(err); },
        });
        try {
          encoder.configure({ codec: 'vp09.00.10.08', width: canvasW, height: canvasH, bitrate: videoBitsPerSecond, latencyMode: 'quality' });
        } catch (cfgErr) {
          URL.revokeObjectURL(url);
          reject(cfgErr);
          return;
        }

        // Use regular Canvas (OffscreenCanvas not supported in all contexts with drawImage(video))
        const canvas = document.createElement('canvas');
        canvas.width  = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext('2d');

        let frameIndex = 0;
        let finalized  = false;

        async function finalize() {
          if (finalized) return;
          finalized = true;
          try {
            await encoder.flush();
            muxer.finalize();
            const { buffer } = muxTarget;
            URL.revokeObjectURL(url);
            if (onProgress) onProgress(1);
            resolve(new Blob([buffer], { type: 'video/webm' }));
          } catch (e) {
            URL.revokeObjectURL(url);
            reject(e);
          }
        }

        function onFrame(now, metadata) {
          if (finalized) return;
          const timestamp = Math.round((metadata.mediaTime || 0) * 1_000_000);

          if (settings.frameBackground === 'blur') {
            drawBlurBackground(ctx, video, canvasW, canvasH, settings);
          } else {
            ctx.fillStyle = frameColor;
            ctx.fillRect(0, 0, canvasW, canvasH);
          }
          drawImageAtY(ctx, video, sB, imageLayout.imageTop, W, H);
          drawInnerShadow(ctx, sB, imageLayout.imageTop, W, H);
          drawExifText(ctx, exif, settings, layout);

          try {
            const vf = new VideoFrame(canvas, { timestamp, duration: frameDurUs });
            encoder.encode(vf, { keyFrame: frameIndex % 60 === 0 });
            vf.close();
          } catch (_) { /* skip problematic frames */ }
          frameIndex++;

          if (onProgress && duration > 0) onProgress(Math.min((metadata.mediaTime || 0) / duration, 0.99));

          if (!video.ended && !video.paused) {
            video.requestVideoFrameCallback(onFrame);
          } else {
            finalize();
          }
        }

        video.addEventListener('ended', finalize, { once: true });
        video.playbackRate = 16;
        video.requestVideoFrameCallback(onFrame);
        video.play().catch(err => { URL.revokeObjectURL(url); reject(err); });
      };

      video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Video load failed')); };
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
  async function _fileHasAudioTrackHint(file) {
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
      const head = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
      const samples = [head];
      if (file.size > sampleSize) {
        samples.push(new Uint8Array(await file.slice(Math.max(0, file.size - sampleSize)).arrayBuffer()));
      }
      if (isWebM) return samples.some(bytes => contains(bytes, [0x83, 0x81, 0x02])); // EBML TrackType = audio
      if (isMp4) return samples.some(bytes => contains(bytes, [0x73, 0x6f, 0x75, 0x6e])); // MP4 handler "soun"
      return samples.some(bytes => contains(bytes, [0x61, 0x75, 0x64, 0x73])); // AVI stream "auds"
    } catch (_) {
      return null;
    }
  }

  async function renderVideoFrameWhenReady(file, exif, settings, {
    onProgress,
    preferredMime,
    videoBitsPerSecond = 10_000_000,
    preserveAudio = true,
    signal,
  } = {}) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    // The WebCodecs fast path currently muxes video only. Use it exclusively
    // when a caller explicitly opts out of preserving the source audio.
    const canUseWebCodecs = typeof VideoEncoder !== 'undefined'
      && typeof VideoFrame !== 'undefined'
      && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function'
      && (typeof WebMMuxer !== 'undefined' || typeof Muxer !== 'undefined');
    if (!preserveAudio && canUseWebCodecs) {
      try {
        return await _renderVideoWebCodecs(file, exif, settings, { onProgress, videoBitsPerSecond });
      } catch (_) {
        // Fall through to MediaRecorder path on any error
      }
    }

    // ── MediaRecorder fallback (includes audio) ────────────────────────────────
    // Pre-load fonts (same as photo path)
    await loadFrameFonts(settings);

    const sourceHasAudio = await _fileHasAudioTrackHint(file);

    return new Promise((resolve, reject) => {
      const url   = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted   = true;   // must be muted for autoplay; source audio is captured separately
      video.preload = 'auto';
      let audioContext = null;
      let outputStream = null;
      let sourceStream = null;
      let canvas = null;
      let recorder = null;
      let rafId = null;
      let stopTimer = null;
      let settled = false;
      let cleaned = false;

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (rafId != null) cancelAnimationFrame(rafId);
        if (stopTimer != null) clearTimeout(stopTimer);
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        if (outputStream) outputStream.getTracks().forEach(track => track.stop());
        if (sourceStream) sourceStream.getTracks().forEach(track => track.stop());
        if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {});
        if (canvas) { canvas.width = 0; canvas.height = 0; }
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

      video.onloadedmetadata = () => {
        try {
          const W = video.videoWidth;
          const H = video.videoHeight;
          if (!W || !H) { fail(new Error('Invalid video dimensions')); return; }

        const isPortrait      = H > W;
        const ts              = settings.thicknessScale || 1;
        const baseBorder      = Math.min(W, H) * 0.05 * 1.2 * ts;
        const sideBorder      = baseBorder * 0.5;
        const showLoc         = settings.showLocation && exif.location && settings.locationPosition === 'below-exif';
        const locationExtra   = showLoc ? H * 0.038 * ts : 0;
        const bottomBorder    = sideBorder * 4 + H * 0.10 * ts + locationExtra;
        const pf          = isPortrait ? 0.75 : 1.0;
        const sB = sideBorder    * pf;
        const tB = sideBorder    * pf;
        const bB = bottomBorder  * pf;
        const imageLayout = computeImageVerticalLayout(H, tB, bB, settings.imageOffsetY);

        const canvasW = Math.round(W + sB * 2);
        const canvasH = imageLayout.canvasH;
        const duration = video.duration || 0;
        try {
          assertSafeCanvasSize(canvasW, canvasH);
          if (duration > 0 && duration * videoBitsPerSecond / 8 > MAX_ESTIMATED_VIDEO_BYTES) {
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

        const layout = {
          canvasW, canvasH,
          imageBottom: imageLayout.imageBottom,
          bottomAreaHeight: bB,
          isPortrait,
          frameColor: settings.frameColor || '#F0F0F0',
        };
        const frameColor = settings.frameColor || '#F0F0F0';

        // ── Preserve the source audio without playing it on the page ──
        let audioTrack = null;
        let captureStreamAvailable = false;
        try {
          const capture = video.captureStream || video.mozCaptureStream;
          if (capture && sourceHasAudio !== false) {
            captureStreamAvailable = true;
            sourceStream = capture.call(video);
            audioTrack = sourceStream.getAudioTracks()[0] || null;
          }
        } catch (_) { /* captureStream is not implemented consistently */ }

        // Older browsers without HTMLMediaElement.captureStream use Web Audio.
        try {
          if (!audioTrack && !captureStreamAvailable && sourceHasAudio !== false) {
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
        recorder.ondataavailable = event => {
          if (event.data.size <= 0 || settled) return;
          recordedBytes += event.data.size;
          if (recordedBytes > MAX_ESTIMATED_VIDEO_BYTES) {
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
          settled = true;
          const blob = new Blob(chunks, { type: mimeType });
          cleanup();
          resolve(blob);
        };
        recorder.onerror = event => {
          fail(event.error || new Error('Video recording failed'));
        };

        function drawLoop() {
          if (settings.frameBackground === 'blur') {
            drawBlurBackground(ctx, video, canvasW, canvasH, settings);
          } else {
            ctx.fillStyle = frameColor;
            ctx.fillRect(0, 0, canvasW, canvasH);
          }
          drawImageAtY(ctx, video, sB, imageLayout.imageTop, W, H);
          drawInnerShadow(ctx, sB, imageLayout.imageTop, W, H);
          drawExifText(ctx, exif, settings, layout);

          if (onProgress && duration > 0) onProgress(Math.min(video.currentTime / duration, 1));

          if (!video.ended && !video.paused) {
            rafId = requestAnimationFrame(drawLoop);
          } else {
            cancelAnimationFrame(rafId);
            // Give recorder a moment to flush, then stop
            stopTimer = setTimeout(() => {
              if (recorder.state !== 'inactive') recorder.stop();
            }, 120);
          }
        }

          recorder.start(200);
          video.play()
            .then(() => { rafId = requestAnimationFrame(drawLoop); })
            .catch(err => {
              if (recorder.state !== 'inactive') recorder.stop();
              fail(err);
            });
        } catch (error) {
          fail(error);
        }
      };

      video.onerror = () => fail(new Error('Video load failed'));
      video.src  = url;
      video.load();
    });
  }

  /**
   * Compute the frame layout for a video given its pixel dimensions and current settings.
   * Returns the same shape used internally by _renderVideoWebCodecs / _renderVideoMediaRecorder.
   */
  function computeVideoFrameLayout(videoW, videoH, settings) {
    const W = videoW, H = videoH;
    const isPortrait    = H > W;
    const ts            = settings.thicknessScale || 1;
    const baseBorder    = Math.min(W, H) * 0.05 * 1.2 * ts;
    const sideBorder    = baseBorder * 0.5;
    const showLoc       = settings.showLocation && settings.locationPosition === 'below-exif';
    const locationExtra = showLoc ? H * 0.038 * ts : 0;
    const bottomBorder  = sideBorder * 4 + H * 0.10 * ts + locationExtra;
    const pf            = isPortrait ? 0.75 : 1.0;
    const sB            = sideBorder   * pf;
    const tB            = sideBorder   * pf;
    const bB            = bottomBorder * pf;
    const imageLayout   = computeImageVerticalLayout(H, tB, bB, settings.imageOffsetY);
    const canvasW       = Math.round(W + sB * 2);
    const canvasH       = imageLayout.canvasH;
    const frameColor    = settings.frameColor || '#F0F0F0';
    return {
      W, H, sB, tB, bB,
      canvasW, canvasH,
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
  function drawVideoFrameSync(ctx, video, exif, settings, layout) {
    const { W, H, sB, canvasW, canvasH, imageTop, imageBottom, bB, isPortrait, frameColor } = layout;

    if (settings.frameBackground === 'blur') {
      drawBlurBackground(ctx, video, canvasW, canvasH, settings);
    } else {
      ctx.fillStyle = frameColor;
      ctx.fillRect(0, 0, canvasW, canvasH);
    }
    drawImageAtY(ctx, video, sB, imageTop, W, H);
    drawInnerShadow(ctx, sB, imageTop, W, H);
    drawExifText(ctx, exif || {}, settings, {
      canvasW,
      canvasH,
      imageBottom,
      bottomAreaHeight: bB,
      isPortrait,
      frameColor,
    });
  }

  return { renderFrame, renderFrameWhenReady, canvasToBlob, loadImage, captureVideoFrame, renderVideoFrameWhenReady, isColorDark, computeVideoFrameLayout, drawVideoFrameSync };
})();

if (typeof window !== 'undefined') window.FrameEngine = FrameEngine;
