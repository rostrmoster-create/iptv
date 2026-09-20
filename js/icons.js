// ── SVG icon set ─────────────────────────────────────────────────────────
// Single source of truth for inline SVG icons used across the site. Each
// entry is a complete <svg> string sized 1em-scalable via CSS (width/height
// from font-size). currentColor lets parents control the stroke/fill.
window.Icons = (() => {
  const wrap = (body, { size = 16, fill = false } = {}) =>
    '<svg class="icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" ' +
    (fill
      ? 'fill="currentColor" stroke="none"'
      : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"') +
    ' aria-hidden="true">' + body + '</svg>';

  const I = {
    search:   () => wrap('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    plus:     () => wrap('<path d="M12 5v14M5 12h14"/>'),
    stop:     () => wrap('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
    trash:    () => wrap('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
    close:    () => wrap('<path d="M6 6l12 12M18 6 6 18"/>'),
    play:     () => wrap('<path d="M7 5v14l12-7Z"/>', { fill: true }),
    download: () => wrap('<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>'),
    menu:     () => wrap('<path d="M4 6h16M4 12h16M4 18h16"/>'),
    chevron:  () => wrap('<path d="m9 6 6 6-6 6"/>'),

    // Platform glyphs — minimalist line-art, no logos.
    android:  () => wrap(
      '<path d="M7 12a5 5 0 0 1 10 0v6H7v-6Z"/>' +
      '<path d="M9 8 7.5 5.5"/><path d="m15 8 1.5-2.5"/>' +
      '<circle cx="10" cy="13.5" r=".5" fill="currentColor"/>' +
      '<circle cx="14" cy="13.5" r=".5" fill="currentColor"/>' +
      '<path d="M5 12v5M19 12v5M9 18v3M15 18v3"/>'
    ),
    tv:       () => wrap(
      '<rect x="3" y="5" width="18" height="12" rx="1.5"/>' +
      '<path d="M8 21h8M12 17v4"/>'
    ),
    apple:    () => wrap(
      '<path d="M16.5 13.5c0-2.4 1.95-3.5 2-3.55-1.1-1.6-2.8-1.8-3.4-1.85-1.45-.15-2.85.85-3.6.85-.75 0-1.9-.85-3.15-.8C6.7 8.2 5.1 9.15 4.25 10.65c-1.85 3.2-.5 7.95 1.3 10.55.9 1.25 1.95 2.65 3.35 2.6 1.35-.05 1.85-.85 3.5-.85s2.1.85 3.5.8c1.45-.05 2.35-1.3 3.25-2.55.7-.95 1.05-1.85 1.4-2.8-.05-.05-2.55-1-2.55-3.9Z"/>' +
      '<path d="M14.4 6.4c.65-.85 1.1-2 1-3.15-1 .05-2.2.7-2.85 1.5-.6.75-1.15 1.95-1 3.05 1.1.1 2.2-.55 2.85-1.4Z"/>',
      { fill: true }
    ),
    windows:  () => wrap(
      '<path d="M3 5.5 11 4v8H3V5.5Z"/>' +
      '<path d="M11 4l10-1.5V12H11V4Z"/>' +
      '<path d="M3 12h8v7.5L3 18.5V12Z"/>' +
      '<path d="M11 12h10v9.5L11 20v-8Z"/>',
      { fill: true }
    ),
  };
  return I;
})();

// Hydrate any static [data-icon="name"] placeholders on page load.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.getAttribute('data-icon');
    if (name && window.Icons[name]) el.innerHTML = window.Icons[name]();
  });
});
