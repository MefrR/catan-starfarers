/**
 * Small DOM effects shared by the menu screens.
 *
 * shatter(): the clicked button bursts into glowing shards + an expanding
 * ring (a vanilla-TS take on the ShatterButton reference), then `after`
 * runs once the explosion has registered (~260ms) so navigation feels
 * caused by the blast rather than racing it.
 */

export function shatter(btn: HTMLElement, color: string, after?: () => void, delay = 280): void {
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;

  // Shards: irregular glowing quads thrown outward with spin.
  const N = 22;
  for (let i = 0; i < N; i++) {
    const angle = (Math.PI * 2 * i) / N + Math.random() * 0.5;
    const velocity = 90 + Math.random() * 200;
    const size = 4 + Math.random() * 12;
    const shard = document.createElement("div");
    shard.style.cssText = `
      position: fixed; left: ${cx - size / 2}px; top: ${cy - size / 2}px;
      width: ${size}px; height: ${size}px; z-index: 400; pointer-events: none;
      background: ${color};
      box-shadow: 0 0 10px ${color}, 0 0 20px ${color};
      clip-path: polygon(${Math.random() * 50}% 0%, 100% ${Math.random() * 50}%, ${50 + Math.random() * 50}% 100%, 0% ${50 + Math.random() * 50}%);
    `;
    document.body.appendChild(shard);
    const anim = shard.animate(
      [
        { transform: "translate(0,0) rotate(0deg) scale(1)", opacity: 1 },
        {
          transform: `translate(${Math.cos(angle) * velocity}px, ${Math.sin(angle) * velocity}px) rotate(${Math.random() * 720 - 360}deg) scale(0.45)`,
          opacity: 0,
        },
      ],
      { duration: 800, easing: "cubic-bezier(0.25, 0.46, 0.45, 0.94)", fill: "forwards" },
    );
    anim.onfinish = () => shard.remove();
  }

  // Expanding explosion ring.
  const ring = document.createElement("div");
  ring.style.cssText = `
    position: fixed; left: ${cx}px; top: ${cy}px; z-index: 400; pointer-events: none;
    width: 0; height: 0; border-radius: 50%;
    border: 2px solid ${color};
    box-shadow: 0 0 30px ${color};
    transform: translate(-50%, -50%);
  `;
  document.body.appendChild(ring);
  const ringAnim = ring.animate(
    [
      { width: "0px", height: "0px", opacity: 1 },
      { width: "300px", height: "300px", opacity: 0 },
    ],
    { duration: 600, easing: "ease-out", fill: "forwards" },
  );
  ringAnim.onfinish = () => ring.remove();

  // The button itself implodes.
  btn.style.transition = "transform 0.15s ease, opacity 0.15s ease";
  btn.style.transform = "scale(0)";
  btn.style.opacity = "0";

  if (after) window.setTimeout(after, delay);
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
