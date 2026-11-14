'use strict';
/**
 * Иконки интерфейса — инлайновые SVG (без эмодзи).
 * Цвет берётся из currentColor, поэтому иконки следуют теме.
 */
const ICONS = {
  /* навигация и общие */
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  plusSquare: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M12 8.5v7M8.5 12h7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  folder: '<path d="M3.5 7.2a2 2 0 0 1 2-2h3.1l1.7 2h6.2a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z"/>',
  folderOpen: '<path d="M3.5 8V6.2a2 2 0 0 1 2-2h3.1l1.7 2h6.2a2 2 0 0 1 2 2V10"/><path d="M2.8 10h17.4l-1.6 7.2a1.6 1.6 0 0 1-1.6 1.3H6a1.6 1.6 0 0 1-1.6-1.3Z"/>',
  file: '<path d="M6.5 3.5h6l5 5v12h-11z"/><path d="M12.5 3.5v5h5"/>',
  fileCode: '<path d="M6.5 3.5h6l5 5v12h-11z"/><path d="M12.5 3.5v5h5"/><path d="M10 12.5 8 15l2 2.5M14 12.5l2 2.5-2 2.5"/>',
  fileCog: '<path d="M6.5 3.5h6l5 5v12h-11z"/><path d="M12.5 3.5v5h5"/><circle cx="12" cy="14.6" r="1.5"/><path d="M12 11.6v1.1M12 16.5v1.1M15 14.6h-1.1M10.1 14.6H9"/>',
  fileArchive: '<rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="M12 3.5v4M10.5 7.5h3M10.5 10h3M10.5 12.5h3M11 15h2v2.5h-2z"/>',
  chevronRight: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  chevronDown: '<path d="M5.5 9.5 12 16l6.5-6.5"/>',
  chevronLeft: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  play: '<path d="M8 5.5 18.5 12 8 18.5Z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/>',
  power: '<path d="M12 4v7"/><path d="M7.5 7.2a7 7 0 1 0 9 0"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V10h-5.4"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V7.5A1.5 1.5 0 0 1 5.5 6H10"/>',
  vscode: '<path d="M16.5 3.5 9 10.8 5.4 8 4 8.7v6.6L5.4 16 9 13.2l7.5 7.3L20 18.6V5.4Z"/><path d="M4 8.7 9 12l-5 3.3"/>',
  book: '<path d="M4.5 4.5h6a3 3 0 0 1 3 3v12a2.4 2.4 0 0 0-2.4-2.4H4.5z"/><path d="M19.5 4.5h-3a3 3 0 0 0-3 3v12a2.4 2.4 0 0 1 2.4-2.4h3.6z"/>',
  save: '<path d="M5 4.5h10.5L19.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M7.5 4.5v5h8v-5"/><rect x="7.5" y="13" width="9" height="7.5" rx="1"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  dotFill: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  warn: '<path d="M12 4.5 21 20H3Z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  trash: '<path d="M4.5 6.5h15"/><path d="M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7"/><path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5"/>',
  pencil: '<path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L4.5 17.5Z"/><path d="M15 7l2 2"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.6" cy="9.6" r="1.6"/><path d="M4 17.5 9.5 12l3.5 3.5L16 13l4 4.5"/>',
  crop: '<path d="M7 3v12.5a1.5 1.5 0 0 0 1.5 1.5H21"/><path d="M3 7h12.5A1.5 1.5 0 0 1 17 8.5V21"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V10h-5.4"/><circle cx="12" cy="12" r="1.2"/>',
  sliders: '<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2.2"/><circle cx="9" cy="16.5" r="2.2"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 10l2.6 2.4L7 14.8M12.5 15h4.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  chart: '<path d="M4 19.5V13M9.3 19.5V6.5M14.7 19.5v-9M20 19.5V9"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.4"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 12.5h4"/>',
  cloud: '<path d="M7.5 18h9a3.8 3.8 0 0 0 .4-7.6A5.2 5.2 0 0 0 7 9.4 3.9 3.9 0 0 0 7.5 18Z"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6.4"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  check: '<path d="M5 12.5 10 17.5 19.5 7"/>',
  key: '<circle cx="8.5" cy="12" r="3.5"/><path d="M12 12h8.5M17.5 12v3M20 12v2.2"/>',
  users: '<circle cx="9" cy="9" r="3.2"/><path d="M3.6 19.5a5.4 5.4 0 0 1 10.8 0"/><path d="M16 6.4a3.2 3.2 0 0 1 0 5.2M17.6 14.4a5.4 5.4 0 0 1 2.8 4.6"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c2.2 2.2 3.4 5 3.4 8s-1.2 5.8-3.4 8c-2.2-2.2-3.4-5-3.4-8s1.2-5.8 3.4-8Z"/>',
};

/** Возвращает инлайн-SVG по имени. size — в пикселях, stroke — толщина. */
function ico(name, size = 14, stroke = 1.7) {
  const body = ICONS[name] || ICONS.file;
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" `
    + `aria-hidden="true">${body}</svg>`;
}
