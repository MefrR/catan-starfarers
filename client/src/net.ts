import { io, type Socket } from "socket.io-client";
import { type ClientIntent, type ServerMessage, SOCKET_EVENT } from "@starfarers/shared";

/** Which authoritative server the socket should talk to. */
export type NetMode = "lan" | "online";

/**
 * Resolve the server URL for a given mode.
 *
 * - **lan**: the server runs on the same host as the page, on port 3000 (the
 *   dev/LAN default). The Vite dev client lives on :5173, so we swap to :3000.
 * - **online**: a public, internet-reachable server. `VITE_ONLINE_URL` (set at
 *   build time) points at it (e.g. `https://play.designroom.studio`). If it's
 *   unset we assume the server also *serves this page* (single-service deploy),
 *   so we connect back to the page's own origin.
 */
export function serverUrlFor(mode: NetMode): string {
  if (mode === "online") {
    const override = import.meta.env.VITE_ONLINE_URL as string | undefined;
    return override && override.length > 0 ? override : location.origin;
  }
  return `${location.protocol}//${location.hostname}:3000`;
}

type Handler = (msg: ServerMessage) => void;

/**
 * Thin Socket.IO wrapper shared by the lobby and the network game driver.
 * The socket is opened lazily via `connect(mode)` so single-player never opens
 * a connection, and LAN vs Online can target different servers.
 */
class Net {
  private socket: Socket | null = null;
  private handlers = new Set<Handler>();
  private url = "";
  private connectedOnce = false;
  private keepAlive = 0;

  /** Open (or reuse) the socket for the chosen mode. Safe to call repeatedly. */
  connect(mode: NetMode): string {
    const url = serverUrlFor(mode);
    if (this.socket && this.url === url) return url;
    this.socket?.disconnect();
    this.url = url;
    this.connectedOnce = false;
    this.socket = io(url, { transports: ["websocket", "polling"] });
    // Keep-alive: a free hosting instance spins down after ~15 min of no inbound
    // HTTP traffic (WebSocket frames may not count). While we're connected, ping
    // /health every 4 min so the server stays warm for everyone in the room.
    window.clearInterval(this.keepAlive);
    this.keepAlive = window.setInterval(() => {
      fetch(`${url}/health`, { cache: "no-store" }).catch(() => {});
    }, 4 * 60 * 1000);
    this.socket.on(SOCKET_EVENT.message, (msg: ServerMessage) => {
      for (const h of this.handlers) h(msg);
    });
    // On a RE-connect (e.g. a phone's network blips mid-game), the server gives us
    // a brand-new socket id with no room mapping — every intent would then fail
    // with "Not in a room." and freeze the table. Re-attach automatically using
    // the saved session so play resumes seamlessly.
    this.socket.on("connect", () => {
      if (this.connectedOnce) {
        try {
          const raw = sessionStorage.getItem("sf_session");
          if (raw) {
            const s = JSON.parse(raw) as { roomCode: string; playerId: string };
            if (s?.roomCode && s?.playerId) {
              this.send({ t: "rejoin", roomCode: s.roomCode, playerId: s.playerId });
            }
          }
        } catch {
          /* ignore */
        }
      }
      this.connectedOnce = true;
    });
    return url;
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(intent: ClientIntent): void {
    this.socket?.emit(SOCKET_EVENT.intent, intent);
  }

  /** The URL of the currently-connected server (for display in the lobby). */
  get currentUrl(): string {
    return this.url;
  }
}

export const net = new Net();
