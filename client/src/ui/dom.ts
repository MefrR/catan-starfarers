/**
 * Tiny shared DOM helpers, previously copy-pasted across the UI modules.
 *
 * Keeping a single `escapeHtml` is also a small security win: every place that
 * interpolates user-controlled text (names, chat) into an HTML string escapes it
 * the same, canonical way.
 */

/** Build a detached element from an HTML string (its first element node). */
export const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

/** Escape the five HTML-significant characters for safe interpolation. */
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
