/**
 * frame-engine.js — Canvas-based EXIF frame generator
 * Matches the visual style of calmtempo.com/soft/makeframe.html
 */

const FrameEngine = (() => {

  // Font stacks: maps family name → CSS font-family string with appropriate fallback
  const FONT_STACKS = {
    'Inter':              "'Inter', Arial, sans-serif",
    'Montserrat':         "'Montserrat', Arial, sans-serif",
    'DM Sans':            "'DM Sans', Arial, sans-serif",
    'Lato':               "'Lato', Arial, sans-serif",
    'Playfair Display':   "'Playfair Display', Georgia, serif",
    'Cormorant Garamond': "'Cormorant Garamond', Georgia, serif",
    'EB Garamond':        "'EB Garamond', Georgia, serif",
  };

  /**
   * Main entry point (sync).
   * @param {HTMLImageElement} img  - Loaded image element
   * @param {object} exif          - EXIF data fields
   * @param {object} settings      - Frame settings
   * @returns {HTMLCanvasElement}
   */
  function renderFrame(img, exif, settings) {
    const {
      frameColor = '#F0F0F0',
      thicknessScale = 1.0,
      shotOnFontScale = 1.0,
      exifFontScale = 1.0,
    } = settings;

    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const isPortrait = H > W;

    // --- Frame dimensions (matching reference site algorithm) ---
    const baseBorder = Math.min(W, H) * 0.05 * 1.2 * thicknessScale;
    const sideBorder  = baseBorder * 0.5;
    const topBorder   = sideBorder;
    const extraHeight = H * 0.10 * thicknessScale;
    const bottomBorder = sideBorder * 4 + extraHeight;

    // Portrait adjustment
    const portraitFactor = isPortrait ? 0.75 : 1.0;
    const sB = sideBorder * portraitFactor;
    const tB = topBorder  * portraitFactor;
    const bB = bottomBorder * portraitFactor;

    const canvasW = Math.round(W + sB * 2);
    const canvasH = Math.round(H + tB + bB);

    const canvas = document.createElement('canvas');
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');

    // --- Background (frame color) ---
    ctx.fillStyle = frameColor;
    ctx.fillRect(0, 0, canvasW, canvasH);

    // --- Draw original image ---
    ctx.drawImage(img, sB, tB, W, H);

    // --- Subtle inner shadow on image edges ---
    drawInnerShadow(ctx, sB, tB, W, H);

    // --- EXIF text in bottom area ---
    drawExifText(ctx, exif, settings, {
      canvasW, canvasH,
      imageBottom: tB + H,
      bottomAreaHeight: bB,
      isPortrait,
      frameColor,
    });

    return canvas;
  }

  /**
   * Async render: ensures the selected font is loaded, renders frame, applies post-processing.
   * This is the primary public render function.
   */
  async function renderFrameWhenReady(img, exif, settings) {
    const family = settings.fontFamily || 'Inter';
    // Ensure all weight/style variants we might use are loaded
    if (document.fonts) {
      const stack = FONT_STACKS[family] || `'${family}', sans-serif`;
      // Extract the quoted family name for document.fonts.load()
      const loadFamily = `'${family}'`;
      try {
        await Promise.all([
          document.fonts.load(`300 16px ${loadFamily}`),
          document.fonts.load(`500 16px ${loadFamily}`),
          document.fonts.load(`700 16px ${loadFamily}`),
          document.fonts.load(`italic 300 16px ${loadFamily}`),
          document.fonts.load(`italic 500 16px ${loadFamily}`),
          document.fonts.load(`italic 700 16px ${loadFamily}`),
        ]);
      } catch (e) { /* fall back gracefully */ }
    }
    const base = renderFrame(img, exif, settings);
    return applyPostProcess(base, settings);
  }

  function drawInnerShadow(ctx, x, y, w, h) {
    // Very subtle gradient shadow along the bottom edge of the image
    const grad = ctx.createLinearGradient(x, y + h - 4, x, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.04)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
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
      showDecoLine     = true,
      showExifInfo     = true,
    } = settings;

    // Determine text color based on frame color
    const isDarkFrame = isColorDark(frameColor);
    const primaryColor   = isDarkFrame ? '#E8E8E8' : '#000000';
    const secondaryColor = isDarkFrame ? '#AAAAAA' : '#969696';

    const centerX  = canvasW / 2;
    const fontStack = FONT_STACKS[fontFamily] || `'${fontFamily}', Arial, sans-serif`;

    // Font size relative to canvas width
    const baseFontSize = canvasW * 0.022;
    const shotOnSize   = Math.round(baseFontSize * 1.15 * shotOnFontScale);
    const exifSize     = Math.round(baseFontSize * 0.92 * exifFontScale);
    const lineGap      = shotOnSize * (isPortrait ? 1.4 : 1.7) * lineGapScale;

    // Vertical center of bottom area — offset by user setting
    const textCenterY = imageBottom + bottomAreaHeight * 0.50 + (textOffsetY * shotOnSize);

    // Build font strings
    const labelFont  = `300 ${shotOnSize}px ${fontStack}`;
    const cameraWeight = cameraNameBold ? '700' : '500';
    const cameraStyle  = cameraNameItalic ? 'italic ' : '';
    const cameraFont   = `${cameraStyle}${cameraWeight} ${shotOnSize}px ${fontStack}`;
    const exifStyle    = exifItalic ? 'italic ' : '';
    const exifFont     = `${exifStyle}300 ${exifSize}px ${fontStack}`;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';

    // --- Line 1: "Shot on" + Camera Make + Model ---
    const cameraName = [exif.make, exif.model].filter(Boolean).join(' ') || '';

    if (showShotOn && cameraName) {
      const shotOnLabel = 'Shot on';
      // Measure widths to center the composite
      ctx.font = labelFont;
      const labelW  = ctx.measureText(shotOnLabel + '  ').width;
      ctx.font = cameraFont;
      const cameraW = ctx.measureText(cameraName).width;
      const totalW  = labelW + cameraW;
      const startX  = centerX - totalW / 2;

      ctx.font      = labelFont;
      ctx.fillStyle = secondaryColor;
      ctx.fillText(shotOnLabel + '  ', startX, textCenterY - lineGap / 2);

      ctx.font      = cameraFont;
      ctx.fillStyle = primaryColor;
      ctx.fillText(cameraName, startX + labelW, textCenterY - lineGap / 2);
    }

    // --- Line 2: Lens info + exposure settings ---
    if (showExifInfo) {
      const parts = [];
      if (exif.lensModel)    parts.push(exif.lensModel);
      if (exif.focalLength)  parts.push(`${exif.focalLength}mm`);
      if (exif.fNumber)      parts.push(`f/${exif.fNumber}`);
      if (exif.exposureTime) parts.push(formatShutter(exif.exposureTime));
      if (exif.iso)          parts.push(`ISO\u2009${exif.iso}`);

      const exifLine = parts.join('  \u2003  ');

      if (exifLine) {
        ctx.font      = exifFont;
        ctx.fillStyle = secondaryColor;
        ctx.textAlign = 'center';
        ctx.fillText(exifLine, centerX, textCenterY + lineGap / 2);
      }
    }

    // --- Small decorative line between image and text ---
    if (showDecoLine) {
      ctx.strokeStyle = isDarkFrame ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(canvasW * 0.35, imageBottom + bottomAreaHeight * 0.22);
      ctx.lineTo(canvasW * 0.65, imageBottom + bottomAreaHeight * 0.22);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Post-process: apply aspect ratio letterboxing + outer padding.
   * Returns the source canvas unchanged if no transform is needed.
   */
  function applyPostProcess(sourceCanvas, settings) {
    const {
      frameColor    = '#F0F0F0',
      outerPadding  = 0,
      aspectRatio   = 'original',
    } = settings;

    let W = sourceCanvas.width;
    let H = sourceCanvas.height;

    // Step 1: Determine target dimensions from aspect ratio
    let targetW = W, targetH = H;
    if (aspectRatio && aspectRatio !== 'original') {
      const parts = aspectRatio.split(':').map(Number);
      const targetRatio  = parts[0] / parts[1];
      const sourceRatio  = W / H;
      if (targetRatio > sourceRatio) {
        // Need more width → pillarbox
        targetW = Math.round(H * targetRatio);
        targetH = H;
      } else if (targetRatio < sourceRatio) {
        // Need more height → letterbox
        targetW = W;
        targetH = Math.round(W / targetRatio);
      }
    }

    // Step 2: Add outer padding (% of the longer side)
    const paddingFrac = (outerPadding || 0) / 100;
    const padPx = Math.round(Math.max(targetW, targetH) * paddingFrac);
    const finalW = targetW + padPx * 2;
    const finalH = targetH + padPx * 2;

    // Short-circuit: nothing to do
    if (finalW === W && finalH === H) return sourceCanvas;

    const out = document.createElement('canvas');
    out.width  = finalW;
    out.height = finalH;
    const ctx = out.getContext('2d');

    ctx.fillStyle = frameColor;
    ctx.fillRect(0, 0, finalW, finalH);

    // Center the source canvas
    const offsetX = Math.round((finalW - W) / 2);
    const offsetY = Math.round((finalH - H) / 2);
    ctx.drawImage(sourceCanvas, offsetX, offsetY);

    return out;
  }

  function formatShutter(val) {
    if (!val) return '';
    const n = parseFloat(val);
    if (isNaN(n)) return String(val);
    if (n >= 1) return `${n}s`;
    const denom = Math.round(1 / n);
    return `1/${denom}s`;
  }

  function isColorDark(hex) {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum < 0.5;
  }

  /**
   * Convert canvas to Blob (async)
   */
  function canvasToBlob(canvas, quality = 0.95) {
    return new Promise(resolve => {
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality);
    });
  }

  /**
   * Load an HTMLImageElement from a File object
   */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });
  }

  return { renderFrame, renderFrameWhenReady, canvasToBlob, loadImage };
})();
