import { net, type NetMode } from "../net.js";
import {
  type GameState,
  type LobbyState,
  type PlayerColor,
  type RoomSummary,
  PLAYER_COLORS,
  DEFAULT_TARGET_VP,
  VP_MIN,
  VP_MAX,
} from "@starfarers/shared";
import { shatter } from "./fx.js";
import { el, escapeHtml } from "./dom.js";
import { auth } from "../auth.js";
import { presence } from "../presence.js";
import { listFriends } from "../friends.js";

const initials = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "C";

const COLOR_HEX: Record<PlayerColor, string> = {
  yellow: "#ffd23f",
  red: "#ff5d5d",
  blue: "#4fa8ff",
  black: "#8a8fa6",
  green: "#52d273",
  white: "#e9eef7",
};

type StartHandler = (state: GameState, youId: string) => void;

const SESSION_KEY = "sf_session";

interface SavedSession {
  roomCode: string;
  playerId: string;
}

// localStorage (not sessionStorage) so the saved game survives a full browser
// restart — the player can come back later and pick up where they left off.
function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}

function saveSession(s: SavedSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export class LobbyUI {
  private root: HTMLElement;
  private youId = "";
  private lobby: LobbyState | null = null;
  private errorText = "";
  /** Shown on the connect screen after a failed auto-rejoin (game ended / seat
   *  forfeited after the away grace period). */
  private noticeText = "";
  private rejoining = false;
  private fogMap = false;
  private turnSeconds = 0; // host-chosen per-turn timer (0 = off)
  private targetVP = DEFAULT_TARGET_VP;
  private botSpeed: "relaxed" | "normal" | "fast" = "normal";
  private hideBank = false;
  /** #15/#16 map layout: official / balanced / unbalanced. Default official. */
  private layout: "official" | "balanced" | "unbalanced" = "official";
  private deck36Dice = false;
  /** Reserve-pile catch-up draw. Default on (faithful). */
  private reservePileLimit = true;
  private onStart: StartHandler | undefined;
  private onBack: (() => void) | undefined;
  private onReset: (() => void) | undefined;
  private started = false;
  private mode: NetMode;
  /** AB4: apply the signed-in favorite color once, when it's free. */
  private appliedFavColor = false;
  /** AC2: live presence subscription for the invite-friends panel. */
  private presenceUnsub: (() => void) | null = null;
  /** Re-request the public-room list whenever the socket (re)connects. */
  private statusUnsub: (() => void) | null = null;
  /** Structure signature of the last full lobby render, so a color/crew change
   *  updates in place instead of rebuilding the whole screen (which flickered). */
  private lobbySig = "";
  /** AC2: friends already invited to this room, so we never invite twice
   *  (the panel re-renders on every presence change, which would otherwise
   *  reset each "Invited" button back to a clickable "Invite"). */
  private invited = new Set<string>();
  /** Browsable public-room list (lobby browser) + chosen host visibility. */
  private rooms: RoomSummary[] = [];
  private hostPublic = true;

  constructor(
    mount: HTMLElement,
    onStart?: StartHandler,
    onBack?: () => void,
    onReset?: () => void,
    mode: NetMode = "lan",
    autoJoinCode?: string,
  ) {
    this.root = mount;
    this.onStart = onStart;
    this.onBack = onBack;
    this.onReset = onReset;
    this.mode = mode;
    net.on((msg) => {
      if (msg.t === "state") {
        // The authoritative game has begun (or advanced) — hand off to the board.
        if (!this.started) {
          this.started = true;
          this.presenceUnsub?.(); // stop refreshing the (now-gone) invite panel
          this.presenceUnsub = null;
          this.statusUnsub?.(); // stop re-requesting the room list
          this.statusUnsub = null;
          this.onStart?.(msg.state, msg.youId);
        }
        return;
      }
      if (msg.t === "roomList") {
        this.rooms = msg.rooms;
        this.renderRoomList();
        return;
      }
      if (msg.t === "lobby") {
        this.rejoining = false;
        this.youId = msg.youId;
        this.lobby = msg.lobby;
        this.errorText = "";
        saveSession({ roomCode: msg.lobby.roomCode, playerId: msg.youId });
        this.applyFavoriteColor();
        if (msg.lobby.started) {
          this.root.replaceChildren(); // board takes over
        } else {
          // R18: a started→not-started transition means the host hit "Play again"
          // after a finished game. Tear the old board/HUD down and re-show the
          // lobby; the `started` latch resets so the next startGame mounts fresh.
          if (this.started) this.onReset?.();
          this.started = false;
          this.renderLobby();
        }
      } else if (msg.t === "error") {
        if (this.rejoining) {
          // The saved game is gone (ended) or our seat was forfeited after the
          // away grace period — forget it and fall back to the connect screen,
          // telling the player why so they know they can freely join another.
          this.rejoining = false;
          clearSession();
          this.noticeText = msg.message;
          this.renderConnect();
          return;
        }
        this.errorText = msg.message;
        this.renderError();
      }
    });

    // AC2: accepting a friend's invite jumps straight into THEIR room — join it
    // immediately (the profile name rides along), bypassing the connect screen.
    if (autoJoinCode) {
      const nm = auth.currentProfile()?.displayName ?? "Commander";
      net.send({ t: "joinRoom", roomCode: autoJoinCode.toUpperCase(), name: nm, username: auth.currentProfile()?.username ?? undefined });
      this.renderConnect(); // shown only momentarily until the lobby arrives
      return;
    }

    // Don't silently jump back into a saved game. Show the connect screen; if
    // there's a game in progress it appears as a "Rejoin" card you can click —
    // or you can join another room / host a new game instead.
    this.renderConnect();
  }

  private renderError(): void {
    const e = this.root.querySelector(".error");
    if (e) e.textContent = this.errorText;
  }

  /** Connect screen, in the same open "mission setup" language as the
   *  single-player menu: labelled rows on the comet field, an underline name
   *  input, a glowing HOST CTA and a join-by-code row. */
  private renderConnect(): void {
    const screen = el(`
      <div class="screen">
        <div class="setup">
          <div class="setup-head">
            <div class="setup-kicker">${this.mode === "online" ? "Play online" : "Play on your LAN"}</div>
            <h1 class="setup-title">JOIN THE VOYAGE</h1>
          </div>
          ${this.noticeText ? `<div class="rejoin-notice">${escapeHtml(this.noticeText)}</div>` : ""}
          ${
            this.mode === "online" && loadSession()
              ? `<div class="setup-row">
                  <div class="setup-label">Your game</div>
                  <div class="setup-ctrl">
                    <button class="resume-card" id="rejoingame">
                      <span class="resume-card-title">Rejoin game ${escapeHtml(loadSession()!.roomCode)}</span>
                      <span class="resume-card-sub">Pick up your voyage in progress</span>
                    </button>
                  </div>
                </div>`
              : ""
          }

          <div class="setup-row">
            <div class="setup-label">Commander</div>
            <div class="setup-ctrl">
              <input type="text" id="name" class="setup-name" placeholder="Commander" maxlength="16" />
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Open rooms <button class="room-refresh" id="refreshrooms" title="Refresh room list">⟳</button></div>
            <div class="setup-ctrl">
              <div class="room-list" id="roomlist"></div>
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Join by code</div>
            <div class="setup-ctrl">
              <input type="text" id="code" class="setup-name setup-code" placeholder="ABCD" maxlength="4" />
              <div class="seg"><button class="seg-opt" id="join">Join</button></div>
            </div>
          </div>

          <div class="setup-launch">
            <div class="glow-wrap">
              <div class="glow-layer glow-far"><i></i></div>
              <div class="glow-layer glow-near"><i></i></div>
              <button class="glow-btn" id="host">HOST A GAME</button>
            </div>
            <div class="error"></div>
            ${this.onBack ? `<button class="setup-back" id="back">← Back</button>` : ""}
          </div>
        </div>
      </div>
    `);
    const name = () => (screen.querySelector("#name") as HTMLInputElement).value.trim();
    // AB4: prefill the commander name from the signed-in profile. When signed in
    // the name is LOCKED — it's your account name and can only be changed from the
    // profile page, not when hosting/joining.
    const profile = auth.currentProfile();
    if (profile) {
      const nameInput = screen.querySelector("#name") as HTMLInputElement;
      nameInput.value = profile.displayName;
      nameInput.readOnly = true;
      nameInput.classList.add("locked");
      nameInput.title = "Your name comes from your account — change it on your profile.";
    }
    screen.querySelector("#back")?.addEventListener("click", () => { net.send({ t: "leaveBrowsing" }); this.onBack?.(); });
    const hostBtn = screen.querySelector("#host") as HTMLElement;
    hostBtn.addEventListener("click", () => {
      // Rooms are created public by default; visibility is now toggled inside the
      // lobby's host settings (Public / Private), alongside the other match rules.
      shatter(hostBtn, "#39d8c8", () => net.send({ t: "createRoom", name: name(), public: true, username: auth.currentProfile()?.username ?? undefined }));
    });
    screen.querySelector("#join")!.addEventListener("click", () => {
      const code = (screen.querySelector("#code") as HTMLInputElement).value.trim().toUpperCase();
      if (!code) { this.errorText = "Enter a room code."; this.renderError(); return; }
      net.send({ t: "joinRoom", roomCode: code, name: name(), username: auth.currentProfile()?.username ?? undefined });
    });
    // Refresh the open-room list on demand.
    screen.querySelector("#refreshrooms")?.addEventListener("click", () => {
      const btn = screen.querySelector("#refreshrooms") as HTMLElement;
      btn.classList.add("spin");
      window.setTimeout(() => btn.classList.remove("spin"), 600);
      net.send({ t: "listRooms" });
    });
    // Rejoin the in-progress game (the server resync) when the card is clicked.
    screen.querySelector("#rejoingame")?.addEventListener("click", () => {
      const s = loadSession();
      if (!s) return;
      this.rejoining = true;
      this.errorText = "";
      net.send({ t: "rejoin", roomCode: s.roomCode, playerId: s.playerId });
    });
    this.root.replaceChildren(screen);
    this.noticeText = ""; // shown once
    // Ask for the browsable public-room list (server pushes live updates too),
    // and re-ask whenever the socket (re)connects — the free-tier server naps
    // and forgets browsers, so the list would otherwise stay stale/empty.
    net.send({ t: "listRooms" });
    this.statusUnsub?.();
    this.statusUnsub = net.onStatus((s) => {
      if (s === "connected" && !this.lobby && !this.started) net.send({ t: "listRooms" });
    });
    this.renderRoomList();
  }

  /** Fill the public-room list on the connect screen (no-op elsewhere). */
  private renderRoomList(): void {
    const host = this.root.querySelector("#roomlist") as HTMLElement | null;
    if (!host) return;
    host.replaceChildren();
    if (this.rooms.length === 0) {
      host.appendChild(el(`<div class="room-empty">No open rooms — host one below.</div>`));
      return;
    }
    const nameVal = (): string =>
      (this.root.querySelector("#name") as HTMLInputElement | null)?.value.trim() ?? "";
    for (const r of this.rooms) {
      const mapTag = r.fog ? "🌫 Uncharted" : "🛰 Charted";
      const timerTag = r.timer > 0 ? `⏱ ${r.timer}s/turn` : "⏱ No timer";
      const row = el(`
        <div class="room-row">
          <div class="room-meta">
            <span class="room-host">${escapeHtml(r.host)}</span>
            <span class="room-tags">${mapTag} · ${timerTag} · <span class="room-code">${escapeHtml(r.code)}</span></span>
          </div>
          <span class="room-count">${r.players}/${r.max}</span>
          <button class="room-join">Join</button>
        </div>`);
      row.querySelector(".room-join")!.addEventListener("click", () => {
        net.send({ t: "joinRoom", roomCode: r.code, name: nameVal(), username: auth.currentProfile()?.username ?? undefined });
      });
      host.appendChild(row);
    }
  }

  /** AB4: once in the pre-game lobby, switch to the signed-in player's favorite
   *  color if it's still available (and not already theirs). One-shot. */
  private applyFavoriteColor(): void {
    if (this.appliedFavColor) return;
    const lobby = this.lobby;
    const profile = auth.currentProfile();
    if (!lobby || lobby.started || !profile) return;
    this.appliedFavColor = true; // attempt only once per lobby session
    const me = lobby.players.find((p) => p.id === this.youId);
    if (!me || me.color === profile.favoriteColor) return;
    const taken = lobby.players.some((p) => p.id !== this.youId && p.color === profile.favoriteColor);
    if (!taken) net.send({ t: "setColor", color: profile.favoriteColor });
  }

  /** The crew list + (host-only) Add-AI button — markup shared by the full
   *  render and the in-place update. */
  private crewInnerHtml(): string {
    const lobby = this.lobby!;
    const isHost = lobby.players.find((p) => p.id === this.youId)?.isHost;
    return `<ul class="players">
        ${lobby.players
          .map(
            (p) => `
          <li class="${p.connected ? "" : "offline"}">
            <span class="dot ${p.color}"></span>
            <span>${escapeHtml(p.name)}</span>
            <span class="badge">${p.isAI ? "AI" : p.isHost ? "HOST" : ""}${p.id === this.youId ? " · you" : ""}</span>
            ${isHost && p.isAI ? `<button class="ai-remove" data-id="${p.id}" title="Remove this AI">✕</button>` : ""}
          </li>`,
          )
          .join("")}
      </ul>
      ${isHost && lobby.players.length < 4 ? `<div class="seg"><button class="seg-opt" id="addai">+ Add AI opponent</button></div>` : ""}`;
  }

  /** Read-only summary of the host's match settings, shown to guests so they can
   *  see (but not change) the room config. */
  private roSettingsHtml(lobby: LobbyState): string {
    const c = lobby.config;
    const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
    const pill = (label: string, val: string): string =>
      `<div class="setup-row"><div class="setup-label">${label}</div><div class="setup-ctrl"><span class="ro-pill">${escapeHtml(val)}</span></div></div>`;
    const variants: [string, boolean][] = [
      ["Hide Bank", !!c.hideBank],
      ["Deck36 Dice", !!c.deck36Dice],
      ["Reserve Limit", c.reservePileLimit !== false],
    ];
    const layoutMode = c.layout ?? (c.balancedLayout === false ? "unbalanced" : "balanced");
    const chips = variants
      .map(([n, on]) => `<span class="variant-chip ro ${on ? "on" : ""}">${n}</span>`)
      .join("");
    return `
      ${pill("Visibility", lobby.isPublic ? "Public" : "Private")}
      ${pill("Galaxy", c.fogMap ? "Uncharted" : "Charted")}
      ${pill("Map layout", `${cap(layoutMode)}${layoutMode === "official" ? " (fixed)" : ""}`)}
      ${pill("Bot speed", cap(c.botSpeed ?? "normal"))}
      ${pill("Victory target", `${c.targetVictoryPoints ?? 15} VP`)}
      <div class="setup-row"><div class="setup-label">Variants</div><div class="setup-ctrl"><div class="variant-chips ro">${chips}</div></div></div>
      ${pill("Turn timer", c.turnSeconds ? `${c.turnSeconds}s / turn` : "Off")}`;
  }

  /** Fill a container with the colour swatches (taken ones dimmed). */
  private buildSwatches(container: Element): void {
    const lobby = this.lobby!;
    const me = lobby.players.find((p) => p.id === this.youId);
    container.replaceChildren();
    const used = new Map(lobby.players.map((p) => [p.color, p.id] as const));
    for (const c of PLAYER_COLORS) {
      const taken = used.has(c) && used.get(c) !== this.youId;
      const mine = me?.color === c;
      const btn = el(
        `<button class="swatch ${mine ? "selected" : ""}" ${taken ? "disabled" : ""} title="${taken ? "Taken" : c}" style="--sw:${COLOR_HEX[c]};${taken ? "opacity:0.3;cursor:not-allowed" : ""}"></button>`,
      );
      if (!taken) btn.addEventListener("click", () => net.send({ t: "setColor", color: c as PlayerColor }));
      container.appendChild(btn);
    }
  }

  /** Wire the Add-AI / remove-AI buttons within a scope. */
  private wireCrew(scope: ParentNode): void {
    scope.querySelector("#addai")?.addEventListener("click", () => net.send({ t: "addAi" }));
    scope.querySelectorAll(".ai-remove").forEach((b) =>
      b.addEventListener("click", () => net.send({ t: "removeAi", id: (b as HTMLElement).dataset.id! })),
    );
  }

  private renderLobby(): void {
    const lobby = this.lobby!;
    const me = lobby.players.find((p) => p.id === this.youId);
    const isHost = !!me?.isHost;
    // The link other players open to join: online players load this very site;
    // LAN players load the host's server URL.
    const shareUrl = this.mode === "online" ? location.origin : net.currentUrl;
    const onlineInvite = this.mode === "online" && !!auth.currentProfile();
    // An online game needs ≥2 players to start; 1-player tables are blocked.
    const canStart = lobby.players.length >= 2;
    const startLabel = canStart
      ? `START GAME · ${lobby.players.length} ${lobby.players.length === 1 ? "PLAYER" : "PLAYERS"}`
      : "ADD A PLAYER TO START";

    // In-place update: when the screen is already up for this same room/role
    // (e.g. someone changed colour or joined), refresh only the bits that
    // change rather than rebuilding the whole screen — which flickered and
    // reset the friends panel / scroll.
    // Guests get a config signature too, so the host changing a setting forces a
    // full re-render of their read-only summary (hosts keep the in-place path so
    // their own toggles don't flicker the friends panel).
    const c = lobby.config;
    const configSig = isHost
      ? ""
      : `|${c.fogMap}|${c.turnSeconds}|${c.targetVictoryPoints}|${c.botSpeed}|${c.hideBank}|${c.layout ?? c.balancedLayout}|${c.deck36Dice}|${c.reservePileLimit}|${lobby.isPublic}`;
    const sig = `${lobby.roomCode}|${isHost}|${lobby.started}|${onlineInvite}${configSig}`;
    if (this.lobbySig === sig && !lobby.started && this.root.querySelector(".roomcode-title")) {
      const crewCtrl = this.root.querySelector("#crewctrl");
      if (crewCtrl) { crewCtrl.innerHTML = this.crewInnerHtml(); this.wireCrew(crewCtrl); }
      const colorsRow = this.root.querySelector("#colors");
      if (colorsRow) this.buildSwatches(colorsRow);
      const crewCount = this.root.querySelector("#crewcount");
      if (crewCount) crewCount.textContent = String(lobby.players.length);
      const startBtn = this.root.querySelector("#start") as HTMLButtonElement | null;
      if (startBtn) { startBtn.textContent = startLabel; startBtn.disabled = !canStart; }
      return;
    }
    this.lobbySig = sig;

    const screen = el(`
      <div class="screen">
        <div class="setup">
          <div class="setup-head">
            <div class="setup-kicker">Room code — share it with your crew</div>
            <h1 class="setup-title roomcode-title">${lobby.roomCode}</h1>
            <div class="lan-url">${shareUrl}</div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Crew (<span id="crewcount">${lobby.players.length}</span>)</div>
            <div class="setup-ctrl setup-crew" id="crewctrl">${this.crewInnerHtml()}</div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Your color</div>
            <div class="setup-ctrl"><div class="swatches" id="colors"></div></div>
          </div>

          ${onlineInvite ? `
          <div class="setup-row">
            <div class="setup-label">Invite friends</div>
            <div class="setup-ctrl"><div class="fr-invite" id="invitefriends"><div class="fr-hint">Loading friends…</div></div></div>
          </div>` : ""}

          ${isHost ? `
          <div class="setup-row">
            <div class="setup-label">Visibility</div>
            <div class="setup-ctrl"><div class="seg host-vis" id="visibility"></div></div>
          </div>
          <div class="setup-row">
            <div class="setup-label">Galaxy</div>
            <div class="setup-ctrl"><div class="seg seg-wide" id="mapstyle"></div></div>
          </div>
          <div class="setup-row">
            <div class="setup-label">Bot speed</div>
            <div class="setup-ctrl"><div class="seg" id="botspeed"></div></div>
          </div>
          <div class="setup-row">
            <div class="setup-label">Victory target</div>
            <div class="setup-ctrl"><div class="seg" id="vptarget"></div></div>
          </div>
          <div class="setup-row">
            <div class="setup-label">Map layout</div>
            <div class="setup-ctrl"><div class="variant-chips layout-chips" id="maplayout"></div></div>
          </div>
          <div class="setup-row">
            <div class="setup-label">Variants</div>
            <div class="setup-ctrl"><div class="variant-chips" id="variants"></div></div>
          </div>
          <div class="setup-row">
            <div class="setup-label">Turn timer</div>
            <div class="setup-ctrl"><div class="seg" id="turntimer"></div></div>
          </div>` : ""}

          ${!isHost ? this.roSettingsHtml(lobby) : ""}

          <div class="setup-launch">
            ${isHost
              ? `<div class="glow-wrap">
                   <div class="glow-layer glow-far"><i></i></div>
                   <div class="glow-layer glow-near"><i></i></div>
                   <button class="glow-btn" id="start" ${canStart ? "" : "disabled"}>${startLabel}</button>
                 </div>`
              : `<p class="sp-sub">Waiting for the host to start…</p>`}
            <div class="error">${this.errorText}</div>
            <button class="setup-back" id="leave">← Leave room</button>
          </div>
        </div>
      </div>
    `);

    this.buildSwatches(screen.querySelector("#colors")!);
    this.wireCrew(screen);

    // Segmented controls, identical to the single-player menu.
    if (isHost) {
      const seg = (
        host: Element,
        options: { label: string; hint?: string; selected?: boolean; disabled?: boolean; pick?: () => void }[],
      ): void => {
        host.replaceChildren();
        for (const o of options) {
          const b = el(
            `<button class="seg-opt ${o.selected ? "on" : ""} ${o.pick ? "" : "seg-val"}" ${o.disabled || !o.pick ? "disabled" : ""}>${o.label}${o.hint ? `<span class="seg-hint">${o.hint}</span>` : ""}</button>`,
          );
          if (o.pick && !o.disabled) b.addEventListener("click", o.pick);
          host.appendChild(b);
        }
      };
      // Picking a setting both repaints the toggle AND tells the server, so the
      // choice shows on the room card in everyone's lobby browser.
      const mapRow = screen.querySelector("#mapstyle")!;
      const paintMap = (): void =>
        seg(mapRow, [
          { label: "Charted", hint: "Whole galaxy visible", selected: !this.fogMap, pick: () => { this.fogMap = false; net.send({ t: "setRoomConfig", fogMap: false }); paintMap(); } },
          { label: "Uncharted", hint: "Fog — explore to reveal", selected: this.fogMap, pick: () => { this.fogMap = true; net.send({ t: "setRoomConfig", fogMap: true }); paintMap(); } },
        ]);
      paintMap();

      const timerRow = screen.querySelector("#turntimer")!;
      const setTimer = (n: number): void => { this.turnSeconds = n; net.send({ t: "setRoomConfig", turnSeconds: n }); paintTimer(); };
      const paintTimer = (): void =>
        seg(timerRow, [
          { label: "Off", selected: this.turnSeconds === 0, pick: () => setTimer(0) },
          { label: "−15s", disabled: this.turnSeconds <= 60, pick: () => setTimer(Math.max(60, this.turnSeconds - 15)) },
          { label: this.turnSeconds === 0 ? "No limit" : `${this.turnSeconds}s / turn` },
          { label: "+15s", disabled: this.turnSeconds >= 300, pick: () => setTimer(this.turnSeconds === 0 ? 60 : Math.min(300, this.turnSeconds + 15)) },
        ]);
      paintTimer();

      // Room visibility — moved here from the connect screen (host-only).
      const visRow = screen.querySelector("#visibility")!;
      const setVis = (pub: boolean): void => { this.hostPublic = pub; net.send({ t: "setRoomConfig", isPublic: pub }); paintVis(); };
      const paintVis = (): void =>
        seg(visRow, [
          { label: "Public", hint: "Listed in the browser", selected: this.hostPublic, pick: () => setVis(true) },
          { label: "Private", hint: "Code only", selected: !this.hostPublic, pick: () => setVis(false) },
        ]);
      paintVis();

      // Bot speed.
      const botRow = screen.querySelector("#botspeed")!;
      const setBot = (v: "relaxed" | "normal" | "fast"): void => { this.botSpeed = v; net.send({ t: "setRoomConfig", botSpeed: v }); paintBot(); };
      const paintBot = (): void =>
        seg(botRow, [
          { label: "Relaxed", hint: "Natural", selected: this.botSpeed === "relaxed", pick: () => setBot("relaxed") },
          { label: "Normal", hint: "Moderate", selected: this.botSpeed === "normal", pick: () => setBot("normal") },
          { label: "Fast", hint: "Zero delay", selected: this.botSpeed === "fast", pick: () => setBot("fast") },
        ]);
      paintBot();

      // Victory target — 12 to 25 VP.
      const vpRow = screen.querySelector("#vptarget")!;
      const setVP = (n: number): void => { this.targetVP = n; net.send({ t: "setRoomConfig", targetVictoryPoints: n }); paintVP(); };
      const paintVP = (): void =>
        seg(vpRow, [
          { label: "−", disabled: this.targetVP <= VP_MIN, pick: () => setVP(Math.max(VP_MIN, this.targetVP - 1)) },
          { label: `${this.targetVP} VP` },
          { label: "+", disabled: this.targetVP >= VP_MAX, pick: () => setVP(Math.min(VP_MAX, this.targetVP + 1)) },
        ]);
      paintVP();

      // Gameplay variants — toggle chips.
      const varRow = screen.querySelector("#variants")!;
      const paintVariants = (): void => {
        varRow.replaceChildren();
        const chip = (label: string, hint: string, on: boolean, send: (v: boolean) => void): void => {
          const b = el(`<button class="variant-chip ${on ? "on" : ""}" title="${hint}">${label}</button>`);
          b.addEventListener("click", () => { send(!on); paintVariants(); });
          varRow.appendChild(b);
        };
        chip("Hide Bank", "Hide the resource-bank counts", this.hideBank,
          (v) => { this.hideBank = v; net.send({ t: "setRoomConfig", hideBank: v }); });
        chip("Deck36 Dice", "Even dice distribution (deck of 36)", this.deck36Dice,
          (v) => { this.deck36Dice = v; net.send({ t: "setRoomConfig", deck36Dice: v }); });
        chip("Reserve Limit", "Reserve pile & bank are finite and can run dry (off = UNLIMITED resources)", this.reservePileLimit,
          (v) => { this.reservePileLimit = v; net.send({ t: "setRoomConfig", reservePileLimit: v }); });
      };

      // #15/#16 — map layout radio group (official / balanced / unbalanced),
      // each with a small description so players understand the difference.
      const layoutRow = screen.querySelector("#maplayout")!;
      const paintLayout = (): void => {
        layoutRow.replaceChildren();
        const layoutChip = (title: string, sub: string, mode: "official" | "balanced" | "unbalanced"): void => {
          const on = this.layout === mode;
          const b = el(
            `<button class="variant-chip layout-chip ${on ? "on" : ""}">` +
              `<span class="vc-title">${title}</span><span class="vc-sub">${sub}</span></button>`,
          );
          b.addEventListener("click", () => {
            this.layout = mode;
            net.send({ t: "setRoomConfig", layout: mode, balancedLayout: mode !== "unbalanced" });
            paintLayout();
          });
          layoutRow.appendChild(b);
        };
        layoutChip("Official", "The recommended board — same setup every game", "official");
        layoutChip("Balanced", "Random each game, fair (no 6 next to 8)", "balanced");
        layoutChip("Unbalanced", "Random each game, raw (6 can touch 8)", "unbalanced");
      };
      paintVariants();
      paintLayout();

      // Push the initial defaults so a brand-new room shows its settings.
      net.send({
        t: "setRoomConfig",
        fogMap: this.fogMap,
        turnSeconds: this.turnSeconds,
        targetVictoryPoints: this.targetVP,
        botSpeed: this.botSpeed,
        hideBank: this.hideBank,
        layout: this.layout,
        balancedLayout: this.layout !== "unbalanced",
        deck36Dice: this.deck36Dice,
        reservePileLimit: this.reservePileLimit,
        isPublic: this.hostPublic,
      });
    }

    const startBtn = screen.querySelector("#start") as HTMLElement | null;
    startBtn?.addEventListener("click", () => {
      shatter(startBtn, "#39d8c8", () =>
        net.send({
          t: "startGame",
          config: {
            playerCount: lobby.players.length,
            fogMap: this.fogMap,
            turnSeconds: this.turnSeconds,
            targetVictoryPoints: this.targetVP,
            botSpeed: this.botSpeed,
            hideBank: this.hideBank,
            layout: this.layout,
            balancedLayout: this.layout !== "unbalanced",
            deck36Dice: this.deck36Dice,
            reservePileLimit: this.reservePileLimit,
          },
        }),
      );
    });

    // Leave the room: drop our seat on the server, forget the saved session, and
    // return to the connect screen (or the main menu if a Back handler was given).
    screen.querySelector("#leave")?.addEventListener("click", () => {
      net.send({ t: "leaveRoom" });
      clearSession();
      this.lobby = null;
      if (this.onBack) this.onBack();
      else this.renderConnect();
    });

    this.root.replaceChildren(screen);
    this.fillInviteFriends(screen, lobby.roomCode);
  }

  /** AC2: list the signed-in player's friends with live online status and an
   *  Invite button (enabled only when they're online) that broadcasts the room
   *  code straight to that friend. */
  private fillInviteFriends(screen: HTMLElement, roomCode: string): void {
    const host = screen.querySelector("#invitefriends") as HTMLElement | null;
    if (!host) return;
    void listFriends().then((friends) => {
      const render = (): void => {
        if (!host.isConnected) return;
        host.replaceChildren();
        if (friends.length === 0) {
          host.appendChild(el(`<div class="fr-hint">No friends yet — add some from your profile.</div>`));
          return;
        }
        // Names already seated in this room — a friend who's joined can't be
        // invited again (we match on display name, the only identity the lobby
        // carries for a member).
        const inRoom = new Set(
          (this.lobby?.players ?? []).map((p) => p.name.trim().toLowerCase()),
        );
        for (const f of friends) {
          const on = presence.isOnline(f.user.id);
          const here = inRoom.has(f.user.displayName.trim().toLowerCase());
          const sent = this.invited.has(f.user.id);
          const label = here ? "In room" : sent ? "Invited ✓" : "Invite";
          const disabled = here || sent || !on;
          const row = el(`
            <div class="fr-row">
              <span class="pres-dot ${on ? "on" : ""}"></span>
              <span class="acct-avatar sm" style="--ac:${COLOR_HEX[f.user.favoriteColor] ?? "#4fa8ff"}">${escapeHtml(initials(f.user.displayName))}</span>
              <div class="fr-meta"><div class="fr-name">${escapeHtml(f.user.displayName)}</div><div class="fr-handle">${here ? "in this room" : on ? "online" : "offline"}</div></div>
              <div class="fr-actions"><button class="fr-btn add invite" ${disabled ? "disabled" : ""}>${label}</button></div>
            </div>`);
          const btn = row.querySelector(".invite") as HTMLButtonElement;
          if (!disabled) {
            btn.addEventListener("click", () => {
              if (this.invited.has(f.user.id) || inRoom.has(f.user.displayName.trim().toLowerCase())) return;
              this.invited.add(f.user.id);
              btn.disabled = true;
              btn.textContent = "Invited ✓";
              void presence.sendInvite(f.user.id, roomCode);
            });
          }
          host.appendChild(row);
        }
      };
      render();
      // Refresh the online dots live as friends come and go.
      this.presenceUnsub?.();
      this.presenceUnsub = presence.onChange(render);
    });
  }
}

