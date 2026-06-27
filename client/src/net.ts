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

/** Live connection health, surfaced as a small on-screen pill while degraded. */
export type NetStatus = "connected" | "reconnecting" | "offline";
type StatusHandler = (status: NetStatus) => void;

/**
 * Thin Socket.IO wrapper shared by the lobby and the network game driver.
 * The socket is opened lazily via `connect(mode)` so single-player never opens
 * a connection, and LAN vs Online can target different servers.
 *
 * Robustness: auto-reconnect with backoff, automatic room re-attach with a fresh
 * state resync (the server re-broadcasts on rejoin), resync when a backgrounded
 * tab comes back to the foreground, and a self-contained "Reconnecting…" pill so
 * a degraded link is always visible instead of a silently frozen table.
 */
class Net {
  private socket: Socket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<StatusHandler>();
  private url = "";
  private connectedOnce = false;
  private keepAlive = 0;
  private _status: NetStatus = "connected";
  private pill: HTMLDivElement | null = null;

  /** Open (or reuse) the socket for the chosen mode. Safe to call repeatedly. */
  connect(mode: NetMode): string {
    const url = serverUrlFor(mode);
    if (this.socket && this.url === url) return url;
    this.socket?.disconnect();
    this.url = url;
    this.connectedOnce = false;
    this.socket = io(url, {
      transports: ["websocket", "polling"],
      // Snappy, bounded reconnect: first retry fast, back off to 4s, keep trying
      // forever (the free-tier server may take ~30s to spin back up from sleep).
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 4000,
      timeout: 12000,
    });
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
    // the saved session so play resumes seamlessly (the server replies with a
    // fresh lobby + state broadcast, which doubles as a full resync).
    this.socket.on("connect", () => {
      if (this.connectedOnce) this.resync();
      this.connectedOnce = true;
      this.setStatus("connected");
    });
    this.socket.on("disconnect", (reason: string) => {
      this.setStatus("reconnecting");
      // Socket.IO auto-reconnects on a transport drop, but NOT when the server
      // itself closes the connection (reason "io server disconnect") — which is
      // exactly what a free-tier box does when it restarts / OOMs. Kick off a
      // manual reconnect so players never have to refresh the page after that.
      if (reason === "io server disconnect") {
        window.setTimeout(() => this.socket?.connect(), 500);
      }
    });
    this.socket.io.on("reconnect_attempt", () => this.setStatus("reconnecting"));
    this.socket.io.on("reconnect_failed", () => this.setStatus("offline"));
    // A tab that slept in the background may hold a stale state (broadcasts can
    // be dropped while timers are throttled). When it returns to the foreground,
    // re-attach to pull the authoritative latest state.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.socket?.connected) this.resync();
    });
    return url;
  }

  /** Re-attach to the saved room — the server answers with fresh lobby + state.
   *  Stored in localStorage so it survives a full browser restart, letting the
   *  player return to an in-progress online game. */
  private resync(): void {
    try {
      const raw = localStorage.getItem("sf_session");
      if (!raw) return;
      const s = JSON.parse(raw) as { roomCode: string; playerId: string };
      if (s?.roomCode && s?.playerId) {
        this.send({ t: "rejoin", roomCode: s.roomCode, playerId: s.playerId });
      }
    } catch {
      /* ignore */
    }
  }

  private setStatus(status: NetStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const h of this.statusHandlers) h(status);
    this.syncPill();
  }

  /** Self-contained status pill (bottom-left) shown while the link is degraded. */
  private syncPill(): void {
    if (this._status === "connected") {
      this.pill?.classList.remove("show");
      return;
    }
    if (!this.pill) {
      this.pill = document.createElement("div");
      this.pill.className = "net-pill";
      document.body.appendChild(this.pill);
    }
    this.pill.innerHTML =
      this._status === "reconnecting"
        ? `<span class="net-dot pulse"></span>Reconnecting…`
        : `<span class="net-dot dead"></span>Connection lost — check your network`;
    this.pill.classList.add("show");
  }

  get status(): NetStatus {
    return this._status;
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Subscribe to connection-health changes (e.g. to pause local timers). */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
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
