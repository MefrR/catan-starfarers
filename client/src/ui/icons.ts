// Standalone inline-SVG art (resource cards + alien civ avatars) mirroring the
// in-game HUD glyphs, so the How-to-Play handbook shows the exact same icons.
import type { Resource } from "@starfarers/shared";

/**
 * Full-colour inline SVG resource glyph mirroring the board art (sci-fi set):
 *   ore    = a molten asteroid with glowing magma fissures
 *   fuel   = an energy cell: capsule with a window of glowing propellant
 *   carbon = a graphene molecule lattice (fused hexagons + bright nodes)
 *   food   = a hydroponic sprout under a glass dome
 *   goods  = a sealed cargo case with gold straps and a glowing seal
 */
export function resourceGlyphSvg(r: Resource): string {
  const wrap = (inner: string): string =>
    `<svg viewBox="0 0 24 24" width="22" height="22" stroke-linejoin="round" stroke-linecap="round">${inner}</svg>`;
  switch (r) {
    case "carbon":
      return wrap(
        `<polygon points="12,4 15.1,5.8 15.1,9.4 12,11.2 8.9,9.4 8.9,5.8" fill="rgba(87,182,240,0.22)" stroke="#57b6f0" stroke-width="1.2"/>
         <polygon points="8.9,9.4 12,11.2 12,14.8 8.9,16.6 5.8,14.8 5.8,11.2" fill="rgba(47,127,214,0.18)" stroke="#3f97e4" stroke-width="1.2"/>
         <polygon points="15.1,9.4 18.2,11.2 18.2,14.8 15.1,16.6 12,14.8 12,11.2" fill="rgba(47,127,214,0.18)" stroke="#3f97e4" stroke-width="1.2"/>
         <circle cx="12" cy="11.2" r="1.5" fill="#dff4ff"/>
         <circle cx="8.9" cy="9.4" r="1.1" fill="#bfe9ff"/>
         <circle cx="15.1" cy="9.4" r="1.1" fill="#bfe9ff"/>
         <circle cx="12" cy="14.8" r="1.1" fill="#bfe9ff"/>
         <circle cx="12" cy="4" r="0.8" fill="#8fd2ff"/>
         <circle cx="5.8" cy="14.8" r="0.8" fill="#8fd2ff"/>
         <circle cx="18.2" cy="14.8" r="0.8" fill="#8fd2ff"/>`,
      );
    case "fuel":
      return wrap(
        `<rect x="10.9" y="2.2" width="2.2" height="1.8" fill="#a06c14" stroke="#0a0f1e" stroke-width="0.5"/>
         <rect x="9.2" y="3.8" width="5.6" height="2.6" rx="1" fill="#f6c659" stroke="#0a0f1e" stroke-width="0.7"/>
         <rect x="7.8" y="6.2" width="8.4" height="13.2" rx="2.6" fill="#b97e1f" stroke="#0a0f1e" stroke-width="0.8"/>
         <rect x="9.5" y="8" width="5" height="9.6" rx="1.8" fill="#241806" stroke="#0a0f1e" stroke-width="0.5"/>
         <rect x="9.5" y="11.8" width="5" height="5.8" rx="1.8" fill="#ffc34d"/>
         <circle cx="11" cy="13.6" r="0.6" fill="#ffe7ab"/>
         <circle cx="13" cy="15.6" r="0.5" fill="#ffe7ab"/>
         <path d="M12.7 8.7 L10.9 11.6 H12.2 L11.3 14 L13.8 10.7 H12.4 Z" fill="#ffe7ab"/>`,
      );
    case "food":
      return wrap(
        `<path d="M4.8 14 a7.2 7.2 0 0 1 14.4 0" fill="rgba(143,214,111,0.12)" stroke="#8fd66f" stroke-width="0.9" opacity="0.85"/>
         <path d="M12 16.2 C12 13.4 12 11 12 8.4" stroke="#3f8f30" stroke-width="1.6" fill="none"/>
         <path d="M12 12.4 C9.2 12 7.4 10 7.6 7.4 C10.4 7.8 11.9 9.8 12 12.4 Z" fill="#57c244" stroke="#0a0f1e" stroke-width="0.5"/>
         <path d="M12 10 C14.8 9.6 16.5 7.7 16.4 5.2 C13.6 5.6 12.1 7.5 12 10 Z" fill="#7ad862" stroke="#0a0f1e" stroke-width="0.5"/>
         <ellipse cx="12" cy="16.2" rx="5.2" ry="1.2" fill="#5a3d22" stroke="#0a0f1e" stroke-width="0.5"/>
         <path d="M6.8 16.4 H17.2 L16 20 A2.1 2.1 0 0 1 14 21.4 H10 A2.1 2.1 0 0 1 8 20 Z" fill="#2f7325" stroke="#0a0f1e" stroke-width="0.7"/>`,
      );
    case "ore":
      return wrap(
        `<polygon points="4,13 7,5.6 14,4 20.4,9.6 18.6,17.6 9,19.6" fill="#a32a28" stroke="#0a0f1e" stroke-width="0.8"/>
         <polygon points="7,5.6 14,4 12.6,9.2 8.2,10" fill="#d6504c" opacity="0.9"/>
         <polygon points="9,19.6 18.6,17.6 17.2,13.4 10.4,14.6" fill="#6e1a19" opacity="0.8"/>
         <path d="M6.6 12.6 L10.2 11.2 L12.6 13.6 L16.2 12 L18 14.2" stroke="#ffb054" stroke-width="1.3" fill="none"/>
         <path d="M10.2 11.2 L9.6 15.6" stroke="#ff7d3e" stroke-width="1" fill="none"/>
         <circle cx="16.2" cy="12" r="0.9" fill="#ffd28a"/>
         <circle cx="6.6" cy="12.6" r="0.7" fill="#ffd28a" opacity="0.8"/>`,
      );
    case "goods":
      return wrap(
        `<path d="M9.5 7 V5.6 A2.5 2.1 0 0 1 14.5 5.6 V7" stroke="#e3b341" stroke-width="1.5" fill="none"/>
         <rect x="4.4" y="7" width="15.2" height="11.6" rx="2" fill="#7b4fc4" stroke="#0a0f1e" stroke-width="0.8"/>
         <rect x="4.4" y="7" width="15.2" height="3.2" rx="2" fill="#9a73e0" opacity="0.85"/>
         <rect x="7.4" y="7" width="2" height="11.6" fill="#e3b341" stroke="#0a0f1e" stroke-width="0.4"/>
         <rect x="14.6" y="7" width="2" height="11.6" fill="#e3b341" stroke="#0a0f1e" stroke-width="0.4"/>
         <circle cx="12" cy="13" r="2.6" fill="rgba(255,217,106,0.25)"/>
         <polygon points="12,10.8 14,13 12,15.2 10,13" fill="#ffd96a" stroke="#0a0f1e" stroke-width="0.5"/>`,
      );
  }
}

/** Round alien-civilization avatar (Green Folk / Scientists / Merchants /
 *  Diplomats / Travelers), matching the friendship & encounter card art. */
export function civAvatarSvg(civ: string): string {
  const frame = (bg: string, inner: string): string =>
    `<svg viewBox="0 0 40 40" width="34" height="34" style="display:block">
      <circle cx="20" cy="20" r="19" fill="${bg}" stroke="#0a0f1e" stroke-width="1.5"/>
      ${inner}
    </svg>`;
  switch (civ) {
    case "scientists":
      return frame(
        "#1a2238",
        `<ellipse cx="20" cy="23" rx="11" ry="12" fill="#c9925e" stroke="#0a0f1e" stroke-width="1"/>
         <ellipse cx="20" cy="27" rx="6" ry="4.6" fill="#e3b98a"/>
         <circle cx="16" cy="21" r="1.7" fill="#0a0f1e"/><circle cx="24" cy="21" r="1.7" fill="#0a0f1e"/>
         <circle cx="19" cy="27" r="0.8" fill="#7a5532"/><circle cx="21" cy="27" r="0.8" fill="#7a5532"/>
         <path d="M9 17 Q20 1 31 17 Z" fill="#d23a33" stroke="#0a0f1e" stroke-width="1"/>
         <rect x="9" y="15.5" width="22" height="3" rx="1" fill="#f2f2f2" stroke="#0a0f1e" stroke-width="0.6"/>`,
      );
    case "greenFolk":
      return frame(
        "#11261a",
        `<path d="M10 15 L3 9 L12 14 Z" fill="#3f8f30" stroke="#0a0f1e" stroke-width="0.6"/>
         <path d="M30 15 L37 9 L28 14 Z" fill="#3f8f30" stroke="#0a0f1e" stroke-width="0.6"/>
         <ellipse cx="20" cy="21" rx="11" ry="12" fill="#4ca63a" stroke="#0a0f1e" stroke-width="1"/>
         <ellipse cx="20" cy="28" rx="5.6" ry="4" fill="#6fc456"/>
         <circle cx="15.5" cy="19" r="2.6" fill="#ffd23f" stroke="#0a0f1e" stroke-width="0.8"/><circle cx="15.5" cy="19" r="1" fill="#0a0f1e"/>
         <circle cx="24.5" cy="19" r="2.6" fill="#ffd23f" stroke="#0a0f1e" stroke-width="0.8"/><circle cx="24.5" cy="19" r="1" fill="#0a0f1e"/>
         <circle cx="18.4" cy="28" r="0.8" fill="#0a0f1e"/><circle cx="21.6" cy="28" r="0.8" fill="#0a0f1e"/>`,
      );
    case "diplomats":
      return frame(
        "#0e1c33",
        `<path d="M5 37 Q20 29 35 37 L35 40 L5 40 Z" fill="#cfd8e8" stroke="#0a0f1e" stroke-width="1"/>
         <ellipse cx="20" cy="19" rx="10.5" ry="11.5" fill="#4f7fd0" stroke="#0a0f1e" stroke-width="1"/>
         <path d="M20 8 Q24 4 21 1" stroke="#0a0f1e" stroke-width="1.2" fill="none"/>
         <ellipse cx="22" cy="24" rx="5" ry="3.4" fill="#6f9ce0"/>
         <circle cx="16" cy="17" r="2.1" fill="#fff" stroke="#0a0f1e" stroke-width="0.7"/><circle cx="16.4" cy="17" r="0.9" fill="#0a0f1e"/>
         <circle cx="24" cy="17" r="2.1" fill="#fff" stroke="#0a0f1e" stroke-width="0.7"/><circle cx="24.4" cy="17" r="0.9" fill="#0a0f1e"/>
         <circle cx="20" cy="30" r="1.4" fill="#ffd23f" stroke="#0a0f1e" stroke-width="0.6"/>`,
      );
    case "merchants":
      return frame(
        "#2a2114",
        `<polygon points="7,19 3,10 12,15" fill="#caa46a" stroke="#0a0f1e" stroke-width="0.7"/>
         <polygon points="33,19 37,10 28,15" fill="#caa46a" stroke="#0a0f1e" stroke-width="0.7"/>
         <ellipse cx="20" cy="21" rx="10" ry="12" fill="#d8b483" stroke="#0a0f1e" stroke-width="1"/>
         <path d="M20 20 L17.6 28 L22.4 28 Z" fill="#c49a63"/>
         <circle cx="15.5" cy="19" r="1.6" fill="#0a0f1e"/><circle cx="24.5" cy="19" r="1.6" fill="#0a0f1e"/>
         <path d="M16 31 Q20 33 24 31" stroke="#0a0f1e" stroke-width="1" fill="none"/>`,
      );
    default:
      return frame(
        "#1c2236",
        `<circle cx="20" cy="20" r="11" fill="#8fa4c4" stroke="#0a0f1e" stroke-width="1"/>
         <path d="M11 19 A9 9 0 0 1 29 19 L29 23 L11 23 Z" fill="#cfe0f5" stroke="#0a0f1e" stroke-width="0.7"/>
         <circle cx="20" cy="13" r="2" fill="#ffd23f" stroke="#0a0f1e" stroke-width="0.6"/>`,
      );
  }
}
