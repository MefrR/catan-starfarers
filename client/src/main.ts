import "./style.css";
import { Starfield } from "./render/starfield.js";
import { BoardRenderer } from "./render/board.js";
import { NewGameMenu, type LaunchOptions } from "./ui/menu.js";
import { HUD } from "./ui/hud.js";
import { LocalGame } from "./game/store.js";
import type { GameDriver } from "./game/store.js";

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

async function boot(): Promise<void> {
  const canvas = document.getElementById("board") as HTMLCanvasElement;
  const field = await Starfield.create(canvas);
  const board = new BoardRenderer(field.app);
  const app = document.getElementById("app")!;

  // Track the live game so a multiplayer "Play again" can tear it down cleanly
  // before the lobby (and then a fresh game) takes over again.
  let teardownGame: (() => void) | null = null;

  const mountGame = (game: GameDriver): void => {
    teardownGame?.();
    board.humanId = game.humanId;
    (window as unknown as { __sf: unknown }).__sf = { game, board };
    const unsubBoard = game.subscribe((state) => board.render(state));
    app.replaceChildren(); // clear the menu; HUD mounts its own overlay
    const hud = new HUD(app, game, board);
    // The canvas resizes to the window asynchronously; recenter once layout has
    // settled so the map is always centered regardless of window size.
    requestAnimationFrame(() => board.recenter());
    teardownGame = (): void => {
      unsubBoard();
      hud.destroy();
      teardownGame = null;
    };
  };

  const startSingle = (opts: LaunchOptions): void => {
    const game = new LocalGame(opts.seats, opts.config);
    mountGame(game);
  };

  // Multiplayer is lazy-loaded so the single-player path never opens a socket.
  // `mode` selects which server to talk to: "lan" (same host :3000) or "online"
  // (the public game server — see net.ts / VITE_ONLINE_URL).
  const startNetwork = async (mode: "lan" | "online"): Promise<void> => {
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
    );
  };

  const showLanding = (): void => {
    const screen = el(`
      <div class="screen">
        <div class="card">
          <h1 class="title">CATAN: STARFARERS</h1>
          <p class="subtitle">Voyage into deep space. Command your fleet to 15 victory points.</p>
          <button class="mt" id="single">Single Player</button>
          <button class="mt secondary" id="online">Play Online</button>
        </div>
      </div>
    `);
    screen.querySelector("#single")!.addEventListener("click", () => {
      new NewGameMenu(app, startSingle, showLanding);
    });
    screen.querySelector("#online")!.addEventListener("click", () => {
      void startNetwork("online");
    });
    app.replaceChildren(screen);
  };

  showLanding();
}

boot().catch((err) => {
  console.error("boot failed", err);
  document.getElementById("app")!.innerHTML =
    `<div class="screen"><div class="card"><h1 class="title">Boot error</h1><p class="subtitle">${String(err)}</p></div></div>`;
});
