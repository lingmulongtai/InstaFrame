const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

for (const [fixture, rotated, mime, codec, preferHardware] of [
  ['offline-60fps.mp4', false, 'video/mp4', 'avc', false],
  ['offline-60fps-rotated.mp4', true, 'video/mp4', 'avc', false],
  ['offline-60fps.mp4', false, 'video/webm;codecs=vp8,opus', 'vp8', false],
  ['offline-60fps.mp4', false, 'video/mp4', 'avc', true],
  ['offline-60fps-rotated.mp4', true, 'video/mp4', 'avc', true],
]) {
  test(`frame-by-frame export keeps 60 fps, audio timing and orientation: ${fixture} ${mime} hardware=${preferHardware}`, async ({ page }) => {
    await page.goto('/');
    const base64 = (await fs.readFile(path.join(__dirname, fixture))).toString('base64');
    const result = await page.evaluate(async ({ base64: content, rotated: isRotated, mime: outputMime, codec: outputCodec, preferHardware: hardware }) => {
      if (!window.VideoDecoder || !window.VideoEncoder || !window.VideoFrame) return { unsupported: true };
      const media = await import('./vendor/mediabunny.min.js');
      const bytes = Uint8Array.from(atob(content), character => character.charCodeAt(0));
      const file = new File([bytes], 'fixture.mp4', { type: 'video/mp4' });
      const original = new media.Input({ source: new media.BlobSource(file), formats: media.ALL_FORMATS });
      const video = await original.getPrimaryVideoTrack();
      const audio = await original.getPrimaryAudioTrack();
      const width = await video.getDisplayWidth();
      const height = await video.getDisplayHeight();
      const layout = window.FrameEngine.computeVideoFrameLayout(width, height, {}, {});
      if (!await video.canDecode() || !await media.canEncodeVideo(outputCodec, {
        width: Math.floor(layout.canvasW / 2) * 2, height: Math.floor(layout.canvasH / 2) * 2, bitrate: 4_000_000,
      }) || (outputCodec === 'vp8' && (!await audio.canDecode() || !await media.canEncodeAudio('opus')))) {
        original.dispose();
        return { unsupported: true };
      }
      let recorderCalls = 0;
      const NativeRecorder = window.MediaRecorder;
      window.MediaRecorder = class { constructor() { recorderCalls += 1; throw new Error('Unexpected realtime recording'); } };
      let output;
      let blob;
      try {
        blob = await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
          frameRate: 60, preferredMime: outputMime, videoBitsPerSecond: 4_000_000, preferHardware: hardware,
        });
        output = new media.Input({ source: new media.BlobSource(blob), formats: media.ALL_FORMATS });
      } finally { window.MediaRecorder = NativeRecorder; }
      try {
        const outVideo = await output.getPrimaryVideoTrack();
        const outAudio = await output.getPrimaryAudioTrack();
        const packets = async track => {
          const items = [];
          for await (const packet of new media.EncodedPacketSink(track).packets()) {
            items.push({ timestamp: packet.timestamp, duration: packet.duration });
          }
          return items;
        };
        const [inVideoPackets, outVideoPackets, inAudioPackets, outAudioPackets] = await Promise.all([
          packets(video), packets(outVideo), packets(audio), packets(outAudio),
        ]);
        const inputSample = await new media.VideoSampleSink(video).getSample(0.1);
        const outputSample = await new media.VideoSampleSink(outVideo).getSample(0.1);
        const inputCanvas = document.createElement('canvas');
        inputCanvas.width = width; inputCanvas.height = height;
        const inputContext = inputCanvas.getContext('2d');
        inputSample.draw(inputContext, 0, 0, width, height);
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = await outVideo.getDisplayWidth(); outputCanvas.height = await outVideo.getDisplayHeight();
        const outputContext = outputCanvas.getContext('2d');
        outputSample.draw(outputContext, 0, 0);
        const colors = [];
        for (const [x, y] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          const sourceColor = inputContext.getImageData(Math.floor(width * x), Math.floor(height * y), 1, 1).data;
          const outX = Math.floor((layout.frameX + layout.sB + width * x) * outputCanvas.width / layout.canvasW);
          const outY = Math.floor((layout.frameY + layout.imageTop + height * y) * outputCanvas.height / layout.canvasH);
          const outputColor = outputContext.getImageData(outX, outY, 1, 1).data;
          colors.push([...sourceColor.slice(0, 3)].map((value, i) => Math.abs(value - outputColor[i])));
        }
        inputSample.close(); outputSample.close();
        const pulseTime = async source => {
          const context = new AudioContext();
          try {
            const decoded = await context.decodeAudioData(await source.arrayBuffer());
            const samples = decoded.getChannelData(0);
            const index = samples.findIndex(value => Math.abs(value) > 0.1);
            return index / decoded.sampleRate;
          } finally { await context.close(); }
        };
        const flashTime = async (track, x, y) => {
          const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
          const context = canvas.getContext('2d');
          for await (const sample of new media.VideoSampleSink(track).samples()) {
            sample.draw(context, x, y, 1, 1, 0, 0, 1, 1);
            const color = context.getImageData(0, 0, 1, 1).data;
            const time = sample.timestamp;
            sample.close();
            if (color[0] > 220 && color[1] > 220 && color[2] > 220) return time;
          }
          return null;
        };
        const inputPulse = await pulseTime(file);
        const outputPulse = await pulseTime(blob);
        const inputFlash = await flashTime(video, Math.floor(width / 2), Math.floor(height / 2));
        const outputFlash = await flashTime(outVideo,
          Math.floor((layout.frameX + layout.sB + width / 2) * outputCanvas.width / layout.canvasW),
          Math.floor((layout.frameY + layout.imageTop + height / 2) * outputCanvas.height / layout.canvasH));
        return {
          recorderCalls, width, height, isRotated, colors,
          outWidth: outputCanvas.width, outHeight: outputCanvas.height,
          inputFrames: inVideoPackets.length, outputFrames: outVideoPackets.length,
          inputOffset: inAudioPackets[0].timestamp - inVideoPackets[0].timestamp,
          outputOffset: outAudioPackets[0].timestamp - outVideoPackets[0].timestamp,
          inputAudioEnd: inAudioPackets.at(-1).timestamp + inAudioPackets.at(-1).duration,
          outputAudioEnd: outAudioPackets.at(-1).timestamp + outAudioPackets.at(-1).duration,
          inputVideoEnd: inVideoPackets.at(-1).timestamp + inVideoPackets.at(-1).duration,
          outputVideoEnd: outVideoPackets.at(-1).timestamp + outVideoPackets.at(-1).duration,
          inputPulse, outputPulse, inputFlash, outputFlash,
        };
      } finally { output.dispose(); original.dispose(); }
    }, { base64, rotated, mime, codec, preferHardware });
    test.skip(result.unsupported, 'The browser cannot decode and encode this H.264 fixture with WebCodecs');
    expect(result.recorderCalls).toBe(0);
    expect(result.inputFrames).toBe(60);
    expect(result.outputFrames).toBe(60);
    expect(result.width < result.height).toBe(rotated);
    expect(result.outWidth < result.outHeight).toBe(rotated);
    for (const difference of result.colors.flat()) expect(difference).toBeLessThan(45);
    expect(Math.abs(result.outputOffset - result.inputOffset)).toBeLessThan(0.03);
    expect(Math.abs((result.outputAudioEnd - result.outputVideoEnd) - (result.inputAudioEnd - result.inputVideoEnd))).toBeLessThan(0.04);
    expect(result.inputFlash).not.toBeNull();
    expect(result.outputFlash).not.toBeNull();
    expect(Math.abs((result.outputPulse - result.outputFlash) - (result.inputPulse - result.inputFlash))).toBeLessThan(0.035);
  });
}

test('frame-by-frame setup can time out and be cancelled while metadata is stalled', async ({ page }) => {
  await page.route('**/vendor/mediabunny.min.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const ALL_FORMATS = [];
      export class BlobSource { constructor() {} }
      export class Input {
        getPrimaryVideoTrack() { return new Promise(() => {}); }
        dispose() { window.__offlineDisposed = (window.__offlineDisposed || 0) + 1; }
      }`,
  }));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    window.VideoDecoder ||= class {};
    window.VideoEncoder ||= class {};
    window.VideoFrame ||= class {};
    const file = new File([new Uint8Array([0])], 'stalled.mp4', { type: 'video/mp4' });
    const options = { preferredMime: 'video/mp4', frameRate: 60, metadataTimeoutMs: 50 };
    const outcome = async promise => {
      try { await promise; return 'resolved'; }
      catch (error) { return error.name === 'AbortError' ? error.name : (error.code || error.name); }
    };
    const timedOut = await outcome(window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, options));
    const controller = new AbortController();
    const cancelledPromise = outcome(window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, { ...options, metadataTimeoutMs: 1000, signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const cancelled = await cancelledPromise;
    return { timedOut, cancelled, disposed: window.__offlineDisposed };
  });
  expect(result).toEqual({ timedOut: 'MEDIA_TIMEOUT', cancelled: 'AbortError', disposed: 2 });
});

test('frame-by-frame encoding timeout cancels the conversion and releases its input', async ({ page }) => {
  await page.route('**/vendor/mediabunny.min.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const ALL_FORMATS = [];
      export class BlobSource { constructor() {} }
      export class Input {
        constructor() { this.video = { canDecode: async () => true, getDisplayWidth: async () => 160, getDisplayHeight: async () => 90 }; }
        async getPrimaryVideoTrack() { return this.video; }
        async getPrimaryAudioTrack() { return null; }
        async computeDuration() { return 1; }
        dispose() { window.__offlineDisposed = true; }
      }
      export async function canEncodeVideo() { return true; }
      export class Mp4OutputFormat {}
      export class StreamTarget {}
      export class Output {}
      export class Conversion {
        static async init({ input }) { return new Conversion(input); }
        constructor(input) { this.isValid = true; this.utilizedTracks = [input.video]; this.state = 'idle'; }
        execute() { this.state = 'executing'; return new Promise(() => {}); }
        async cancel() { this.state = 'canceled'; window.__offlineCancelled = true; }
      }`,
  }));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    window.VideoDecoder ||= class {};
    window.VideoEncoder ||= class {};
    window.VideoFrame ||= class {};
    const file = new File([new Uint8Array([0])], 'stalled.mp4', { type: 'video/mp4' });
    try {
      await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
        preferredMime: 'video/mp4', frameRate: 60, metadataTimeoutMs: 10000, progressTimeoutMs: 3000,
      });
      return { code: 'resolved' };
    } catch (error) {
      return { code: error.code, cancelled: window.__offlineCancelled, disposed: window.__offlineDisposed };
    }
  });
  expect(result).toEqual({ code: 'MEDIA_TIMEOUT', cancelled: true, disposed: true });
});

test('frame-by-frame output scales to encoder support and enforces its byte limit on header rewrites', async ({ page }) => {
  await page.route('**/vendor/mediabunny.min.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const ALL_FORMATS = [];
      export class BlobSource { constructor() {} }
      export class Input {
        constructor() { this.video = { canDecode: async () => true, getDisplayWidth: async () => 320, getDisplayHeight: async () => 180 }; }
        async getPrimaryVideoTrack() { return this.video; }
        async getPrimaryAudioTrack() { return null; }
        async computeDuration() { return 1; }
        dispose() {}
      }
      export async function canEncodeVideo(_codec, { width }) { return width <= 200; }
      export class Mp4OutputFormat {}
      export class StreamTarget { constructor(writable) { this.writable = writable; } }
      export class Output { constructor({ target }) { this.target = target; } }
      export class Conversion {
        static async init({ input, output }) { return new Conversion(input, output); }
        constructor(input, output) { this.output = output; this.isValid = true; this.utilizedTracks = [input.video]; this.state = 'idle'; }
        async execute() {
          this.state = 'executing';
          const writer = this.output.target.writable.getWriter();
          await writer.write({ position: 0, data: new Uint8Array([0, 0, 0, 0]) });
          await writer.write({ position: 1, data: new Uint8Array([9, 8]) });
          await writer.close();
          this.state = 'done';
        }
        async cancel() { this.state = 'canceled'; }
      }`,
  }));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    window.VideoDecoder ||= class {};
    window.VideoEncoder ||= class {};
    window.VideoFrame ||= class {};
    const file = new File([new Uint8Array([0])], 'fixture.mp4', { type: 'video/mp4' });
    let size;
    const options = {
      preferredMime: 'video/mp4', frameRate: 60, videoBitsPerSecond: 1,
      onAutoScale: (width, height) => { size = { width, height }; },
    };
    const blob = await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, { ...options, maxOutputBytes: 4 });
    let code;
    try { await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, { ...options, maxOutputBytes: 3 }); }
    catch (error) { code = error.code; }
    return { bytes: [...new Uint8Array(await blob.arrayBuffer())], size, code };
  });
  expect(result.bytes).toEqual([0, 9, 8, 0]);
  expect(result.size.width).toBeLessThanOrEqual(200);
  expect(result.size.width).toBeGreaterThan(180);
  expect(result.code).toBe('MEDIA_RESOURCE_LIMIT');
});

test('memory-priority encoding chooses a supported hardware size and retries without it on failure', async ({ page }) => {
  await page.route('**/vendor/mediabunny.min.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const ALL_FORMATS = [];
      export class BlobSource { constructor() {} }
      export class Input {
        constructor() { this.video = { canDecode: async () => true, getDisplayWidth: async () => 320, getDisplayHeight: async () => 180 }; }
        async getPrimaryVideoTrack() { return this.video; }
        async getPrimaryAudioTrack() { return null; }
        async computeDuration() { return 1; }
        dispose() {}
      }
      export async function canEncodeVideo(_codec, { width, hardwareAcceleration }) {
        return width <= (hardwareAcceleration === 'prefer-hardware' ? 200 : 400);
      }
      export class Mp4OutputFormat {}
      export class StreamTarget { constructor(writable) { this.writable = writable; } }
      export class Output { constructor({ target }) { this.target = target; } }
      export class Conversion {
        static async init({ input, output, video }) { return new Conversion(input, output, video); }
        constructor(input, output, video) { this.output = output; this.video = video; this.isValid = true; this.utilizedTracks = [input.video]; this.state = 'idle'; }
        async execute() {
          this.state = 'executing';
          window.__accelerationModes.push(this.video.hardwareAcceleration);
          if (window.__failHardware && this.video.hardwareAcceleration === 'prefer-hardware') {
            this.onProgress?.(0.5); throw new Error('Hardware encoder failed');
          }
          const writer = this.output.target.writable.getWriter();
          await writer.write({ position: 0, data: new Uint8Array([1, 2, 3]) });
          await writer.close(); this.state = 'done';
        }
        async cancel() { this.state = 'canceled'; }
      }`,
  }));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    window.VideoDecoder ||= class {};
    window.VideoEncoder ||= class {};
    window.VideoFrame ||= class {};
    const file = new File([new Uint8Array([0])], 'fixture.mp4', { type: 'video/mp4' });
    const run = async fail => {
      window.__failHardware = fail;
      window.__accelerationModes = [];
      const scales = [], progress = [];
      let fallbacks = 0;
      const blob = await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
        preferredMime: 'video/mp4', frameRate: 60, videoBitsPerSecond: 1, preferHardware: true,
        onAutoScale: (width, height) => scales.push({ width, height }),
        onMemoryFallback: () => { fallbacks += 1; }, onProgress: value => progress.push(value),
      });
      return { scales, progress, fallbacks, modes: window.__accelerationModes, size: blob.size };
    };
    return { hardware: await run(false), retry: await run(true) };
  });
  expect(result.hardware.modes).toEqual(['prefer-hardware']);
  expect(result.hardware.fallbacks).toBe(0);
  expect(result.hardware.scales).toHaveLength(1);
  expect(result.hardware.scales[0].width).toBeLessThanOrEqual(200);
  expect(result.hardware.scales[0].width).toBeGreaterThan(180);
  expect(result.retry.modes).toEqual(['prefer-hardware', 'no-preference']);
  expect(result.retry.fallbacks).toBe(1);
  expect(result.retry.scales).toEqual([]);
  expect(result.retry.progress).toEqual([0.5, 0, 1]);
  expect(result.retry.size).toBe(3);
});

test('realtime fallback refuses silent output when audio capture is unavailable', async ({ page }) => {
  await page.route('**/vendor/mediabunny.min.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export const ALL_FORMATS = [];
      export class BlobSource { constructor() {} }
      export class Input {
        async getPrimaryVideoTrack() { return { canDecode: async () => false }; }
        async getPrimaryAudioTrack() { return {}; }
        dispose() {}
      }`,
  }));
  await page.goto('/');
  const base64 = (await fs.readFile(path.join(__dirname, 'offline-60fps.mp4'))).toString('base64');
  const result = await page.evaluate(async content => {
    window.VideoDecoder ||= class {};
    window.VideoEncoder ||= class {};
    window.VideoFrame ||= class {};
    const bytes = Uint8Array.from(atob(content), character => character.charCodeAt(0));
    const file = new File([bytes], 'fixture.mp4', { type: 'video/mp4' });
    // A partial header scan cannot identify this audio track.
    file.slice = () => new Blob([new Uint8Array([0])]);
    HTMLMediaElement.prototype.captureStream = () => ({ getAudioTracks: () => [], getTracks: () => [] });
    window.AudioContext = class { constructor() { throw new Error('Audio capture unavailable'); } };
    let recorders = 0;
    window.MediaRecorder = class { constructor() { recorders += 1; throw new Error('Unexpected recorder'); } };
    let fallbacks = 0;
    try {
      await window.FrameEngine.renderVideoFrameWhenReady(file, {}, {}, {
        preferredMime: 'video/mp4', frameRate: 60, onRealtimeFallback: () => { fallbacks += 1; },
      });
      return { message: 'resolved', recorders, fallbacks };
    } catch (error) { return { message: error.message, recorders, fallbacks }; }
  }, base64);
  expect(result).toEqual({ message: 'The source audio could not be captured for video export', recorders: 0, fallbacks: 1 });
});

test('the completed item retains the realtime fallback and reduced-size notice', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await page.locator('#fileInput').setInputFiles(path.join(__dirname, 'offline-60fps.mp4'));
  await expect(page.locator('.image-card')).toHaveCount(1);
  await page.evaluate(() => {
    window.FrameEngine.renderVideoFrameWhenReady = async (_file, _exif, _settings, options) => {
      options.onAutoScale(320, 200);
      options.onRealtimeFallback();
      return new Blob([new Uint8Array([0])], { type: 'video/mp4' });
    };
    void window.generateAll();
  });
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/done/);
  await expect(page.locator('#status-badge-1')).toContainText('Done · reduced · real-time recording');
});

test('reduced video dimensions and memory fallback remain visible after export', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('instaframe_lang', 'en'));
  await page.reload();
  await page.locator('#fileInput').setInputFiles(path.join(__dirname, 'offline-60fps.mp4'));
  await expect.poll(() => page.locator('#livePreviewVideo').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.FrameEngine.renderVideoFrameWhenReady = async (_file, _exif, _settings, options) => {
      options.onMemoryFallback();
      options.onAutoScale(320, 200);
      options.onOutputSize(320, 200);
      return new Blob([new Uint8Array([0])], { type: 'video/mp4' });
    };
    void window.generateAll();
  });
  await expect(page.locator('#status-badge-1 .status-dot')).toHaveClass(/done/);
  await expect(page.locator('#status-badge-1')).toContainText('Done · reduced · standard processing');
  await expect(page.locator('#outputEstimate')).toContainText('320 × 200');
});
