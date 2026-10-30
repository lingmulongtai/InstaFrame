/**
 * boot.js — runs synchronously in <head>, before the first paint.
 *
 * The rest of the app is loaded at the end of <body>, so the browser can paint
 * the static HTML (English copy, default theme, empty canvases, every mobile
 * panel) before translations and saved preferences are applied. That produced
 * a visible jump on hard reloads. This script restores the saved theme so the
 * page background is already correct, and marks the document as booting so
 * CSS keeps the UI hidden until app.js has finished its first synchronous
 * setup pass. CSS also reveals the page on its own if app.js never runs.
 */
(function bootInstaFrame(root) {
  const THEMES = ['light', 'soft-white', 'blue-grey-dark', 'dark', 'system'];
  const LAYOUTS = ['left', 'right'];
  const EDITOR_SIZES = ['compact', 'comfortable', 'large'];

  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem('instaframe_prefs')) || {};
  } catch (_) {
    prefs = {};
  }

  root.classList.add('is-booting');
  root.setAttribute('data-theme', THEMES.includes(prefs.theme) ? prefs.theme : 'soft-white');
  root.setAttribute('data-layout', LAYOUTS.includes(prefs.layout) ? prefs.layout : 'left');
  root.setAttribute('data-editor-size', EDITOR_SIZES.includes(prefs.editorSize) ? prefs.editorSize : 'comfortable');

  const sidebarWidth = Number(prefs.sidebarWidth);
  if (Number.isFinite(sidebarWidth) && sidebarWidth >= 220 && sidebarWidth <= 480) {
    root.style.setProperty('--sidebar-w', `${Math.round(sidebarWidth)}px`);
  }
})(document.documentElement);
