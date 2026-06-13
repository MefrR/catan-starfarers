import { net, type NetMode } from "../net.js";
import { type GameState, type LobbyState, type PlayerColor, PLAYER_COLORS } from "@starfarers/shared";
import { shatter } from "./fx.js";
import { auth } from "../auth.js";

const COLOR_HEX: Record<PlayerColor, string> = {
  yellow: "#ffd23f",
  red: "#ff5d5d",
  blue: "#4fa8ff",
  black: "#8a8fa6",
  green: "#52d273",
  white: "#e9eef7",
};

type StartHandler = (state: GameState, youId: string) => void;

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const SESSION_KEY = "sf_session";

interface SavedSession {
  roomCode: string;
  playerId: string;
}

function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}

function saveSession(s: SavedSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export class LobbyUI {
  private root: HTMLElement;
  private youId = "";
  private lobby: LobbyState | null = null;
  private errorText = "";
  private rejoining = false;
  private fogMap = false;
  private turnSeconds = 0; // host-chosen per-turn timer (0 = off)
  private onStart: StartHandler | undefined;
  private onBack: (() => void) | undefined;
  private onReset: (() => void) | undefined;
  private started = false;
  private mode: NetMode;
  /** AB4: apply the signed-in favorite color once, when it's free. */
  private appliedFavColor = false;

  constructor(
    mount: HTMLElement,
    onStart?: StartHandler,
    onBack?: () => void,
    onReset?: () => void,
    mode: NetMode = "lan",
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
          this.onStart?.(msg.state, msg.youId);
        }
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
          // Stale saved session — fall back to the connect screen.
          this.rejoining = false;
          clearSession();
          this.renderConnect();
          return;
        }
        this.errorText = msg.message;
        this.renderError();
      }
    });

    const saved = loadSession();
    if (saved) {
      this.rejoining = true;
      net.send({ t: "rejoin", roomCode: saved.roomCode, playerId: saved.playerId });
    } else {
      this.renderConnect();
    }
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

          <div class="setup-row">
            <div class="setup-label">Commander</div>
            <div class="setup-ctrl">
              <input type="text" id="name" class="setup-name" placeholder="Commander" maxlength="16" />
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Join a room</div>
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
    // AB4: prefill the commander name from the signed-in profile.
    const profile = auth.currentProfile();
    if (profile) (screen.querySelector("#name") as HTMLInputElement).value = profile.displayName;
    screen.querySelector("#back")?.addEventListener("click", () => this.onBack?.());
    const hostBtn = screen.querySelector("#host") as HTMLElement;
    hostBtn.addEventListener("click", () => {
      shatter(hostBtn, "#39d8c8", () => net.send({ t: "createRoom", name: name() }));
    });
    screen.querySelector("#join")!.addEventListener("click", () => {
      const code = (screen.querySelector("#code") as HTMLInputElement).value.trim().toUpperCase();
      if (!code) { this.errorText = "Enter a room code."; this.renderError(); return; }
      net.send({ t: "joinRoom", roomCode: code, name: name() });
    });
    this.root.replaceChildren(screen);
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

  private renderLobby(): void {
    const lobby = this.lobby!;
    const me = lobby.players.find((p) => p.id === this.youId);
    const isHost = !!me?.isHost;
    // The link other players open to join: online players load this very site;
    // LAN players load the host's server URL.
    const shareUrl = this.mode === "online" ? location.origin : net.currentUrl;

    const screen = el(`
      <div class="screen">
        <div class="setup">
          <div class="setup-head">
            <div class="setup-kicker">Room code — share it with your crew</div>
            <h1 class="setup-title roomcode-title">${lobby.roomCode}</h1>
            <div class="lan-url">${shareUrl}</div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Crew (${lobby.players.length})</div>
            <div class="setup-ctrl setup-crew">
              <ul class="players">
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
              ${isHost && lobby.players.length < 4 ? `<div class="seg"><button class="seg-opt" id="addai">+ Add AI opponent</button></div>` : ""}
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Your color</div>
            <div class="setup-ctrl"><div class="swatches" id="colors"></div></div>
          </div>

          ${isHost ? `
          <div class="setup-row">
            <div class="setup-label">Galaxy</div>
            <div class="setup-ctrl"><div class="seg seg-wide" id="mapstyle"></div></div>
          </div>
          <div class="setup-row">
            <div class="setup-label">Turn timer</div>
            <div class="setup-ctrl"><div class="seg" id="turntimer"></div></div>
          </div>` : ""}

          <div class="setup-launch">
            ${isHost
              ? `<div class="glow-wrap">
                   <div class="glow-layer glow-far"><i></i></div>
                   <div class="glow-layer glow-near"><i></i></div>
                   <button class="glow-btn" id="start">START GAME · ${lobby.players.length} ${lobby.players.length === 1 ? "PLAYER" : "PLAYERS"}</button>
                 </div>`
              : `<p class="sp-sub">Waiting for the host to start…</p>`}
            <div class="error">${this.errorText}</div>
            <button class="setup-back" id="leave">← Leave room</button>
          </div>
        </div>
      </div>
    `);

    // Color swatches: round orbs like the single-player menu; taken colors dim.
    const colorsRow = screen.querySelector("#colors")!;
    const used = new Map(lobby.players.map((p) => [p.color, p.id] as const));
    for (const c of PLAYER_COLORS) {
      const taken = used.has(c) && used.get(c) !== this.youId;
      const mine = me?.color === c;
      const btn = el(
        `<button class="swatch ${mine ? "selected" : ""}" ${taken ? "disabled" : ""} title="${taken ? "Taken" : c}" style="--sw:${COLOR_HEX[c]};${taken ? "opacity:0.3;cursor:not-allowed" : ""}"></button>`,
      );
      if (!taken) btn.addEventListener("click", () => net.send({ t: "setColor", color: c as PlayerColor }));
      colorsRow.appendChild(btn);
    }

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
      const mapRow = screen.querySelector("#mapstyle")!;
      const paintMap = (): void =>
        seg(mapRow, [
          { label: "Charted", hint: "Whole galaxy visible", selected: !this.fogMap, pick: () => { this.fogMap = false; paintMap(); } },
          { label: "Uncharted", hint: "Fog — explore to reveal", selected: this.fogMap, pick: () => { this.fogMap = true; paintMap(); } },
        ]);
      paintMap();

      const timerRow = screen.querySelector("#turntimer")!;
      const paintTimer = (): void =>
        seg(timerRow, [
          { label: "Off", selected: this.turnSeconds === 0, pick: () => { this.turnSeconds = 0; paintTimer(); } },
          { label: "−5s", disabled: this.turnSeconds <= 15, pick: () => { this.turnSeconds = Math.max(15, this.turnSeconds - 5); paintTimer(); } },
          { label: this.turnSeconds === 0 ? "No limit" : `${this.turnSeconds}s / turn` },
          { label: "+5s", disabled: this.turnSeconds >= 180, pick: () => { this.turnSeconds = this.turnSeconds === 0 ? 15 : Math.min(180, this.turnSeconds + 5); paintTimer(); } },
        ]);
      paintTimer();
    }

    screen.querySelector("#addai")?.addEventListener("click", () => net.send({ t: "addAi" }));
    screen.querySelectorAll(".ai-remove").forEach((b) =>
      b.addEventListener("click", () =>
        net.send({ t: "removeAi", id: (b as HTMLElement).dataset.id! }),
      ),
    );

    const startBtn = screen.querySelector("#start") as HTMLElement | null;
    startBtn?.addEventListener("click", () => {
      shatter(startBtn, "#39d8c8", () =>
        net.send({
          t: "startGame",
          config: { playerCount: lobby.players.length, fogMap: this.fogMap, turnSeconds: this.turnSeconds },
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
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
