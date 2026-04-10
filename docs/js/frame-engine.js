/**
 * frame-engine.js — Canvas-based EXIF frame generator
 */

const FrameEngine = (() => {

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
   * Core synchronous renderer — works at whatever resolution img was loaded at.
   */
  function renderFrame(img, exif, settings) {
    const {
      frameColor     = '#F0F0F0',
      thicknessScale = 1.0,
    } = settings;

    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const isPortrait = H > W;

    const baseBorder   = Math.min(W, H) * 0.05 * 1.2 * thicknessScale;
    const sideBorder   = baseBorder * 0.5;
    const extraHeight  = H * 0.10 * thicknessScale;
    const bottomBorder = sideBorder * 4 + extraHeight;
    const pf           = isPortrait ? 0.75 : 1.0;
    const sB = sideBorder   * pf;
    const tB = sideBorder   * pf;
    const bB = bottomBorder * pf;

    const canvasW = Math.round(W + sB * 2);
    const canvasH = Math.round(H + tB + bB);

    const canvas = document.createElement('canvas');
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = frameColor;
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.drawImage(img, sB, tB, W, H);
    drawInnerShadow(ctx, sB, tB, W, H);
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
   * Scale an HTMLImageElement down to maxPx on the longest side.
   * Returns the original img unchanged if it's already small enough.
   */
  async function scaleImage(img, maxPx) {
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (longest <= maxPx) return img;

    const scale = maxPx / longest;
    const w = Math.round(img.naturalWidth  * scale);
    const h = Math.round(img.naturalHeight * scale);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').drawImage(img, 0, 0, w, h);

    return new Promise((resolve, reject) => {
      const out = new Image();
      out.onload  = () => resolve(out);
      out.onerror = reject;
      out.src = tmp.toDataURL('image/jpeg', 0.9);
    });
  }

  /**
   * Load fonts needed for the current settings, then render.
   * Pass maxPreviewPx to scale the image down for fast live preview.
   */
  async function renderFrameWhenReady(img, exif, settings, { maxPreviewPx = null } = {}) {
    const family = settings.fontFamily || 'Inter';

    if (document.fonts) {
      const fam = `'${family}'`;
      const specs = [
        `300 16px ${fam}`, `400 16px ${fam}`, `500 16px ${fam}`, `700 16px ${fam}`,
        `italic 300 16px ${fam}`, `italic 400 16px ${fam}`, `italic 500 16px ${fam}`, `italic 700 16px ${fam}`,
      ];
      // load() resolves even for unavailable variants — safe to Promise.all
      await Promise.all(specs.map(s => document.fonts.load(s).catch(() => {})));
    }

    const renderImg = maxPreviewPx ? await scaleImage(img, maxPreviewPx) : img;
    const base = renderFrame(renderImg, exif, settings);
    return applyPostProcess(base, settings);
  }

  // ─── Drawing helpers ──────────────────────────────────────────────────────

  function drawInnerShadow(ctx, x, y, w, h) {
    const grad = ctx.createLinearGradient(x, y + h - 6, x, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.05)');
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
      cameraNameOnly   = false,   // hide EXIF line + deco, show only "Shot on"
    } = settings;

    const effectiveShowShotOn   = cameraNameOnly ? true  : showShotOn;
    const effectiveShowExifInfo = cameraNameOnly ? false : showExifInfo;
    const effectiveShowDecoLine = cameraNameOnly ? false : showDecoLine;

    const isDark  = isColorDark(frameColor);
    const primary = isDark ? '#E8E8E8' : '#111111';
    const muted   = isDark ? '#999999' : '#888888';

    const stack  = FONT_STACKS[fontFamily] || `'${fontFamily}', Arial, sans-serif`;
    const baseFs = canvasW * 0.022;
    const soSize = Math.round(baseFs * 1.15 * shotOnFontScale);
    const exSize = Math.round(baseFs * 0.92 * exifFontScale);
    const gap    = soSize * (isPortrait ? 1.4 : 1.7) * lineGapScale;

    const centerY = imageBottom + bottomAreaHeight * 0.50 + textOffsetY * soSize;
    const centerX = canvasW / 2;

    // Build font strings — CSS shorthand: [style] [weight] [size] [family]
    const labelFont  = `300 ${soSize}px ${stack}`;
    const camWeight  = cameraNameBold ? '700' : '500';
    const camStyle   = cameraNameItalic ? 'italic ' : '';
    const camFont    = `${camStyle}${camWeight} ${soSize}px ${stack}`;
    const exStyle    = exifItalic ? 'italic ' : '';
    const exifFont   = `${exStyle}300 ${exSize}px ${stack}`;

    ctx.save();
    ctx.textBaseline = 'middle';

    // Line 1: Shot on + Camera
    if (effectiveShowShotOn) {
      const cam = [exif.make, exif.model].filter(Boolean).join(' ');
      if (cam) {
        const label = 'Shot on';
        ctx.font = labelFont;
        const lw = ctx.measureText(label + '  ').width;
        ctx.font = camFont;
        const cw = ctx.measureText(cam).width;
        const x0 = centerX - (lw + cw) / 2;

        ctx.textAlign = 'left';
        ctx.font      = labelFont;
        ctx.fillStyle = muted;
        ctx.fillText(label + '  ', x0, centerY - gap / 2);

        ctx.font      = camFont;
        ctx.fillStyle = primary;
        ctx.fillText(cam, x0 + lw, centerY - gap / 2);
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
        ctx.fillText(line, centerX, centerY + gap / 2);
      }
    }

    // Decorative separator line
    if (effectiveShowDecoLine) {
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(canvasW * 0.35, imageBottom + bottomAreaHeight * 0.22);
      ctx.lineTo(canvasW * 0.65, imageBottom + bottomAreaHeight * 0.22);
      ctx.stroke();
    }

    ctx.restore();
  }

  function applyPostProcess(src, settings) {
    const { frameColor = '#F0F0F0', outerPadding = 0, aspectRatio = 'original' } = settings;
    let W = src.width, H = src.height;

    let tW = W, tH = H;
    if (aspectRatio && aspectRatio !== 'original') {
      const [aw, ah] = aspectRatio.split(':').map(Number);
      const tr = aw / ah, sr = W / H;
      if (tr > sr) { tW = Math.round(H * tr); tH = H; }
      else if (tr < sr) { tW = W; tH = Math.round(W / tr); }
    }

    const pad = Math.round(Math.max(tW, tH) * (outerPadding || 0) / 100);
    const fW = tW + pad * 2, fH = tH + pad * 2;
    if (fW === W && fH === H) return src;

    const out = document.createElement('canvas');
    out.width = fW; out.height = fH;
    const ctx = out.getContext('2d');
    ctx.fillStyle = frameColor;
    ctx.fillRect(0, 0, fW, fH);
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

  function canvasToBlob(canvas, quality = 0.95) {
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality));
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });
  }

  // ─── Video helpers ────────────────────────────────────────────────────────

  /**
   * Capture a single frame from a video file as an HTMLImageElement.
   * @param {File}   file      - video file
   * @param {number} [atSecond=0] - timestamp to seek to
   */
  function captureVideoFrame(file, atSecond = 0) {
    return new Promise((resolve, reject) => {
      const url   = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted   = true;
      video.preload = 'metadata';
      let captured  = false;

      video.onloadedmetadata = () => {
        const t = Math.min(atSecond, Math.max(0, video.duration - 0.05));
        video.currentTime = t;
      };

      video.onseeked = () => {
        if (captured) return;
        captured = true;
        const c = document.createElement('canvas');
        c.width  = video.videoWidth  || 1280;
        c.height = video.videoHeight || 720;
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        video.src = '';
        URL.revokeObjectURL(url);
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = reject;
        img.src = c.toDataURL('image/jpeg', 0.92);
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
  async function renderVideoFrameWhenReady(file, exif, settings, { onProgress } = {}) {
    // Pre-load fonts (same as photo path)
    const family = settings.fontFamily || 'Inter';
    if (document.fonts) {
      const fam   = `'${family}'`;
      const specs = ['300', '400', '500', '700'].flatMap(w => [
        `${w} 16px ${fam}`, `italic ${w} 16px ${fam}`,
      ]);
      await Promise.all(specs.map(s => document.fonts.load(s).catch(() => {})));
    }

    return new Promise((resolve, reject) => {
      const url   = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted   = true;   // must be muted for autoplay; audio routed via AudioContext
      video.preload = 'auto';

      video.onloadedmetadata = () => {
        const W = video.videoWidth;
        const H = video.videoHeight;
        if (!W || !H) { URL.revokeObjectURL(url); reject(new Error('Invalid video dimensions')); return; }

        const isPortrait  = H > W;
        const ts          = settings.thicknessScale || 1;
        const baseBorder  = Math.min(W, H) * 0.05 * 1.2 * ts;
        const sideBorder  = baseBorder * 0.5;
        const bottomBorder= sideBorder * 4 + H * 0.10 * ts;
        const pf          = isPortrait ? 0.75 : 1.0;
        const sB = sideBorder    * pf;
        const tB = sideBorder    * pf;
        const bB = bottomBorder  * pf;

        const canvasW = Math.round(W + sB * 2);
        const canvasH = Math.round(H + tB + bB);

        const canvas = document.createElement('canvas');
        canvas.width  = canvasW;
        canvas.height = canvasH;
        const ctx     = canvas.getContext('2d');

        const layout = {
          canvasW, canvasH,
          imageBottom: tB + H,
          bottomAreaHeight: bB,
          isPortrait,
          frameColor: settings.frameColor || '#F0F0F0',
        };
        const frameColor = settings.frameColor || '#F0F0F0';
        const duration   = video.duration || 0;

        // ── Route audio through AudioContext so it's captured but not played ──
        let audioTrack = null;
        try {
          const actx = new (window.AudioContext || window.webkitAudioContext)();
          const src  = actx.createMediaElementSource(video);
          const dest = actx.createMediaStreamDestination();
          src.connect(dest);   // route to MediaStream (recorded)
          // NOT connecting to actx.destination keeps page muted
          audioTrack = dest.stream.getAudioTracks()[0] || null;
        } catch (_) { /* no audio support or no audio track */ }

        // ── Build output stream: canvas video + original audio ──
        const outStream = canvas.captureStream(30);
        if (audioTrack) outStream.addTrack(audioTrack);

        const mimeType = [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
        ].find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

        const recorder = new MediaRecorder(outStream, {
          mimeType,
          videoBitsPerSecond: 12_000_000,
        });
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          URL.revokeObjectURL(url);
          resolve(new Blob(chunks, { type: mimeType }));
        };

        let rafId;
        function drawLoop() {
          ctx.fillStyle = frameColor;
          ctx.fillRect(0, 0, canvasW, canvasH);
          ctx.drawImage(video, sB, tB, W, H);
          drawInnerShadow(ctx, sB, tB, W, H);
          drawExifText(ctx, exif, settings, layout);

          if (onProgress && duration > 0) onProgress(Math.min(video.currentTime / duration, 1));

          if (!video.ended && !video.paused) {
            rafId = requestAnimationFrame(drawLoop);
          } else {
            cancelAnimationFrame(rafId);
            // Give recorder a moment to flush, then stop
            setTimeout(() => recorder.stop(), 120);
          }
        }

        recorder.start(200);
        video.play()
          .then(() => { rafId = requestAnimationFrame(drawLoop); })
          .catch(err => { recorder.stop(); URL.revokeObjectURL(url); reject(err); });
      };

      video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Video load failed')); };
      video.src  = url;
      video.load();
    });
  }

  return { renderFrame, renderFrameWhenReady, canvasToBlob, loadImage, captureVideoFrame, renderVideoFrameWhenReady };
})();
