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
   * Core synchronous renderer — works at whatever resolution img was loaded at.
   */
  function renderFrame(img, exif, settings) {
    const {
      frameColor       = '#F0F0F0',
      thicknessScale   = 1.0,
      showLocation     = false,
      locationPosition = 'below-exif',
    } = settings;

    const W = img.naturalWidth;
    const H = img.naturalHeight;
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
      showLocation     = false,
      locationPosition = 'below-exif',
    } = settings;

    const effectiveShowShotOn   = cameraNameOnly ? true  : showShotOn;
    const effectiveShowExifInfo = cameraNameOnly ? false : showExifInfo;
    const effectiveShowDecoLine = cameraNameOnly ? false : showDecoLine;
    const effectiveShowLocation = showLocation && !!(exif.location);

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
    const labelWeight = cameraNameBold ? '700' : '300';
    const camWeight   = cameraNameBold ? '700' : '500';
    const camStyle    = cameraNameItalic ? 'italic ' : '';
    const labelFont   = `${camStyle}${labelWeight} ${soSize}px ${stack}`;
    const camFont    = `${camStyle}${camWeight} ${soSize}px ${stack}`;
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
        ctx.fillText(label + '  ', x0, line1Y);

        ctx.font      = camFont;
        ctx.fillStyle = primary;
        ctx.fillText(cam, x0 + lw, line1Y);

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
            drawLocationPin(ctx, canvasW - sidePad - tw - pinSize * 1.1, line1Y, pinSize, muted);
          } else {
            const pinCx = sidePad + pinSize * 0.6;
            drawLocationPin(ctx, pinCx, line1Y, pinSize, muted);
            ctx.textAlign = 'left';
            ctx.fillText(exif.location, sidePad + pinSize * 1.5, line1Y);
          }
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
      drawLocationPin(ctx, startX + pinSize * 0.6, line3Y, pinSize, muted);
      ctx.textAlign = 'left';
      ctx.fillText(exif.location, startX + pinSize * 1.5, line3Y);
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

  function drawLocationPin(ctx, cx, cy, size, color) {
    ctx.save();
    ctx.fillStyle = color;
    // Pin head (circle)
    ctx.beginPath();
    ctx.arc(cx, cy - size * 0.55, size * 0.44, 0, Math.PI * 2);
    ctx.fill();
    // Pin tail (triangle pointing down)
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.28, cy - size * 0.2);
    ctx.lineTo(cx + size * 0.28, cy - size * 0.2);
    ctx.lineTo(cx, cy + size * 0.5);
    ctx.closePath();
    ctx.fill();
    // Inner dot highlight
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy - size * 0.55, size * 0.17, 0, Math.PI * 2);
    ctx.fill();
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

  function canvasToBlob(canvas, { format = 'jpeg', quality = 0.92 } = {}) {
    const mime = format === 'png'  ? 'image/png'
               : format === 'webp' ? 'image/webp'
               :                     'image/jpeg';
    // PNG is lossless — no quality arg
    return new Promise(resolve =>
      canvas.toBlob(blob => resolve(blob), mime, format === 'png' ? undefined : quality)
    );
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
   * WebCodecs fast-path: VideoEncoder + WebMMuxer + requestVideoFrameCallback at 16× speed.
   * Falls back to _renderVideoMediaRecorder on any error.
   */
  async function _renderVideoWebCodecs(file, exif, settings, { onProgress, videoBitsPerSecond = 10_000_000 } = {}) {
    // Font pre-load
    const family = settings.fontFamily || 'Inter';
    if (document.fonts) {
      const fam   = `'${family}'`;
      const specs = ['300','400','500','700'].flatMap(w => [`${w} 16px ${fam}`, `italic ${w} 16px ${fam}`]);
      await Promise.all(specs.map(s => document.fonts.load(s).catch(() => {})));
    }

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
        const canvasW = Math.round(W + sB * 2);
        const canvasH = Math.round(H + tB + bB);

        const layout = {
          canvasW, canvasH,
          imageBottom: tB + H,
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

          ctx.fillStyle = frameColor;
          ctx.fillRect(0, 0, canvasW, canvasH);
          ctx.drawImage(video, sB, tB, W, H);
          drawInnerShadow(ctx, sB, tB, W, H);
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
  async function renderVideoFrameWhenReady(file, exif, settings, { onProgress, preferredMime, videoBitsPerSecond = 10_000_000 } = {}) {
    // Try WebCodecs fast path first (Chrome 94+, Firefox 130+)
    // Requires: VideoEncoder, VideoFrame, requestVideoFrameCallback, WebMMuxer CDN library
    const canUseWebCodecs = typeof VideoEncoder !== 'undefined'
      && typeof VideoFrame !== 'undefined'
      && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function'
      && (typeof WebMMuxer !== 'undefined' || typeof Muxer !== 'undefined');
    if (canUseWebCodecs) {
      try {
        return await _renderVideoWebCodecs(file, exif, settings, { onProgress, videoBitsPerSecond });
      } catch (_) {
        // Fall through to MediaRecorder path on any error
      }
    }

    // ── MediaRecorder fallback (includes audio) ────────────────────────────────
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

        const candidates = preferredMime
          ? [preferredMime, 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
          : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        const mimeType = candidates.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || 'video/webm';

        const recorder = new MediaRecorder(outStream, {
          mimeType,
          videoBitsPerSecond,
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

  return { renderFrame, renderFrameWhenReady, canvasToBlob, loadImage, captureVideoFrame, renderVideoFrameWhenReady, isColorDark };
})();
