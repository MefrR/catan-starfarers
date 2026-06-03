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
};

/** The secret code that toggles dev mode (unlimited build + cards). */
const DEV_CODE = "warp9";

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
                 placeholder="Message…  (try a name then <3)" />
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
      if (!this.open) return;
      const t = e.target as Node;
      if (this.panel.contains(t) || this.toggle.contains(t)) return;
      this.setOpen(false);
    };
    document.addEventListener("pointerdown", this.outside, true);

    // Multiplayer: relay real chat between players. The server echoes every line
    // (including our own) so all clients render the same log; the unread dot only
    // lights for lines from someone else while the panel is shut.
    if (game.isMultiplayer) {
      this.offNet = net.on((msg) => {
        if (msg.t !== "chat") return;
        const mine = msg.fromId === this.game.humanId;
        this.append(msg.name, COLOR_HEX[msg.color] ?? "#cdd6f4", escapeHtml(msg.text), !mine);
      });
    }
  }

  /** Outside-click handler that closes the panel. */
  private outside: ((e: PointerEvent) => void) | null = null;
  /** Unsubscribe from network chat (multiplayer only). */
  private offNet: (() => void) | null = null;

  destroy(): void {
    this.replyTimers.forEach((t) => window.clearTimeout(t));
    this.replyTimers = [];
    if (this.outside) document.removeEventListener("pointerdown", this.outside, true);
    this.outside = null;
    this.offNet?.();
    this.offNet = null;
    this.toggle.remove();
    this.panel.remove();
    document.querySelectorAll(".heart-fx").forEach((n) => n.remove());
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

    // Dev-mode code.
    if (text.toLowerCase() === DEV_CODE || text.toLowerCase() === "/dev") {
      this.toggleDev();
      return;
    }

    // Heart code: "<name> <3"  (or a bare "<3").
    const heart = /^(.*?)\s*<3\s*$/.exec(text);
    if (heart) {
      const name = heart[1]!.trim();
      this.sendHearts(name);
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

  private toggleDev(): void {
    if (!this.game.setDevMode) {
      this.system("Dev mode is only available in single-player.");
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

  private sendHearts(name: string): void {
    this.spawnHearts();
    const target = this.findPlayer(name);
    if (name === "" ) {
      this.system(`💗 sent some love into the void.`);
    } else if (target) {
      this.append(
        this.me()?.name ?? "You",
        target.color in COLOR_HEX ? COLOR_HEX[target.color]! : "#ff6b9d",
        `❤ to <b>${escapeHtml(target.name)}</b>`,
      );
    } else {
      this.append(this.me()?.name ?? "You", "#ff6b9d", `❤ to <b>${escapeHtml(name)}</b>`);
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

  private findPlayer(name: string) {
    const n = name.toLowerCase();
    return this.game
      .getState()
      .players.find((p) => p.name.toLowerCase() === n || p.name.toLowerCase().includes(n));
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

  /** Big animated hearts floating up across the whole screen (F5). */
  private spawnHearts(): void {
    const fx = el(`<div class="heart-fx"></div>`);
    document.body.appendChild(fx);
    const N = 18;
    for (let i = 0; i < N; i++) {
      const h = el(`<span class="heart">❤</span>`);
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

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
