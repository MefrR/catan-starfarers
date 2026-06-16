/**
 * Small DOM effects shared by the menu screens.
 *
 * shatter(): formerly burst the clicked button into glowing shards. That
 * explosion was removed by request — it now just runs `after` immediately, so
 * the button acts at once with no effect. Kept as a thin shim so the call
 * sites don't have to change (and the colour arg is now ignored).
 */
export function shatter(_btn: HTMLElement, _color: string, after?: () => void): void {
  after?.();
}

/**
 * Full-screen warp flash used when a game mounts: a burst of light + zooming
 * streak lines covering the swap from menu to board, then fading away. The
 * caller mounts the game inside `during` (fired while the screen is covered).
 */
export function warpTransition(during: () => void): void {
  const overlay = document.createElement("div");
  overlay.className = "warp-overlay";
  overlay.innerHTML = `<div class="warp-core"></div>${Array.from({ length: 14 }, (_, i) => {
    const ang = (360 / 14) * i + Math.random() * 14;
    const len = 24 + Math.random() * 22;
    const delay = Math.random() * 0.12;
    return `<i class="warp-ray" style="--a:${ang}deg;--l:${len}vh;animation-delay:${delay}s"></i>`;
  }).join("")}`;
  document.body.appendChild(overlay);
  // Mount the game while the flash covers the screen…
  window.setTimeout(during, 230);
  // …then let the light fade off the freshly-mounted board.
  window.setTimeout(() => overlay.classList.add("out"), 420);
  window.setTimeout(() => overlay.remove(), 1050);
}
