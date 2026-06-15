import { PLAYER_COLORS, type PlayerColor } from "@starfarers/shared";
import { auth, isAuthConfigured, type Profile } from "../auth.js";
import { fetchMyStats, fetchMyHistory, type HistoryEntry } from "../social.js";
import {
  searchUsers, listFriends, listIncoming, listOutgoing,
  sendRequest, acceptRequest, removeFriendship, type FriendUser,
} from "../friends.js";

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
  auth.onChange(paint);
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
        <span class="acct-avatar big" style="--ac:${COLOR_HEX[profile.favoriteColor]}">${escapeHtml(initials(profile.displayName))}</span>
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

/** History tab: recent games, newest first. */
async function renderHistory(body: HTMLElement): Promise<void> {
  body.replaceChildren(el(`<div class="acct-loading">Loading your games…</div>`));
  const games = await fetchMyHistory(20);
  if (games.length === 0) {
    body.replaceChildren(el(`<div class="acct-empty">No games recorded yet.</div>`));
    return;
  }
  const list = el(`<div class="acct-history"></div>`);
  for (const g of games) {
    const row = historyRow(g);
    row.addEventListener("click", () => showGameDetail(body, g));
    list.appendChild(row);
  }
  body.replaceChildren(list);
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
function showGameDetail(body: HTMLElement, g: HistoryEntry): void {
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
  detail.querySelector(".acct-back")!.addEventListener("click", () => void renderHistory(body));
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
      <span class="acct-avatar sm" style="--ac:${COLOR_HEX[u.favoriteColor]}">${escapeHtml(initials(u.displayName))}</span>
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
      <input class="acct-input fr-search" type="text" placeholder="Find players by username…" />
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
        row.querySelector(".add")?.addEventListener("click", async () => {
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

/** Edit tab: display name, username (with availability), favorite color, sign out. */
function renderProfileEdit(body: HTMLElement, card: HTMLElement, overlay: HTMLElement): void {
  const profile = auth.currentProfile();
  if (!profile) return;
  let name = profile.displayName;
  let username = profile.username ?? "";
  let color: PlayerColor = profile.favoriteColor;

  const view = el(`
    <div class="acct-edit">
      <label class="acct-field">
        <span class="acct-label">Display name</span>
        <input class="acct-input" id="dn" type="text" maxlength="24" value="${escapeHtml(name)}" />
      </label>
      <label class="acct-field">
        <span class="acct-label">Username (for friends)</span>
        <input class="acct-input" id="un" type="text" maxlength="20" placeholder="3–20 letters, numbers, _" value="${escapeHtml(username)}" />
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
  const dn = view.querySelector("#dn") as HTMLInputElement;
  const un = view.querySelector("#un") as HTMLInputElement;
  const hint = view.querySelector("#unhint") as HTMLElement;
  const save = view.querySelector(".acct-save") as HTMLButtonElement;
  const swatches = view.querySelector(".acct-swatches") as HTMLElement;

  let usernameOk = true; // empty (unchanged) or confirmed available
  let checkSeq = 0;

  const refresh = (): void => {
    const changed =
      name.trim() !== profile.displayName ||
      username.trim() !== (profile.username ?? "") ||
      color !== profile.favoriteColor;
    save.disabled = !changed || name.trim().length === 0 || !usernameOk;
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

  dn.addEventListener("input", () => {
    name = dn.value;
    avatar.textContent = initials(name);
    refresh();
  });

  un.addEventListener("input", () => {
    username = un.value;
    const trimmed = username.trim();
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
      await auth.updateProfile({
        displayName: name.trim(),
        favoriteColor: color,
        username: username.trim() || (profile.username ?? ""),
      });
      // Reflect the new identity in the card header without reopening.
      (card.querySelector(".acct-card-title") as HTMLElement).textContent = name.trim();
      const handleEl = card.querySelector(".acct-handle") as HTMLElement;
      handleEl.textContent = username.trim() ? "@" + username.trim() : "Set a username to add friends";
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
