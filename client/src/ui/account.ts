import { PLAYER_COLORS, type PlayerColor } from "@starfarers/shared";
import { auth, isAuthConfigured, type Profile } from "../auth.js";
import {
  fetchMyStats, fetchMyHistory, fetchUserStats, fetchUserHistory, fetchGamesWithFriend,
  type HistoryEntry,
} from "../social.js";
import {
  searchUsers, listFriends, listIncoming, listOutgoing,
  sendRequest, acceptRequest, removeFriendship, type FriendUser,
} from "../friends.js";
import { avatarSvgById, AVATAR_CHOICES } from "./icons.js";

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

/** The `.acct-avatar` markup for a user — their chosen photo (avatar icon) if
 *  set, otherwise their colored initials. `extraCls` adds size variants (sm/big). */
function avatarMarkup(
  extraCls: string,
  u: { avatar?: string | null; displayName: string; favoriteColor: PlayerColor },
): string {
  const photo = u.avatar ? avatarSvgById(u.avatar) : "";
  return `<span class="acct-avatar ${extraCls} ${photo ? "has-photo" : ""}" style="--ac:${COLOR_HEX[u.favoriteColor]}">${photo || escapeHtml(initials(u.displayName))}</span>`;
}

/** Validate a username: 3–20 chars, letters/numbers/underscore. */
const validUsername = (s: string): boolean => /^[a-zA-Z0-9_]{3,20}$/.test(s);

/**
 * The top-right account chip on the landing hero. "Sign in" when signed out, or
 * the player's avatar + name when signed in (click → account page). Renders
 * nothing when Supabase isn't configured.
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
          ${avatarMarkup("", profile)}
          <span class="acct-name">${escapeHtml(profile.displayName)}</span>
        </button>`);
      btn.addEventListener("click", () => openAccountPage());
      chip.appendChild(btn);
    } else {
      const btn = el(`<button class="acct-btn signin">Sign in</button>`);
      btn.addEventListener("click", () => openAuthPanel());
      chip.appendChild(btn);
    }
  };
  auth.onChange(paint);
  // A password-reset link returns here with a recovery session — prompt for a
  // new password as soon as that happens.
  auth.onPasswordRecovery(() => openSetPasswordPanel());
}

/** Sign-in / register overlay: email+password (with Log in / Register toggle
 *  and Forgot password), plus the Google option. */
export function openAuthPanel(): void {
  if (!isAuthConfigured) return;
  if (document.querySelector(".auth-overlay")) return;

  const overlay = el(`<div class="acct-overlay auth-overlay"></div>`);
  const card = el(`
    <div class="acct-card auth-card">
      <button class="acct-close" title="Close">✕</button>
      <div class="auth-head">
        <div class="acct-card-title">Welcome, Commander</div>
        <div class="acct-card-sub">Sign in or create an account to play online, add friends and save your record.</div>
      </div>
      <div class="acct-tabs auth-tabs">
        <button class="acct-tab active" data-mode="login">Log in</button>
        <button class="acct-tab" data-mode="register">Register</button>
      </div>
      <form class="auth-form" novalidate>
        <label class="acct-field reg-only" hidden>
          <span class="acct-label">Username <span class="auth-at">@yourname — unique, how friends find you</span></span>
          <input class="acct-input" id="auth-username" type="text" maxlength="20" autocomplete="username" placeholder="3–20 letters, numbers or _" />
          <span class="acct-hint" id="auth-uhint"></span>
        </label>
        <label class="acct-field">
          <span class="acct-label">Email</span>
          <input class="acct-input" id="auth-email" type="email" autocomplete="email" placeholder="you@example.com" />
        </label>
        <label class="acct-field">
          <span class="acct-label">Password</span>
          <input class="acct-input" id="auth-pass" type="password" autocomplete="current-password" placeholder="At least 6 characters" />
        </label>
        <div class="auth-msg" hidden></div>
        <button type="submit" class="acct-save auth-submit">Log in</button>
        <button type="button" class="auth-forgot link login-only">Forgot password?</button>
      </form>
      <div class="auth-or"><span>or</span></div>
      <button class="auth-google"><span class="g-mark">G</span>Continue with Google</button>
    </div>`);
  overlay.appendChild(card);

  const tabs = [...card.querySelectorAll<HTMLElement>(".acct-tab")];
  const form = card.querySelector(".auth-form") as HTMLFormElement;
  const nameField = card.querySelector(".reg-only") as HTMLElement;
  const userInput = card.querySelector("#auth-username") as HTMLInputElement;
  const uhint = card.querySelector("#auth-uhint") as HTMLElement;
  const emailInput = card.querySelector("#auth-email") as HTMLInputElement;
  const passInput = card.querySelector("#auth-pass") as HTMLInputElement;
  const submit = card.querySelector(".auth-submit") as HTMLButtonElement;
  const forgot = card.querySelector(".auth-forgot") as HTMLElement;
  const msg = card.querySelector(".auth-msg") as HTMLElement;
  let mode: "login" | "register" = "login";
  let checkSeq = 0; // latest username availability check wins

  const showMsg = (text: string, kind: "err" | "ok"): void => {
    msg.textContent = text;
    msg.className = `auth-msg ${kind}`;
    msg.hidden = false;
  };
  const clearMsg = (): void => { msg.hidden = true; msg.textContent = ""; };

  const setMode = (m: "login" | "register"): void => {
    mode = m;
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.mode === m));
    nameField.hidden = m !== "register";
    forgot.style.display = m === "login" ? "" : "none";
    submit.textContent = m === "login" ? "Log in" : "Create account";
    passInput.autocomplete = m === "login" ? "current-password" : "new-password";
    uhint.textContent = "";
    uhint.className = "acct-hint";
    clearMsg();
  };
  tabs.forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode as "login" | "register")));

  // Live username availability (register mode): format check, then a debounced
  // lookup, with the @handle reserved uniquely.
  userInput.addEventListener("input", () => {
    const handle = userInput.value.trim();
    if (!validUsername(handle)) {
      uhint.textContent = handle ? "3–20 letters, numbers or _" : "";
      uhint.className = "acct-hint bad";
      return;
    }
    uhint.textContent = "Checking…";
    uhint.className = "acct-hint";
    const seq = ++checkSeq;
    void auth.isUsernameAvailable(handle).then((free) => {
      if (seq !== checkSeq) return; // superseded by a newer keystroke
      uhint.textContent = free ? "✓ Available" : "✗ Taken — try another";
      uhint.className = `acct-hint ${free ? "good" : "bad"}`;
    });
  });

  // Close automatically once a session is established (covers email login and
  // confirmation-off sign-up). `stop` is also called on manual close so the
  // listener never leaks.
  let stop: () => void = () => {};
  const close = (): void => {
    stop();
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 200);
  };
  card.querySelector(".acct-close")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  stop = auth.onChange((profile) => { if (profile) close(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearMsg();
    const email = emailInput.value.trim();
    const pass = passInput.value;
    if (!email || !/.+@.+\..+/.test(email)) { showMsg("Please enter a valid email address.", "err"); return; }
    if (pass.length < 6) { showMsg("Password must be at least 6 characters.", "err"); return; }
    const handle = userInput.value.trim();
    if (mode === "register") {
      if (!validUsername(handle)) { showMsg("Pick a username: 3–20 letters, numbers or _.", "err"); return; }
      // Authoritative availability check at submit (the live one may be stale).
      submit.disabled = true; submit.textContent = "Checking…";
      const free = await auth.isUsernameAvailable(handle);
      if (!free) { submit.disabled = false; submit.textContent = "Create account"; showMsg("That username is already taken — choose another.", "err"); return; }
    }
    submit.disabled = true;
    submit.textContent = mode === "login" ? "Logging in…" : "Creating…";
    const res = mode === "login"
      ? await auth.signInWithEmail(email, pass)
      : await auth.signUpWithEmail(email, pass, handle);
    submit.disabled = false;
    submit.textContent = mode === "login" ? "Log in" : "Create account";
    if (!res.ok) { showMsg(res.error ?? "Something went wrong.", "err"); return; }
    if (res.pendingConfirm) {
      showMsg("Account created! Check your inbox to confirm your email, then log in.", "ok");
      setMode("login");
      return;
    }
    // Logged in — auth.onChange will close the panel.
  });

  forgot.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    if (!email || !/.+@.+\..+/.test(email)) { showMsg("Enter your email above first, then tap Forgot password.", "err"); return; }
    const res = await auth.sendPasswordReset(email);
    showMsg(res.ok ? "If that email has an account, a reset link is on its way." : (res.error ?? "Couldn't send the reset email."), res.ok ? "ok" : "err");
  });

  card.querySelector(".auth-google")!.addEventListener("click", () => void auth.signInWithGoogle());

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));
  setMode("login");
}

/** After a password-reset link, prompt the (recovery-session) user for a new
 *  password and save it. */
export function openSetPasswordPanel(): void {
  if (document.querySelector(".setpass-overlay")) return;
  const overlay = el(`<div class="acct-overlay setpass-overlay"></div>`);
  const card = el(`
    <div class="acct-card auth-card">
      <div class="auth-head">
        <div class="acct-card-title">Set a new password</div>
        <div class="acct-card-sub">Choose a new password for your account.</div>
      </div>
      <form class="auth-form" novalidate>
        <label class="acct-field">
          <span class="acct-label">New password</span>
          <input class="acct-input" id="np" type="password" autocomplete="new-password" placeholder="At least 6 characters" />
        </label>
        <div class="auth-msg" hidden></div>
        <button type="submit" class="acct-save">Save password</button>
      </form>
    </div>`);
  overlay.appendChild(card);
  const input = card.querySelector("#np") as HTMLInputElement;
  const msg = card.querySelector(".auth-msg") as HTMLElement;
  const btn = card.querySelector(".acct-save") as HTMLButtonElement;
  const form = card.querySelector(".auth-form") as HTMLFormElement;
  const close = (): void => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (input.value.length < 6) { msg.textContent = "Password must be at least 6 characters."; msg.className = "auth-msg err"; msg.hidden = false; return; }
    btn.disabled = true; btn.textContent = "Saving…";
    const res = await auth.updatePassword(input.value);
    if (!res.ok) { msg.textContent = res.error ?? "Couldn't update the password."; msg.className = "auth-msg err"; msg.hidden = false; btn.disabled = false; btn.textContent = "Save password"; return; }
    msg.textContent = "Password updated! You're all set."; msg.className = "auth-msg ok"; msg.hidden = false;
    setTimeout(close, 1200);
  });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));
}

/** The account page overlay: header + Profile / Record / History tabs. */
export function openAccountPage(): void {
  const profile = auth.currentProfile();
  if (!profile) return;

  const overlay = el(`<div class="acct-overlay"></div>`);
  const card = el(`
    <div class="acct-card wide">
      <button class="acct-close" title="Close">✕</button>
      <div class="acct-head">
        ${avatarMarkup("big editable", profile)}
        <div class="acct-head-meta">
          <div class="acct-card-title">${escapeHtml(profile.displayName)}</div>
          <div class="acct-handle">${profile.username ? "@" + escapeHtml(profile.username) : "Set a username to add friends"}</div>
        </div>
      </div>
      <div class="acct-tabs">
        <button class="acct-tab active" data-tab="record">Record</button>
        <button class="acct-tab" data-tab="history">History</button>
        <button class="acct-tab" data-tab="friends">Friends</button>
        <button class="acct-tab" data-tab="profile">Edit</button>
      </div>
      <div class="acct-body"></div>
    </div>`);
  overlay.appendChild(card);

  const body = card.querySelector(".acct-body") as HTMLElement;
  const tabs = [...card.querySelectorAll<HTMLElement>(".acct-tab")];
  const show = (tab: string): void => {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    if (tab === "record") renderRecord(body);
    else if (tab === "history") renderHistory(body);
    else if (tab === "friends") renderFriends(body);
    else renderProfileEdit(body, card, overlay);
  };
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.tab!)));

  // Tap the big avatar to choose a profile photo from the game's art. Re-wires
  // itself after each pick (the element is replaced to repaint the new photo).
  const wireHeadAvatar = (): void => {
    const av = card.querySelector(".acct-avatar.editable") as HTMLElement | null;
    if (!av) return;
    av.title = "Change your photo";
    av.addEventListener("click", () => {
      openAvatarPicker(auth.currentProfile()?.avatar ?? null, async (id) => {
        await auth.updateProfile({ avatar: id }); // chip updates via auth.onChange
        const fresh = auth.currentProfile();
        if (fresh) av.outerHTML = avatarMarkup("big editable", fresh);
        wireHeadAvatar();
      });
    });
  };
  wireHeadAvatar();

  const close = (): void => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 200);
  };
  card.querySelector(".acct-close")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));
  show("record");
}

/** A grid picker for the profile photo — choose from the game's own art
 *  (outpost civs, resource icons, encounter motifs). Calls onPick(id) on choose. */
function openAvatarPicker(current: string | null, onPick: (id: string) => void | Promise<void>): void {
  if (document.querySelector(".avpick-overlay")) return;
  const overlay = el(`<div class="acct-overlay avpick-overlay"></div>`);
  const card = el(`
    <div class="acct-card avpick-card">
      <button class="acct-close" title="Close">✕</button>
      <div class="acct-card-title">Choose your photo</div>
      <div class="acct-card-sub">Pick an icon from across the galaxy.</div>
      <div class="avpick-grid"></div>
    </div>`);
  overlay.appendChild(card);
  const grid = card.querySelector(".avpick-grid") as HTMLElement;
  const close = (): void => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 200); };
  for (const id of AVATAR_CHOICES) {
    const cell = el(`<button class="avpick-cell ${id === current ? "selected" : ""}">${avatarSvgById(id)}</button>`);
    cell.addEventListener("click", async () => { await onPick(id); close(); });
    grid.appendChild(cell);
  }
  card.querySelector(".acct-close")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));
}

/** Record tab: win/loss summary cards. */
async function renderRecord(body: HTMLElement): Promise<void> {
  body.replaceChildren(el(`<div class="acct-loading">Loading your record…</div>`));
  const s = await fetchMyStats();
  if (!s) {
    body.replaceChildren(el(`<div class="acct-empty">Couldn't load your record. Try again later.</div>`));
    return;
  }
  if (s.games === 0) {
    body.replaceChildren(
      el(`<div class="acct-empty">No games yet — finish a match and your record appears here. 🚀</div>`),
    );
    return;
  }
  const pct = Math.round(s.winRate * 100);
  body.replaceChildren(
    el(`
      <div class="acct-stat-grid">
        <div class="acct-stat"><div class="acct-stat-n">${s.games}</div><div class="acct-stat-l">Games</div></div>
        <div class="acct-stat win"><div class="acct-stat-n">${s.wins}</div><div class="acct-stat-l">Wins</div></div>
        <div class="acct-stat loss"><div class="acct-stat-n">${s.losses}</div><div class="acct-stat-l">Losses</div></div>
        <div class="acct-stat"><div class="acct-stat-n">${pct}%</div><div class="acct-stat-l">Win rate</div></div>
        <div class="acct-stat"><div class="acct-stat-n">${s.bestVp}</div><div class="acct-stat-l">Best VP</div></div>
      </div>
      <div class="acct-winbar" title="${pct}% wins"><i style="width:${pct}%"></i></div>`),
  );
}

/** A win/loss/win-rate summary strip for a set of games. */
function recordStrip(games: HistoryEntry[]): HTMLElement {
  const total = games.length;
  const wins = games.filter((g) => g.result === "win").length;
  const losses = total - wins;
  const pct = total ? Math.round((wins / total) * 100) : 0;
  return el(`
    <div class="acct-recordwrap">
      <div class="acct-recordbar">
        <div class="rb-stat"><div class="rb-n">${total}</div><div class="rb-l">Games</div></div>
        <div class="rb-stat win"><div class="rb-n">${wins}</div><div class="rb-l">Wins</div></div>
        <div class="rb-stat loss"><div class="rb-n">${losses}</div><div class="rb-l">Losses</div></div>
        <div class="rb-stat"><div class="rb-n">${pct}%</div><div class="rb-l">Win rate</div></div>
      </div>
      <div class="acct-winbar" title="${pct}% wins"><i style="width:${pct}%"></i></div>
    </div>`);
}

/** History tab: Online / Offline sub-tabs, each with a record summary + list. */
async function renderHistory(body: HTMLElement): Promise<void> {
  body.replaceChildren(el(`<div class="acct-loading">Loading your games…</div>`));
  const all = await fetchMyHistory(50);
  const online = all.filter((g) => !g.vsAi);
  const offline = all.filter((g) => g.vsAi);

  const wrap = el(`
    <div class="acct-histwrap">
      <div class="acct-subtabs">
        <button class="acct-subtab active" data-sub="online">Online${online.length ? ` (${online.length})` : ""}</button>
        <button class="acct-subtab" data-sub="offline">Offline${offline.length ? ` (${offline.length})` : ""}</button>
      </div>
      <div class="acct-subbody"></div>
    </div>`);
  const subBody = wrap.querySelector(".acct-subbody") as HTMLElement;
  const subtabs = [...wrap.querySelectorAll<HTMLElement>(".acct-subtab")];
  const showSub = (sub: string): void => {
    subtabs.forEach((t) => t.classList.toggle("active", t.dataset.sub === sub));
    if (sub === "online") renderOnlineHistory(subBody, online, () => void renderHistory(body));
    else renderOfflineHistory(subBody, offline, () => void renderHistory(body));
  };
  subtabs.forEach((t) => t.addEventListener("click", () => showSub(t.dataset.sub!)));
  body.replaceChildren(wrap);
  showSub("online");
}

/** Offline (vs-AI) games: record summary + clickable list. */
function renderOfflineHistory(host: HTMLElement, games: HistoryEntry[], back: () => void): void {
  host.replaceChildren();
  host.appendChild(recordStrip(games));
  if (games.length === 0) {
    host.appendChild(el(`<div class="acct-empty">No single-player games recorded yet.</div>`));
    return;
  }
  const list = el(`<div class="acct-history"></div>`);
  for (const g of games) {
    const row = historyRow(g);
    row.addEventListener("click", () => showGameDetail(host, g, back));
    list.appendChild(row);
  }
  host.appendChild(list);
}

/** Online games: record summary, friend filter (head-to-head), clickable list. */
function renderOnlineHistory(host: HTMLElement, games: HistoryEntry[], back: () => void): void {
  host.replaceChildren();
  host.appendChild(recordStrip(games));
  if (games.length === 0) {
    host.appendChild(el(`<div class="acct-empty">No online games recorded yet — play a friend!</div>`));
    return;
  }

  // Friend filter chips: tap a friend to see only the games you played together,
  // plus your head-to-head record with them.
  const filterBar = el(`<div class="acct-friendfilter"></div>`);
  const h2h = el(`<div class="acct-h2h"></div>`);
  const list = el(`<div class="acct-history"></div>`);
  host.append(filterBar, h2h, list);

  const drawList = (entries: HistoryEntry[]): void => {
    list.replaceChildren();
    for (const g of entries) {
      const row = historyRow(g);
      row.addEventListener("click", () => showGameDetail(host, g, back));
      list.appendChild(row);
    }
  };
  drawList(games);

  void listFriends().then((friends) => {
    if (!host.isConnected) return;
    const allChip = el(`<button class="ff-chip active">All</button>`);
    filterBar.appendChild(allChip);
    const chips: HTMLElement[] = [allChip];
    allChip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.remove("active"));
      allChip.classList.add("active");
      h2h.textContent = "";
      drawList(games);
    });
    for (const f of friends) {
      const chip = el(`<button class="ff-chip">${avatarMarkup("sm", f.user)}${escapeHtml(f.user.displayName)}</button>`);
      chips.push(chip);
      chip.addEventListener("click", async () => {
        chips.forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        h2h.textContent = "Loading…";
        const rec = await fetchGamesWithFriend(f.user.id);
        if (!host.isConnected) return;
        h2h.innerHTML = rec.games === 0
          ? `<span class="muted">No games with <b>${escapeHtml(f.user.displayName)}</b> yet.</span>`
          : `vs <b>${escapeHtml(f.user.displayName)}</b>: <b>${rec.games}</b> game${rec.games === 1 ? "" : "s"} · <span class="h2h-w">${rec.wins}W</span> · <span class="h2h-l">${rec.losses}L</span>`;
        drawList(games.filter((g) => rec.gameIds.has(g.gameId)));
      });
      filterBar.appendChild(chip);
    }
  });
}

function historyRow(g: HistoryEntry): HTMLElement {
  const date = new Date(g.playedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const win = g.result === "win";
  // Rivals = everyone but you (your row is the one with your placement).
  const others = g.players
    .filter((p) => p.placement !== g.placement)
    .map((p) => `<span style="color:${COLOR_HEX[p.color] ?? "#fff"}">${escapeHtml(p.name)} ${p.vp}</span>`)
    .join(" · ");
  const row = el(`
    <div class="acct-hrow ${win ? "win" : "loss"}" role="button" tabindex="0" title="View full result">
      <span class="acct-hres">${win ? "WIN" : "LOSS"}</span>
      <div class="acct-hmid">
        <div class="acct-hline">${g.finalVp} VP · ${ordinal(g.placement)} place${g.vsAi ? " · vs AI" : ""}</div>
        <div class="acct-hsub">${others || "—"}</div>
      </div>
      <span class="acct-hdate">${date}</span>
      <span class="acct-hchev">›</span>
    </div>`);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.click(); }
  });
  return row;
}

/** Full result of one past game: final standings + per-player stats. */
function showGameDetail(body: HTMLElement, g: HistoryEntry, back: () => void): void {
  const date = new Date(g.playedAt).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
  const ranked = [...g.players].sort((a, b) => a.placement - b.placement);
  const rows = ranked
    .map((p) => {
      const isMe = p.placement === g.placement;
      const pc = COLOR_HEX[p.color] ?? "#fff";
      const stat = (n: number, label: string): string =>
        n > 0 ? `<span class="gd-stat"><b>${n}</b>${label}</span>` : "";
      const stats = [
        stat(p.resources, "resources"),
        stat(p.distance, "sectors"),
        stat(p.encounters, "encounters"),
        stat(p.trades, "trades"),
        stat(p.pirates, "pirates"),
        stat(p.ice, "ice"),
      ].join("");
      return `
        <div class="gd-row ${p.placement === 1 ? "win" : ""} ${isMe ? "me" : ""}">
          <span class="gd-rank">${p.placement}</span>
          <span class="acct-avatar sm" style="--ac:${pc}">${escapeHtml(initials(p.name))}</span>
          <div class="gd-meta">
            <div class="gd-name" style="color:${pc}">${escapeHtml(p.name)}${isMe ? ' <span class="gd-you">you</span>' : ""}${p.isAi ? ' <span class="gd-ai">AI</span>' : ""}</div>
            <div class="gd-stats">${stats || '<span class="gd-stat muted">no stats recorded</span>'}</div>
          </div>
          <span class="gd-vp" style="color:${pc}">${p.vp}<span class="gd-vp-l">VP</span></span>
        </div>`;
    })
    .join("");
  const detail = el(`
    <div class="acct-detail">
      <button class="acct-back">← Back to history</button>
      <div class="gd-head">
        <div class="gd-title" style="color:${COLOR_HEX[g.winnerColor] ?? "#fff"}">🏆 ${escapeHtml(g.winnerName)} won</div>
        <div class="gd-sub">${date} · Race to ${g.targetVp} VP${g.vsAi ? " · vs AI" : ""}</div>
      </div>
      <div class="gd-players">${rows}</div>
    </div>`);
  detail.querySelector(".acct-back")!.addEventListener("click", () => back());
  body.replaceChildren(detail);
}

const ordinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? "th");
};

/** A compact user row: avatar + name + @handle + action buttons. */
function userRow(u: FriendUser, actionsHtml: string): HTMLElement {
  const handle = u.username ? "@" + escapeHtml(u.username) : "";
  return el(`
    <div class="fr-row">
      ${avatarMarkup("sm", u)}
      <div class="fr-meta"><div class="fr-name">${escapeHtml(u.displayName)}</div><div class="fr-handle">${handle}</div></div>
      <div class="fr-actions">${actionsHtml}</div>
    </div>`);
}

/** Friends tab: search by username, requests, friend list, sent requests. */
async function renderFriends(body: HTMLElement): Promise<void> {
  const profile = auth.currentProfile();
  body.replaceChildren(el(`<div class="acct-loading">Loading friends…</div>`));
  if (!profile?.username) {
    body.replaceChildren(
      el(`<div class="acct-empty">Set a username in the <b>Edit</b> tab first — that's how friends find and add you.</div>`),
    );
    return;
  }
  const [friends, incoming, outgoing] = await Promise.all([listFriends(), listIncoming(), listOutgoing()]);
  const wrap = el(`<div class="acct-friends"></div>`);
  const refresh = (): void => void renderFriends(body);

  const friendIds = new Set(friends.map((e) => e.user.id));
  const pendingIds = new Set(outgoing.map((e) => e.user.id));

  // --- Search ---
  const searchSec = el(`
    <div class="fr-sec">
      <input class="acct-input fr-search" type="text" placeholder="Find players by name or @username…" />
      <div class="fr-results"></div>
    </div>`);
  const input = searchSec.querySelector(".fr-search") as HTMLInputElement;
  const results = searchSec.querySelector(".fr-results") as HTMLElement;
  let seq = 0;
  input.addEventListener("input", () => {
    const my = ++seq;
    if (input.value.trim().length < 2) {
      results.replaceChildren();
      return;
    }
    void searchUsers(input.value).then((users) => {
      if (my !== seq) return; // a newer keystroke superseded this
      results.replaceChildren();
      if (users.length === 0) {
        results.appendChild(el(`<div class="fr-hint">No players found.</div>`));
        return;
      }
      for (const u of users) {
        const actions = friendIds.has(u.id)
          ? `<span class="fr-tag">Friend</span>`
          : pendingIds.has(u.id)
            ? `<span class="fr-tag">Requested</span>`
            : `<button class="fr-btn add">Add</button>`;
        const row = userRow(u, actions);
        openProfileOnClick(row, u, body, refresh);
        row.querySelector(".add")?.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await sendRequest(u.id);
          refresh();
        });
        results.appendChild(row);
      }
    });
  });
  wrap.appendChild(searchSec);

  // --- Incoming requests ---
  if (incoming.length) {
    const sec = el(`<div class="fr-sec"><div class="fr-title">Requests</div></div>`);
    for (const e of incoming) {
      const row = userRow(e.user, `<button class="fr-btn accept">Accept</button><button class="fr-btn decline" title="Decline">✕</button>`);
      row.querySelector(".accept")!.addEventListener("click", async () => {
        await acceptRequest(e.friendshipId);
        refresh();
      });
      row.querySelector(".decline")!.addEventListener("click", async () => {
        await removeFriendship(e.friendshipId);
        refresh();
      });
      sec.appendChild(row);
    }
    wrap.appendChild(sec);
  }

  // --- Friends ---
  const fsec = el(`<div class="fr-sec"><div class="fr-title">Friends (${friends.length})</div></div>`);
  if (friends.length === 0) {
    fsec.appendChild(el(`<div class="fr-hint">No friends yet — search above to add some.</div>`));
  }
  for (const e of friends) {
    const row = userRow(e.user, `<button class="fr-btn decline" title="Remove friend">✕</button>`);
    openProfileOnClick(row, e.user, body, refresh);
    // Unfriending asks for confirmation (swaps the actions to Yes/No inline).
    row.querySelector(".decline")!.addEventListener("click", () => {
      const actions = row.querySelector(".fr-actions") as HTMLElement;
      actions.innerHTML =
        `<span class="fr-confirm">Remove?</span><button class="fr-btn decline yes">Yes</button><button class="fr-btn no">No</button>`;
      actions.querySelector(".yes")!.addEventListener("click", async () => {
        await removeFriendship(e.friendshipId);
        refresh();
      });
      actions.querySelector(".no")!.addEventListener("click", () => refresh());
    });
    fsec.appendChild(row);
  }
  wrap.appendChild(fsec);

  // --- Sent (pending) requests ---
  if (outgoing.length) {
    const sec = el(`<div class="fr-sec"><div class="fr-title">Sent requests</div></div>`);
    for (const e of outgoing) {
      const row = userRow(e.user, `<button class="fr-btn decline" title="Cancel">✕</button>`);
      row.querySelector(".decline")!.addEventListener("click", async () => {
        await removeFriendship(e.friendshipId);
        refresh();
      });
      sec.appendChild(row);
    }
    wrap.appendChild(sec);
  }

  body.replaceChildren(wrap);
}

/** Make a user row's avatar + name open that player's profile when tapped. */
function openProfileOnClick(row: HTMLElement, u: FriendUser, body: HTMLElement, back: () => void): void {
  const open = (): void => void showFriendProfile(body, u, back);
  for (const sel of [".acct-avatar", ".fr-meta"]) {
    const target = row.querySelector(sel) as HTMLElement | null;
    if (target) { target.classList.add("clickable"); target.addEventListener("click", open); }
  }
}

/** A friend's public profile: their record + recent games (newest first). */
async function showFriendProfile(body: HTMLElement, u: FriendUser, back: () => void): Promise<void> {
  body.replaceChildren(el(`<div class="acct-loading">Loading ${escapeHtml(u.displayName)}…</div>`));
  const [stats, history] = await Promise.all([fetchUserStats(u.id), fetchUserHistory(u.id, 50)]);
  if (!body.isConnected) return;
  const handle = u.username ? "@" + escapeHtml(u.username) : "";
  const pct = stats && stats.games ? Math.round(stats.winRate * 100) : 0;
  const view = el(`
    <div class="acct-detail">
      <button class="acct-back">← Back to friends</button>
      <div class="fp-head">
        ${avatarMarkup("big", u)}
        <div>
          <div class="fp-name">${escapeHtml(u.displayName)}</div>
          <div class="fp-handle">${handle}</div>
        </div>
      </div>
      <div class="acct-stat-grid">
        <div class="acct-stat"><div class="acct-stat-n">${stats?.games ?? 0}</div><div class="acct-stat-l">Games</div></div>
        <div class="acct-stat win"><div class="acct-stat-n">${stats?.wins ?? 0}</div><div class="acct-stat-l">Wins</div></div>
        <div class="acct-stat loss"><div class="acct-stat-n">${stats?.losses ?? 0}</div><div class="acct-stat-l">Losses</div></div>
        <div class="acct-stat"><div class="acct-stat-n">${pct}%</div><div class="acct-stat-l">Win rate</div></div>
        <div class="acct-stat"><div class="acct-stat-n">${stats?.bestVp ?? 0}</div><div class="acct-stat-l">Best VP</div></div>
      </div>
      <div class="acct-winbar" title="${pct}% wins"><i style="width:${pct}%"></i></div>
      <div class="fr-title" style="margin-top:14px">Recent games</div>
      <div class="acct-history fp-history"></div>
    </div>`);
  view.querySelector(".acct-back")!.addEventListener("click", () => back());
  const list = view.querySelector(".fp-history") as HTMLElement;
  if (history.length === 0) {
    list.appendChild(el(`<div class="acct-empty">No games recorded yet.</div>`));
  } else {
    for (const g of history) {
      const row = historyRow(g);
      row.addEventListener("click", () => showGameDetail(body, g, () => void showFriendProfile(body, u, back)));
      list.appendChild(row);
    }
  }
  body.replaceChildren(view);
}

/** Edit tab: username (the single identity, with availability), favorite color,
 *  sign out. There's no separate display name — the username IS the name shown
 *  everywhere, so saving it mirrors to display_name under the hood. */
function renderProfileEdit(body: HTMLElement, card: HTMLElement, overlay: HTMLElement): void {
  const profile = auth.currentProfile();
  if (!profile) return;
  let username = profile.username ?? "";
  let color: PlayerColor = profile.favoriteColor;

  const view = el(`
    <div class="acct-edit">
      <label class="acct-field">
        <span class="acct-label">Username <span class="auth-at">@yourname — your name everywhere, and how friends find you</span></span>
        <input class="acct-input" id="un" type="text" maxlength="20" placeholder="3–20 letters, numbers or _" value="${escapeHtml(username)}" />
        <span class="acct-hint" id="unhint"></span>
      </label>
      <div class="acct-field">
        <span class="acct-label">Favorite color</span>
        <div class="acct-swatches"></div>
      </div>
      <div class="acct-actions">
        <button class="acct-save" disabled>Saved</button>
        <button class="acct-signout secondary">Sign out</button>
      </div>
    </div>`);
  body.replaceChildren(view);

  const avatar = card.querySelector(".acct-avatar") as HTMLElement;
  const un = view.querySelector("#un") as HTMLInputElement;
  const hint = view.querySelector("#unhint") as HTMLElement;
  const save = view.querySelector(".acct-save") as HTMLButtonElement;
  const swatches = view.querySelector(".acct-swatches") as HTMLElement;

  let usernameOk = true; // empty (unchanged) or confirmed available
  let checkSeq = 0;

  const refresh = (): void => {
    const changed = username.trim() !== (profile.username ?? "") || color !== profile.favoriteColor;
    save.disabled = !changed || !usernameOk;
    save.textContent = changed ? "Save changes" : "Saved";
  };

  for (const c of PLAYER_COLORS) {
    const sw = el(`<button class="acct-swatch ${c === color ? "selected" : ""}" title="${COLOR_NAME[c]}" style="--sw:${COLOR_HEX[c]}"></button>`);
    sw.addEventListener("click", () => {
      color = c;
      swatches.querySelectorAll(".acct-swatch").forEach((s) => s.classList.remove("selected"));
      sw.classList.add("selected");
      avatar.style.setProperty("--ac", COLOR_HEX[c]);
      refresh();
    });
    swatches.appendChild(sw);
  }

  un.addEventListener("input", () => {
    username = un.value;
    const trimmed = username.trim();
    avatar.textContent = initials(trimmed || "C"); // avatar follows the username
    if (trimmed === (profile.username ?? "")) {
      usernameOk = true;
      hint.textContent = "";
      hint.className = "acct-hint";
      refresh();
      return;
    }
    if (!validUsername(trimmed)) {
      usernameOk = false;
      hint.textContent = "3–20 letters, numbers or _";
      hint.className = "acct-hint bad";
      refresh();
      return;
    }
    usernameOk = false; // pending check
    hint.textContent = "Checking…";
    hint.className = "acct-hint";
    refresh();
    const seq = ++checkSeq;
    void auth.isUsernameAvailable(trimmed).then((free) => {
      if (seq !== checkSeq) return; // a newer keystroke superseded this
      usernameOk = free;
      hint.textContent = free ? "✓ Available" : "✗ Taken";
      hint.className = `acct-hint ${free ? "good" : "bad"}`;
      refresh();
    });
  });

  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const handle = username.trim();
      // The username is the single identity, so mirror it into display_name.
      await auth.updateProfile(
        handle && handle !== (profile.username ?? "")
          ? { username: handle, displayName: handle, favoriteColor: color }
          : { favoriteColor: color },
      );
      // Reflect the new identity in the card header without reopening.
      const shown = handle || profile.displayName;
      (card.querySelector(".acct-card-title") as HTMLElement).textContent = shown;
      const handleEl = card.querySelector(".acct-handle") as HTMLElement;
      handleEl.textContent = handle ? "@" + handle : "Set a username to add friends";
      save.textContent = "Saved";
    } catch {
      save.textContent = "Save failed — retry";
      save.disabled = false;
    }
  });

  view.querySelector(".acct-signout")!.addEventListener("click", async () => {
    await auth.signOut();
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 200);
  });
}
