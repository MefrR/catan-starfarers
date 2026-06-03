import { net, type NetMode } from "../net.js";
import { type GameState, type LobbyState, type PlayerColor, PLAYER_COLORS } from "@starfarers/shared";

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

  private renderConnect(): void {
    const screen = el(`
      <div class="screen">
        <div class="card">
          <h1 class="title">CATAN: STARFARERS</h1>
          <p class="subtitle">${this.mode === "online" ? "Voyage into deep space — play online with friends anywhere." : "Voyage into deep space — play across your LAN."}</p>
          <label>Your name</label>
          <input type="text" id="name" placeholder="Commander" maxlength="16" />
          <div class="row mt">
            <button id="host">Host a game</button>
          </div>
          <label class="mt">Join with a room code</label>
          <div class="row">
            <input type="text" id="code" placeholder="ABCD" maxlength="4" style="text-transform:uppercase" />
            <button class="secondary" id="join">Join</button>
          </div>
          <div class="error"></div>
          ${this.onBack ? `<button class="mt secondary" id="back">← Back</button>` : ""}
        </div>
      </div>
    `);
    const name = () => (screen.querySelector("#name") as HTMLInputElement).value.trim();
    screen.querySelector("#back")?.addEventListener("click", () => this.onBack?.());
    screen.querySelector("#host")!.addEventListener("click", () => {
      net.send({ t: "createRoom", name: name() });
    });
    screen.querySelector("#join")!.addEventListener("click", () => {
      const code = (screen.querySelector("#code") as HTMLInputElement).value.trim().toUpperCase();
      if (!code) { this.errorText = "Enter a room code."; this.renderError(); return; }
      net.send({ t: "joinRoom", roomCode: code, name: name() });
    });
    this.root.replaceChildren(screen);
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
        <div class="card">
          <h1 class="title">LOBBY</h1>
          <p class="subtitle">Waiting for Starfarers to assemble…</p>
          <div class="roomcode">${lobby.roomCode}</div>
          <div class="lan-url">${shareUrl}</div>
          <label class="mt">Crew (${lobby.players.length})</label>
          <ul class="players">
            ${lobby.players
              .map(
                (p) => `
              <li class="${p.connected ? "" : "offline"}">
                <span class="dot ${p.color}"></span>
                <span>${escapeHtml(p.name)}</span>
                <span class="badge">${p.isHost ? "HOST" : ""}${p.id === this.youId ? " · you" : ""}</span>
              </li>`,
              )
              .join("")}
          </ul>
          <label>Your color</label>
          <div class="row" id="colors"></div>
          ${isHost ? `<label class="mt">Map style</label><div class="row" id="mapstyle"></div>` : ""}
          ${isHost ? `<label class="mt">Turn timer</label><div class="row" id="turntimer"></div>` : ""}
          ${isHost ? `<button class="mt" id="start">Start game (${lobby.players.length} ${lobby.players.length === 1 ? "player" : "players"})</button>` : `<p class="subtitle mt">Waiting for the host to start…</p>`}
          <button class="mt secondary" id="leave">← Leave room</button>
          <div class="error">${this.errorText}</div>
        </div>
      </div>
    `);

    const colorsRow = screen.querySelector("#colors")!;
    const used = new Map(lobby.players.map((p) => [p.color, p.id] as const));
    for (const c of PLAYER_COLORS) {
      const taken = used.has(c) && used.get(c) !== this.youId;
      const btn = el(`<button class="secondary" ${taken ? "disabled" : ""} style="flex:0 0 auto;padding:8px"><span class="dot ${c}"></span></button>`);
      btn.addEventListener("click", () => net.send({ t: "setColor", color: c as PlayerColor }));
      colorsRow.appendChild(btn);
    }

    if (isHost) {
      const mapRow = screen.querySelector("#mapstyle")!;
      const paintMap = (): void => {
        mapRow.replaceChildren();
        const opts: { fog: boolean; label: string }[] = [
          { fog: false, label: "Charted" },
          { fog: true, label: "Uncharted (fog)" },
        ];
        for (const o of opts) {
          const sel = o.fog === this.fogMap;
          const b = el(
            `<button class="secondary" style="flex:1;${sel ? "outline:2px solid var(--accent);" : ""}">${o.label}</button>`,
          );
          b.addEventListener("click", () => { this.fogMap = o.fog; paintMap(); });
          mapRow.appendChild(b);
        }
      };
      paintMap();

      const timerRow = screen.querySelector("#turntimer")!;
      const paintTimer = (): void => {
        timerRow.replaceChildren();
        const off = el(`<button class="secondary" style="flex:0 0 auto;${this.turnSeconds === 0 ? "outline:2px solid var(--accent);" : ""}">Off</button>`);
        off.addEventListener("click", () => { this.turnSeconds = 0; paintTimer(); });
        const minus = el(`<button class="secondary" style="flex:0 0 auto" ${this.turnSeconds <= 15 ? "disabled" : ""}>−5s</button>`);
        minus.addEventListener("click", () => { this.turnSeconds = Math.max(15, this.turnSeconds - 5); paintTimer(); });
        const val = el(`<button class="secondary" style="flex:1" disabled>${this.turnSeconds === 0 ? "No limit" : this.turnSeconds + "s per turn"}</button>`);
        const plus = el(`<button class="secondary" style="flex:0 0 auto" ${this.turnSeconds >= 180 ? "disabled" : ""}>+5s</button>`);
        plus.addEventListener("click", () => { this.turnSeconds = this.turnSeconds === 0 ? 15 : Math.min(180, this.turnSeconds + 5); paintTimer(); });
        timerRow.append(off, minus, val, plus);
      };
      paintTimer();
    }

    screen.querySelector("#start")?.addEventListener("click", () => {
      net.send({
        t: "startGame",
        config: { playerCount: lobby.players.length, fogMap: this.fogMap, turnSeconds: this.turnSeconds },
      });
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
