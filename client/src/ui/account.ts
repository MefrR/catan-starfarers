import { PLAYER_COLORS, type PlayerColor } from "@starfarers/shared";
import { auth, isAuthConfigured, type Profile } from "../auth.js";

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const COLOR_HEX: Record<PlayerColor, string> = {
  yellow: "#ffd23f",
  red: "#ff5d5d",
  blue: "#4fa8ff",
  black: "#8a8fa6",
  green: "#52d273",
  white: "#e9eef7",
};
const COLOR_NAME: Record<PlayerColor, string> = {
  yellow: "Yellow",
  red: "Red",
  blue: "Blue",
  black: "Black",
  green: "Green",
  white: "White",
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const initials = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "C";

/**
 * The top-right account chip on the landing hero. Shows "Sign in" when signed
 * out, or the player's avatar + name when signed in (click → account page).
 * Renders nothing at all when Supabase isn't configured, so the game is
 * unchanged until accounts are set up.
 */
export function mountAccountChip(host: HTMLElement): void {
  if (!isAuthConfigured) return;
  const chip = el(`<div class="acct-chip"></div>`);
  host.appendChild(chip);

  const paint = (profile: Profile | null): void => {
    chip.replaceChildren();
    if (profile) {
      const btn = el(`
        <button class="acct-btn" title="Your account">
          <span class="acct-avatar" style="--ac:${COLOR_HEX[profile.favoriteColor]}">${escapeHtml(initials(profile.displayName))}</span>
          <span class="acct-name">${escapeHtml(profile.displayName)}</span>
        </button>`);
      btn.addEventListener("click", () => openAccountPage());
      chip.appendChild(btn);
    } else {
      const btn = el(`<button class="acct-btn signin"><span class="g-mark">G</span>Sign in</button>`);
      btn.addEventListener("click", () => void auth.signInWithGoogle());
      chip.appendChild(btn);
    }
  };
  // onChange fires once immediately, then on every sign-in / edit / sign-out.
  auth.onChange(paint);
}

/** The account page overlay: avatar, editable display name, favorite-color
 *  picker, and sign out. (Win/loss + history land here in Phase 2.) */
export function openAccountPage(): void {
  const profile = auth.currentProfile();
  if (!profile) return;

  let name = profile.displayName;
  let color: PlayerColor = profile.favoriteColor;
  let dirty = false;

  const overlay = el(`<div class="acct-overlay"></div>`);
  const card = el(`
    <div class="acct-card">
      <button class="acct-close" title="Close">✕</button>
      <div class="acct-head">
        <span class="acct-avatar big" style="--ac:${COLOR_HEX[color]}">${escapeHtml(initials(name))}</span>
        <div class="acct-head-meta">
          <div class="acct-card-title">Commander Profile</div>
          <div class="acct-card-sub">Your name and color follow you into every room.</div>
        </div>
      </div>

      <label class="acct-field">
        <span class="acct-label">Display name</span>
        <input class="acct-input" type="text" maxlength="24" value="${escapeHtml(name)}" />
      </label>

      <div class="acct-field">
        <span class="acct-label">Favorite color</span>
        <div class="acct-swatches"></div>
      </div>

      <div class="acct-actions">
        <button class="acct-save" disabled>Saved</button>
        <button class="acct-signout secondary">Sign out</button>
      </div>
      <div class="acct-stats-soon">📊 Win/loss record &amp; game history are coming soon.</div>
    </div>`);
  overlay.appendChild(card);

  const avatar = card.querySelector(".acct-avatar") as HTMLElement;
  const input = card.querySelector(".acct-input") as HTMLInputElement;
  const save = card.querySelector(".acct-save") as HTMLButtonElement;
  const swatches = card.querySelector(".acct-swatches") as HTMLElement;

  const markDirty = (): void => {
    dirty = name.trim() !== profile.displayName || color !== profile.favoriteColor;
    save.disabled = !dirty || name.trim().length === 0;
    save.textContent = dirty ? "Save changes" : "Saved";
  };

  for (const c of PLAYER_COLORS) {
    const sw = el(
      `<button class="acct-swatch ${c === color ? "selected" : ""}" title="${COLOR_NAME[c]}" style="--sw:${COLOR_HEX[c]}"></button>`,
    );
    sw.addEventListener("click", () => {
      color = c;
      swatches.querySelectorAll(".acct-swatch").forEach((s) => s.classList.remove("selected"));
      sw.classList.add("selected");
      avatar.style.setProperty("--ac", COLOR_HEX[c]);
      markDirty();
    });
    swatches.appendChild(sw);
  }

  input.addEventListener("input", () => {
    name = input.value;
    avatar.textContent = initials(name);
    markDirty();
  });

  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      await auth.updateProfile({ displayName: name.trim(), favoriteColor: color });
      profile.displayName = name.trim();
      profile.favoriteColor = color;
      save.textContent = "Saved";
    } catch {
      save.textContent = "Save failed — retry";
      save.disabled = false;
    }
  });

  const close = (): void => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 200);
  };
  card.querySelector(".acct-close")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  card.querySelector(".acct-signout")!.addEventListener("click", async () => {
    await auth.signOut();
    close();
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));
}
