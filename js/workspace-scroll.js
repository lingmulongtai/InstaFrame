(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  for (const panel of document.querySelectorAll('.sidebar-scroll, .customize-panel')) {
    let target = 0;
    let position = 0;
    let frame = 0;
    let lastTime = 0;

    function cancel() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
    }

    function animate(time) {
      const elapsed = lastTime ? Math.min(time - lastTime, 50) : 16;
      lastTime = time;
      const remaining = target - position;
      if (Math.abs(remaining) < 0.5) {
        panel.scrollTop = target;
        cancel();
        return;
      }
      position += remaining * (1 - Math.exp(-elapsed / 65));
      panel.scrollTop = position;
      frame = requestAnimationFrame(animate);
    }

    panel.addEventListener('wheel', event => {
      const mode = event.deltaMode;
      const y = event.deltaY;
      // Small and fractional pixel movements remain native. Common mouse wheel
      // notches are whole 100 or 120 pixel steps in Chromium and Windows browsers.
      const mouseStep = mode !== WheelEvent.DOM_DELTA_PIXEL ||
        (Number.isInteger(y) && Math.abs(y) >= 100 && (Math.abs(y) % 100 === 0 || Math.abs(y) % 120 === 0));
      if (!mouseStep || reducedMotion.matches || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey ||
          Math.abs(event.deltaX) > Math.abs(y)) {
        cancel();
        return;
      }
      const nestedScroller = event.composedPath().some(node => node instanceof HTMLElement && node !== panel &&
        panel.contains(node) && node.scrollHeight > node.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY));
      if (nestedScroller) {
        cancel();
        return;
      }
      const distance = mode === WheelEvent.DOM_DELTA_LINE ? y * 16 :
        mode === WheelEvent.DOM_DELTA_PAGE ? y * panel.clientHeight : y;
      const limit = Math.max(0, panel.scrollHeight - panel.clientHeight);
      const next = Math.min(limit, Math.max(0, (frame ? target : panel.scrollTop) + distance));
      if (next === panel.scrollTop && !frame) return;
      event.preventDefault();
      target = next;
      if (!frame) {
        position = panel.scrollTop;
        frame = requestAnimationFrame(animate);
      }
    }, { passive: false });

    for (const type of ['pointerdown', 'touchstart', 'keydown']) {
      panel.addEventListener(type, cancel, { passive: true });
    }
    reducedMotion.addEventListener('change', cancel);
  }
})();
