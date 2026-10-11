/**
 * HEIF/HEIC decoding off the main thread. The page sends the file bytes and the
 * item IDs to decode; the worker answers with RGBA pixels per item.
 */
/* global libheif */
let modulePromise = null;

function loadModule(scriptUrl, wasmUrl) {
  if (!modulePromise) {
    modulePromise = new Promise((resolve, reject) => {
      importScripts(scriptUrl);
      libheif({
        locateFile: () => wasmUrl,
        // Called with the module as `this`, possibly before libheif() returns.
        onRuntimeInitialized() { resolve(this); },
        onAbort: reason => reject(new Error(`HEIF decoder failed to start: ${reason}`)),
      });
    }).catch(error => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

function decodeItem(lib, context, itemId, maxPixels) {
  const handle = lib.heif_js_context_get_image_handle(context, itemId);
  if (!handle || handle.code) throw new Error(`HEIF item ${itemId} is not an image`);
  let image = null;
  try {
    const width = lib.heif_image_handle_get_width(handle);
    const height = lib.heif_image_handle_get_height(handle);
    if (width * height > maxPixels) {
      const error = new Error('HEIF image exceeds the safe pixel limit');
      error.code = 'MEDIA_RESOURCE_LIMIT';
      throw error;
    }
    image = lib.heif_js_decode_image2(
      handle, lib.heif_colorspace.heif_colorspace_RGB, lib.heif_chroma.heif_chroma_interleaved_RGBA
    );
    if (!image || image.code) throw new Error(`HEIF item ${itemId} could not be decoded`);
    const channel = image.channels && image.channels.find(
      candidate => candidate.id === lib.heif_channel.heif_channel_interleaved
    );
    if (!channel || !channel.data) throw new Error(`HEIF item ${itemId} has no RGBA data`);
    const rowBytes = channel.width * 4;
    const pixels = new Uint8Array(rowBytes * channel.height);
    for (let row = 0; row < channel.height; row += 1) {
      pixels.set(channel.data.subarray(row * channel.stride, row * channel.stride + rowBytes), row * rowBytes);
    }
    return { itemId, width: channel.width, height: channel.height, buffer: pixels.buffer };
  } finally {
    if (image) lib.heif_image_release(image.image);
    lib.heif_image_handle_release(handle);
  }
}

self.onmessage = async event => {
  const { requestId, scriptUrl, wasmUrl, bytes, itemIds, maxPixels } = event.data || {};
  try {
    const lib = await loadModule(scriptUrl, wasmUrl);
    const context = lib.heif_context_alloc();
    try {
      const status = lib.heif_context_read_from_memory(context, new Uint8Array(bytes));
      if (status.code !== lib.heif_error_code.heif_error_Ok) {
        throw new Error(`HEIF read failed: ${status.message || 'invalid file'}`);
      }
      const topLevel = Array.from(lib.heif_js_context_get_list_of_top_level_image_IDs(context) || []);
      const wanted = itemIds && itemIds.length ? itemIds : topLevel.slice(0, 1);
      const images = wanted.map(itemId => decodeItem(lib, context, itemId, maxPixels));
      self.postMessage({ requestId, ok: true, topLevel, images }, images.map(image => image.buffer));
    } finally {
      lib.heif_context_free(context);
    }
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      message: String((error && error.message) || error),
      code: (error && error.code) || null,
    });
  }
};
