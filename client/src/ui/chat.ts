import type { GameDriver } from "../game/store.js";
import { net } from "../net.js";

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const COLOR_HEX: Record<string, string> = {
  yellow: "#ffd23f",
  red: "#ff5d5d",
  blue: "#4fa8ff",
  black: "#8a8fa6",
  green: "#52d273",
  white: "#e9eef7",
};

/** The secret code that toggles dev mode (unlimited build + cards). */
const DEV_CODE = "warp9";

/** Z5: one-tap table-banter reactions (multiplayer only). Sent as a marked
 *  chat line so the existing relay carries them with zero server changes. */
const EMOTES = ["👍", "😄", "😮", "🤔", "😈"];
const EMOTE_PREFIX = "::emote::";

/** Short canned lines an AI rival fires back so single-player chat feels alive
 *  (and demonstrates the unread-dot pulse when the panel is closed). */
const AI_LINES = [
  "Nice expansion, but the galaxy is mine.",
  "I'll beat you to that outpost.",
  "Watch your boosters, commander.",
  "Good move — for now.",
  "My fleet says hello.",
  "Don't get comfortable out there.",
];

/**
 * F2/F4/F5: a small toggle-able chat box pinned bottom-right.
 *  - Closed by default behind a chat icon; a pulsing dot appears on the icon
 *    when a message arrives while it's shut.
 *  - Typing the dev code (`warp9`) toggles unlimited build + cards for testing.
 *  - Typing "<name> <3" rains big animated hearts across the screen.
 * Lives at the document-body level so it survives the HUD's wholesale rerenders.
 */
export class ChatBox {
  private game: GameDriver;
  private toggle: HTMLElement;
  private dot: HTMLElement;
  private panel: HTMLElement;
  private log: HTMLElement;
  private input: HTMLInputElement;
  private open = false;
  private replyTimers: number[] = [];

  constructor(game: GameDriver) {
    this.game = game;

    this.toggle = el(`
      <button class="chat-toggle" title="Chat">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
          <path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z"/>
        </svg>
        <span class="chat-dot"></span>
      </button>`);
    this.dot = this.toggle.querySelector(".chat-dot") as HTMLElement;

    this.panel = el(`
      <div class="chat-panel">
        <div class="chat-head">
          <span>Comms</span>
          <button class="chat-close" title="Close">✕</button>
        </div>
        <div class="chat-log"></div>
        <form class="chat-form">
          <input class="chat-input" type="text" maxlength="120" autocomplete="off"
                 placeholder="Message…" />
          <button class="chat-send" type="submit" title="Send">➤</button>
        </form>
      </div>`);
    this.log = this.panel.querySelector(".chat-log") as HTMLElement;
    this.input = this.panel.querySelector(".chat-input") as HTMLInputElement;

    this.toggle.addEventListener("click", () => this.setOpen(!this.open));
    this.panel.querySelector(".chat-close")!.addEventListener("click", () => this.setOpen(false));
    this.panel.querySelector(".chat-form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });

    document.body.appendChild(this.toggle);
    document.body.appendChild(this.panel);

    // Clicking anywhere outside the open panel (and not on the toggle) closes it.
    this.outside = (e: PointerEvent) => {
      const t = e.target as Node;
      // Z5: clicking away also folds the emote strip.
      if (
        this.emoteStrip?.classList.contains("open") &&
        !this.emoteStrip.contains(t) &&
        !this.emoteToggle?.contains(t)
      ) {
        this.emoteStrip.classList.remove("open");
      }
      if (!this.open) return;
      if (this.panel.contains(t) || this.toggle.contains(t)) return;
      this.setOpen(false);
    };
    document.addEventListener("pointerdown", this.outside, true);

    // Z5: quick-emote strip (multiplayer only) — one-tap reactions that float
    // up from the sender's scoreboard row on EVERY player's screen.
    if (game.isMultiplayer) {
      this.emoteToggle = el(`<button class="emote-toggle" title="Quick reactions">😄</button>`);
      this.emoteStrip = el(
        `<div class="emote-strip">${EMOTES.map((e) => `<button class="emote-btn">${e}</button>`).join("")}</div>`,
      );
      this.emoteStrip.querySelectorAll(".emote-btn").forEach((b) => {
        b.addEventListener("click", () => {
          net.send({ t: "chat", text: EMOTE_PREFIX + b.textContent });
          this.emoteStrip!.classList.remove("open");
        });
      });
      this.emoteToggle.addEventListener("click", () =>
        this.emoteStrip!.classList.toggle("open"),
      );
      document.body.appendChild(this.emoteToggle);
      document.body.appendChild(this.emoteStrip);
    }

    // Multiplayer: relay real chat between players. The server echoes every line
    // (including our own) so all clients render the same log; the unread dot only
    // lights for lines from someone else while the panel is shut.
    if (game.isMultiplayer) {
      this.offNet = net.on((msg) => {
        if (msg.t !== "chat") return;
        const mine = msg.fromId === this.game.humanId;
        // Z5: a quick emote floats from the sender's scoreboard row — no log line.
        if (msg.text.startsWith(EMOTE_PREFIX)) {
          this.floatEmote(msg.fromId, msg.text.slice(EMOTE_PREFIX.length));
          return;
        }
        // A fling ("name <3", "ass to name", "shit to name") aimed at a player:
        // if it's addressed to ME, the emoji rains on MY screen. All see the line.
        const fling = parseFling(msg.text);
        if (fling) {
          const myName = (this.me()?.name ?? "").toLowerCase();
          const t = fling.target.toLowerCase();
          const forMe = t !== "" && (myName === t || myName.includes(t));
          if (forMe) this.spawnEmoji(fling.emoji);
          const label = fling.target ? `${fling.emoji} to <b>${escapeHtml(fling.target)}</b>` : fling.emoji;
          this.append(msg.name, COLOR_HEX[msg.color] ?? "#ff6b9d", label, !mine);
          return;
        }
        this.append(msg.name, COLOR_HEX[msg.color] ?? "#cdd6f4", escapeHtml(msg.text), !mine);
      });
    }
  }

  /** Outside-click handler that closes the panel. */
  private outside: ((e: PointerEvent) => void) | null = null;
  /** Unsubscribe from network chat (multiplayer only). */
  private offNet: (() => void) | null = null;
  /** Z5: quick-emote controls (multiplayer only). */
  private emoteToggle: HTMLElement | null = null;
  private emoteStrip: HTMLElement | null = null;

  destroy(): void {
    this.replyTimers.forEach((t) => window.clearTimeout(t));
    this.replyTimers = [];
    if (this.outside) document.removeEventListener("pointerdown", this.outside, true);
    this.outside = null;
    this.offNet?.();
    this.offNet = null;
    this.toggle.remove();
    this.panel.remove();
    this.emoteToggle?.remove();
    this.emoteStrip?.remove();
    document.querySelectorAll(".heart-fx, .emote-float").forEach((n) => n.remove());
  }

  /** Z5: float a reaction up from the sender's scoreboard row (falls back to
   *  bottom-center when the scoreboard is collapsed / the row isn't visible). */
  private floatEmote(fromId: string, emoji: string): void {
    const row = document.querySelector(`.score-row[data-pid="${fromId}"]`);
    const r = row?.getBoundingClientRect();
    const x = r ? r.left - 14 : window.innerWidth / 2;
    const y = r ? r.top + r.height / 2 : window.innerHeight - 160;
    const f = el(`<div class="emote-float"></div>`);
    f.textContent = emoji;
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
    document.body.appendChild(f);
    f.animate(
      [
        { transform: "translate(-100%, -50%) scale(0.4)", opacity: 0 },
        { transform: "translate(-100%, -90%) scale(1.5)", opacity: 1, offset: 0.25 },
        { transform: "translate(-100%, -340%) scale(1.1)", opacity: 0.9, offset: 0.8 },
        { transform: "translate(-100%, -420%) scale(0.9)", opacity: 0 },
      ],
      { duration: 2100, easing: "cubic-bezier(0.2, 0.8, 0.4, 1)" },
    ).onfinish = (): void => f.remove();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel.classList.toggle("open", open);
    this.toggle.classList.toggle("active", open);
    if (open) {
      this.dot.classList.remove("show");
      this.input.focus();
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";

    // Dev-mode toggle.
    if (text.toLowerCase() === DEV_CODE || text.toLowerCase() === "/dev") {
      this.toggleDev();
      return;
    }

    // Dev/testing slash-commands (single-player only).
    if (text.startsWith("/")) {
      if (this.runDevCommand(text)) return;
    }

    // Fling reaction: "<name> <3", "ass to <name>", "shit to <name>".
    const fling = parseFling(text);
    if (fling) {
      // Multiplayer: relay so the emoji rains on the NAMED player's screen (the
      // incoming handler spawns it for whoever it's addressed to). SP: local.
      if (this.game.isMultiplayer) net.send({ t: "chat", text });
      else this.flingLocal(fling);
      return;
    }

    // Multiplayer: send the line to the server, which echoes it back to everyone
    // (including us) — so we don't append locally and don't fire an AI reply.
    if (this.game.isMultiplayer) {
      net.send({ t: "chat", text });
      return;
    }

    // Single-player: append locally and let a rival AI fire back.
    const me = this.me();
    this.append(me?.name ?? "You", me ? COLOR_HEX[me.color] ?? "#fff" : "#fff", text);
    this.maybeAiReply();
  }

  /** Show a fling locally (single-player): rain the emoji + log who it's "to". */
  private flingLocal(f: { emoji: string; target: string }): void {
    this.spawnEmoji(f.emoji);
    const who = f.target ? `<b>${escapeHtml(f.target)}</b>` : "everyone";
    this.append(this.me()?.name ?? "You", "#ff6b9d", `${f.emoji} to ${who}`);
  }

  /**
   * Dev/testing chat codes (single-player). Returns true if the text was a dev
   * command (handled), false otherwise. `this.game.dev` is undefined online.
   */
  private runDevCommand(text: string): boolean {
    const [cmd, arg] = text.slice(1).trim().split(/\s+/, 2);
    const c = (cmd ?? "").toLowerCase();
    const known = ["help", "encounter", "enc", "upgrades", "friendship", "outpost", "jump", "vp", "reveal", "win"];
    if (!known.includes(c)) return false;

    if (c === "help") {
      this.system(
        "🛠️ <b>Dev codes</b> (single-player):<br>" +
          "<b>warp9</b> — unlimited resources &amp; supply<br>" +
          "<b>/encounter</b> — trigger the next encounter (1→32); <b>/encounter 12</b> — a specific card<br>" +
          "<b>/upgrades</b> — max boosters/cannons/pods<br>" +
          "<b>/friendship</b> (or /outpost) — grant one card of every civ<br>" +
          "<b>/jump</b> — grant a space jump<br>" +
          "<b>/vp 3</b> — add 3 victory points (<b>/win</b> = +14)<br>" +
          "<b>/reveal</b> — uncover the whole map<br>" +
          "Flings: <b>name &lt;3</b>, <b>ass to name</b>, <b>shit to name</b>",
      );
      return true;
    }

    const dev = this.game.dev;
    if (!dev) {
      this.system("Dev codes are single-player only.");
      return true;
    }
    switch (c) {
      case "encounter":
      case "enc": {
        const n = arg ? Math.max(1, Math.min(32, parseInt(arg, 10) || 1)) : ((this.devEncN % 32) + 1);
        if (!arg) this.devEncN++;
        dev.encounter(n);
        this.system(`🛠️ Forced encounter card #${n}.`);
        return true;
      }
      case "upgrades":
        dev.upgrades();
        this.system("🛠️ Mothership upgrades maxed.");
        return true;
      case "friendship":
      case "outpost":
        dev.friendship();
        this.system("🛠️ Granted one friendship card of every civ.");
        return true;
      case "jump":
        dev.spaceJump();
        this.system("🛠️ Space jump granted — fly during your flight phase.");
        return true;
      case "vp": {
        const n = Math.max(1, parseInt(arg ?? "1", 10) || 1);
        dev.vp(n);
        this.system(`🛠️ +${n} VP.`);
        return true;
      }
      case "win":
        dev.vp(14);
        this.system("🛠️ +14 VP — one good turn from winning.");
        return true;
      case "reveal":
        dev.reveal();
        this.system("🛠️ Whole map revealed.");
        return true;
    }
    return false;
  }

  /** Sequential counter for /encounter so each call shows the next card. */
  private devEncN = 0;

  private toggleDev(): void {
    if (!this.game.setDevMode) {
      // Online: no continuous top-up toggle, but grant a one-shot resource stack
      // so testing still has unlimited-ish supply.
      if (this.game.dev) {
        this.game.dev.resources();
        this.system("🛠️ Granted a big resource &amp; supply stack (online test grant).");
      } else {
        this.system("Dev mode is only available in single-player.");
      }
      return;
    }
    const now = !this.game.devMode;
    this.game.setDevMode(now);
    if (now) {
      this.system(
        `🛠️ <b>DEV MODE ON</b> — unlimited resources &amp; supply. Build freely; no discards on 7. Type <b>${DEV_CODE}</b> again to turn off.`,
      );
    } else {
      this.system(`Dev mode off.`);
    }
  }

  /** A random AI rival fires back a canned line shortly after the human speaks. */
  private maybeAiReply(): void {
    const ais = this.game.getState().players.filter((p) => p.id !== this.game.humanId);
    if (ais.length === 0) return;
    if (Math.random() > 0.55) return;
    const who = ais[Math.floor(Math.random() * ais.length)]!;
    const line = AI_LINES[Math.floor(Math.random() * AI_LINES.length)]!;
    const t = window.setTimeout(() => {
      this.append(who.name, COLOR_HEX[who.color] ?? "#fff", line, true);
    }, 700 + Math.random() * 900);
    this.replyTimers.push(t);
  }

  private me() {
    return this.game.getState().players.find((p) => p.id === this.game.humanId);
  }

  private append(from: string, color: string, html: string, incoming = false): void {
    const row = el(
      `<div class="chat-msg"><span class="cm-from" style="color:${color}">${escapeHtml(from)}</span><span class="cm-text">${html}</span></div>`,
    );
    this.log.appendChild(row);
    this.log.scrollTop = this.log.scrollHeight;
    // Unread pulse when a message arrives while the panel is closed.
    if (incoming && !this.open) this.dot.classList.add("show");
  }

  private system(html: string): void {
    const row = el(`<div class="chat-msg sys"><span class="cm-text">${html}</span></div>`);
    this.log.appendChild(row);
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Rain a big emoji up across the whole screen (hearts / fling reactions). */
  private spawnEmoji(emoji: string): void {
    const fx = el(`<div class="heart-fx"></div>`);
    document.body.appendChild(fx);
    const N = 18;
    for (let i = 0; i < N; i++) {
      const h = el(`<span class="heart"></span>`);
      h.textContent = emoji;
      const left = Math.random() * 100;
      const size = 28 + Math.random() * 56;
      const dur = 2.2 + Math.random() * 1.6;
      const delay = Math.random() * 0.6;
      const drift = (Math.random() * 2 - 1) * 80;
      h.style.left = `${left}vw`;
      h.style.fontSize = `${size}px`;
      h.style.setProperty("--dur", `${dur}s`);
      h.style.setProperty("--drift", `${drift}px`);
      h.style.animationDelay = `${delay}s`;
      fx.appendChild(h);
    }
    window.setTimeout(() => fx.remove(), 4200);
  }
}

/** Parse a "fling" chat line into an emoji + target name, or null.
 *  - "<name> <3"      → ❤
 *  - "ass to <name>"  → 🍑
 *  - "shit to <name>" → 💩 */
function parseFling(text: string): { emoji: string; target: string } | null {
  const heart = /^(.*?)\s*<3\s*$/.exec(text);
  if (heart) return { emoji: "❤", target: heart[1]!.trim() };
  const m = /^(ass|shit)\s+to\s+(.+)$/i.exec(text);
  if (m) return { emoji: m[1]!.toLowerCase() === "ass" ? "🍑" : "💩", target: m[2]!.trim() };
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
