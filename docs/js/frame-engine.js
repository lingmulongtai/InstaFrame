/**
 * frame-engine.js — Canvas-based EXIF frame generator
 * Matches the visual style of calmtempo.com/soft/makeframe.html
 */

const FrameEngine = (() => {

  /**
   * Main entry point.
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
    drawInnerShadow(ctx, sB, tB, W, H, frameColor);

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

  function drawInnerShadow(ctx, x, y, w, h, frameColor) {
    // Very subtle gradient shadow along the bottom edge of the image
    const grad = ctx.createLinearGradient(x, y + h - 4, x, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.04)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
  }

  function drawExifText(ctx, exif, settings, layout) {
    const { canvasW, canvasH, imageBottom, bottomAreaHeight, isPortrait, frameColor } = layout;
    const { shotOnFontScale = 1.0, exifFontScale = 1.0 } = settings;

    // Determine text color based on frame color
    const isDarkFrame = isColorDark(frameColor);
    const primaryColor   = isDarkFrame ? '#E8E8E8' : '#000000';
    const secondaryColor = isDarkFrame ? '#AAAAAA' : '#969696';
    const labelColor     = isDarkFrame ? '#888888' : '#BBBBBB';

    const centerX = canvasW / 2;

    // Font size relative to canvas width
    const baseFontSize = canvasW * 0.022;
    const shotOnSize   = Math.round(baseFontSize * 1.15 * shotOnFontScale);
    const exifSize     = Math.round(baseFontSize * 0.92 * exifFontScale);
    const lineGap      = shotOnSize * (isPortrait ? 1.6 : 2.0);

    // Vertical center of bottom area
    const textCenterY = imageBottom + bottomAreaHeight * 0.45;

    // --- Line 1: "Shot on" + Camera Make + Model ---
    const shotOnLabel = currentLang === 'ja' ? 'Shot on' : 'Shot on';
    const cameraName  = [exif.make, exif.model].filter(Boolean).join(' ') || '';

    ctx.save();

    if (cameraName) {
      // Measure widths to center the composite
      ctx.font = `300 ${shotOnSize}px Arial, sans-serif`;
      const labelW = ctx.measureText(shotOnLabel + '  ').width;
      ctx.font = `500 ${shotOnSize}px Arial, sans-serif`;
      const cameraW = ctx.measureText(cameraName).width;
      const totalW = labelW + cameraW;
      const startX = centerX - totalW / 2;

      ctx.font = `300 ${shotOnSize}px Arial, sans-serif`;
      ctx.fillStyle = secondaryColor;
      ctx.fillText(shotOnLabel + '  ', startX, textCenterY - lineGap / 2);

      ctx.font = `500 ${shotOnSize}px Arial, sans-serif`;
      ctx.fillStyle = primaryColor;
      ctx.fillText(cameraName, startX + labelW, textCenterY - lineGap / 2);
    }

    // --- Line 2: Lens info + exposure settings ---
    const parts = [];
    if (exif.lensModel)    parts.push(exif.lensModel);
    if (exif.focalLength)  parts.push(`${exif.focalLength}mm`);
    if (exif.fNumber)      parts.push(`f/${exif.fNumber}`);
    if (exif.exposureTime) parts.push(formatShutter(exif.exposureTime));
    if (exif.iso)          parts.push(`ISO\u2009${exif.iso}`);

    const exifLine = parts.join('  \u2003  ');

    if (exifLine) {
      ctx.font = `300 ${exifSize}px Arial, sans-serif`;
      ctx.fillStyle = secondaryColor;
      ctx.textAlign = 'center';
      ctx.fillText(exifLine, centerX, textCenterY + lineGap / 2);
    }

    // --- Small decorative line between image and text ---
    if (!isDarkFrame) {
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    }
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(canvasW * 0.35, imageBottom + bottomAreaHeight * 0.18);
    ctx.lineTo(canvasW * 0.65, imageBottom + bottomAreaHeight * 0.18);
    ctx.stroke();

    ctx.restore();
  }

  function formatShutter(val) {
    if (!val) return '';
    const n = parseFloat(val);
    if (isNaN(n)) return String(val);
    if (n >= 1) return `${n}s`;
    // Express as fraction
    const denom = Math.round(1 / n);
    return `1/${denom}s`;
  }

  function isColorDark(hex) {
    // Parse hex color and check luminance
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

  return { renderFrame, canvasToBlob, loadImage };
})();
