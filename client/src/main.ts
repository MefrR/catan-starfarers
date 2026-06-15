import "./style.css";
import { Starfield } from "./render/starfield.js";
import { CometField } from "./render/comets.js";
import { shatter } from "./ui/fx.js";
import { BoardRenderer } from "./render/board.js";
import { NewGameMenu, type LaunchOptions } from "./ui/menu.js";
import { HUD } from "./ui/hud.js";
import { TutorialDriver } from "./ui/tutorial.js";
import { mountAccountChip } from "./ui/account.js";
import { auth } from "./auth.js";
import { presence, type RoomInvite } from "./presence.js";
import { recordLocalGame, recordOnlineGame } from "./social.js";
import { LocalGame } from "./game/store.js";
import type { GameDriver, Seat } from "./game/store.js";

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function boot(): Promise<void> {
  const canvas = document.getElementById("board") as HTMLCanvasElement;
  const field = await Starfield.create(canvas);
  const board = new BoardRenderer(field.app);
  const app = document.getElementById("app")!;

  // Track the live game so a multiplayer "Play again" can tear it down cleanly
  // before the lobby (and then a fresh game) takes over again.
  let teardownGame: (() => void) | null = null;

  // The comet-streak backdrop lives behind EVERY menu screen (landing, the
  // single-player setup, the lobby) and is torn down when a game mounts.
  let menuBg: CometField | null = null;
  const ensureMenuBg = (): void => {
    if (!menuBg) menuBg = new CometField();
  };
  const dropMenuBg = (): void => {
    menuBg?.destroy();
    menuBg = null;
  };

  const mountGame = (game: GameDriver, opts: { tutorial?: boolean } = {}): void => {
    // Mount straight into the game (no warp transition — it tested poorly).
    teardownGame?.();
    dropMenuBg();
    board.humanId = game.humanId;
    (window as unknown as { __sf: unknown }).__sf = { game, board };
    const unsubBoard = game.subscribe((state) => board.render(state));
    // Accounts: record results to the signed-in profile when a game ends
    // (best-effort, no-ops when signed out). Online games are recorded by each
    // human client writing its own result row; single-player records the human.
    const unsubRecord = game.subscribe((state) => {
      if (state.phaseState.phase !== "gameOver") return;
      if (game.isMultiplayer) void recordOnlineGame(state, game.humanId);
      else void recordLocalGame(state, game.humanId);
    });
    app.replaceChildren(); // clear the menu; HUD mounts its own overlay
    const hud = new HUD(app, game, board);
    // Z6: the guided first game attaches its coach bubble over the live HUD.
    const tut = opts.tutorial ? new TutorialDriver(game, board) : null;
    // The canvas resizes to the window asynchronously; recenter once layout
    // has settled so the map is always centered regardless of window size.
    requestAnimationFrame(() => board.recenter());
    teardownGame = (): void => {
      tut?.destroy();
      unsubBoard();
      unsubRecord();
      hud.destroy();
      teardownGame = null;
    };
  };

  const startSingle = (opts: LaunchOptions): void => {
    const game = new LocalGame(opts.seats, opts.config);
    mountGame(game);
  };

  // Z6: the guided first game — a fixed friendly setup (you vs one easy rival,
  // fully charted map) with the coach bubble walking the opening turns.
  const startTutorial = (): void => {
    const seats: Seat[] = [
      {
        member: { id: crypto.randomUUID(), name: "Commander", color: "yellow", connected: true },
        isAI: false,
      },
      {
        member: { id: crypto.randomUUID(), name: "Orion (Blue)", color: "blue", connected: true },
        isAI: true,
      },
    ];
    const game = new LocalGame(seats, { aiDifficulty: "easy", fogMap: false });
    mountGame(game, { tutorial: true });
  };

  // Multiplayer is lazy-loaded so the single-player path never opens a socket.
  // `mode` selects which server to talk to: "lan" (same host :3000) or "online"
  // (the public game server — see net.ts / VITE_ONLINE_URL).
  const startNetwork = async (mode: "lan" | "online", autoJoinCode?: string): Promise<void> => {
    const { LobbyUI } = await import("./ui/lobby.js");
    const { NetworkGame } = await import("./game/netgame.js");
    const { net } = await import("./net.js");
    net.connect(mode); // open the socket BEFORE the lobby starts sending intents
    new LobbyUI(
      app,
      (state, youId) => {
        mountGame(new NetworkGame(state, youId));
      },
      showLanding,
      () => teardownGame?.(),
      mode,
      autoJoinCode,
    );
  };

  // AC2: a friend's room invite can arrive on ANY screen while signed in.
  // Show a dismissible prompt; "Join" connects online and drops into their room.
  presence.onInvite((inv: RoomInvite) => {
    document.querySelector(".invite-pop")?.remove();
    const pop = el(`
      <div class="invite-pop">
        <div class="invite-text"><b>${escapeHtml(inv.fromName)}</b> invited you to a game.</div>
        <div class="invite-actions">
          <button class="invite-join">Join</button>
          <button class="invite-dismiss secondary">Dismiss</button>
        </div>
      </div>`);
    pop.querySelector(".invite-join")!.addEventListener("click", () => {
      pop.remove();
      void startNetwork("online", inv.roomCode);
    });
    pop.querySelector(".invite-dismiss")!.addEventListener("click", () => pop.remove());
    document.body.appendChild(pop);
    requestAnimationFrame(() => pop.classList.add("show"));
    window.setTimeout(() => pop.remove(), 30000); // auto-expire stale invites
  });

  const showLanding = (): void => {
    // Hero landing: no boxed card — the title and pills float directly over
    // the comet field, like the referenced hero design.
    const saved = LocalGame.savedGame();
    const resumeHtml = saved
      ? `<button class="hero-resume" id="resume">
           <span class="hero-resume-title">Resume Voyage</span>
           <span class="hero-resume-sub">${saved.myVp}/${saved.target} VP vs ${saved.rivals.join(", ")}</span>
         </button>`
      : "";
    const screen = el(`
      <div class="screen">
        <div class="hero">
          <div class="hero-badge">A faithful digital voyage · 2–4 commanders</div>
          <h1 class="hero-title"><span>CATAN</span><span class="hero-title-2">STARFARERS</span></h1>
          <p class="hero-sub">Voyage into deep space. Command your fleet to 15 victory points.</p>
          <div class="hero-actions">
            <button id="single">Single Player</button>
            <button class="secondary" id="online">Play Online</button>
          </div>
          ${resumeHtml}
          <button class="hero-tutorial" id="tutorial">✦ First flight? Take the guided tutorial</button>
        </div>
      </div>
    `);
    const single = screen.querySelector("#single") as HTMLElement;
    single.addEventListener("click", () => {
      ensureMenuBg();
      shatter(single, "#5b8cff", () => new NewGameMenu(app, startSingle, showLanding));
    });
    const online = screen.querySelector("#online") as HTMLElement;
    online.addEventListener("click", () => {
      ensureMenuBg();
      shatter(online, "#39d8c8", () => void startNetwork("online"));
    });
    const tutorial = screen.querySelector("#tutorial") as HTMLElement;
    tutorial.addEventListener("click", () => {
      ensureMenuBg();
      shatter(tutorial, "#ffd23f", () => startTutorial());
    });
    const resume = screen.querySelector("#resume") as HTMLElement | null;
    resume?.addEventListener("click", () => {
      const game = LocalGame.resume();
      if (!game) {
        resume.remove(); // slot vanished/corrupt — drop the button quietly
        return;
      }
      shatter(resume, "#ffd23f", () => mountGame(game));
    });
    // Account chip (top-right) — sign-in / profile. Renders nothing when
    // Supabase isn't configured, so the hero is unchanged until accounts exist.
    mountAccountChip(screen);
    ensureMenuBg();
    app.replaceChildren(screen);
  };

  // Resolve any existing session (and consume an OAuth redirect) before the
  // first paint, so the account chip + menu prefills show the right state.
  await auth.whenReady();
  showLanding();
}

boot().catch((err) => {
  console.error("boot failed", err);
  document.getElementById("app")!.innerHTML =
    `<div class="screen"><div class="card"><h1 class="title">Boot error</h1><p class="subtitle">${String(err)}</p></div></div>`;
});
