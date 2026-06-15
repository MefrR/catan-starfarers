import type { RealtimeChannel } from "@supabase/supabase-js";
import { auth } from "./auth.js";

/**
 * Online presence + direct invites over Supabase Realtime — always-on and
 * independent of the (sleepy) game server.
 *
 *  - Every signed-in player joins a shared "online" presence channel, so anyone
 *    can tell which of their friends are currently online.
 *  - Each player also listens on a private `invite-<theirId>` channel; another
 *    player can broadcast a room invite straight to it.
 *
 * Auto-starts on sign-in and tears down on sign-out. No-ops when unconfigured.
 */

export interface RoomInvite {
  roomCode: string;
  fromName: string;
  fromId: string;
}

class Presence {
  private channel: RealtimeChannel | null = null;
  private inbox: RealtimeChannel | null = null;
  private online = new Set<string>();
  private changeListeners = new Set<() => void>();
  private inviteListeners = new Set<(inv: RoomInvite) => void>();
  private startedFor: string | null = null;

  constructor() {
    // React to auth: start when a user signs in, stop when they sign out.
    auth.onChange((p) => {
      if (p && p.id !== this.startedFor) this.start();
      else if (!p) this.stop();
    });
  }

  private start(): void {
    const sb = auth.client();
    const me = auth.userId();
    if (!sb || !me) return;
    this.stop();
    this.startedFor = me;

    this.channel = sb.channel("online", { config: { presence: { key: me } } });
    this.channel
      .on("presence", { event: "sync" }, () => {
        const state = this.channel!.presenceState();
        this.online = new Set(Object.keys(state));
        for (const l of this.changeListeners) l();
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void this.channel!.track({ at: Date.now() });
      });

    this.inbox = sb.channel(`invite-${me}`);
    this.inbox
      .on("broadcast", { event: "invite" }, (msg) => {
        const inv = msg.payload as RoomInvite;
        if (inv?.roomCode) for (const l of this.inviteListeners) l(inv);
      })
      .subscribe();
  }

  private stop(): void {
    const sb = auth.client();
    if (sb) {
      if (this.channel) void sb.removeChannel(this.channel);
      if (this.inbox) void sb.removeChannel(this.inbox);
    }
    this.channel = null;
    this.inbox = null;
    this.online.clear();
    this.startedFor = null;
    for (const l of this.changeListeners) l();
  }

  isOnline(userId: string): boolean {
    return this.online.has(userId);
  }

  /** Subscribe to presence changes (online set updated). */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** Subscribe to incoming room invites (fires app-wide while signed in). */
  onInvite(fn: (inv: RoomInvite) => void): () => void {
    this.inviteListeners.add(fn);
    return () => this.inviteListeners.delete(fn);
  }

  /** Broadcast a room invite to a specific user's private inbox channel. */
  async sendInvite(toUserId: string, roomCode: string): Promise<void> {
    const sb = auth.client();
    const me = auth.currentProfile();
    if (!sb || !me) return;
    const payload: RoomInvite = { roomCode, fromName: me.displayName, fromId: me.id };
    const ch = sb.channel(`invite-${toUserId}`);
    await new Promise<void>((resolve) => {
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") resolve();
      });
      setTimeout(resolve, 1500); // don't hang if the channel never confirms
    });
    await ch.send({ type: "broadcast", event: "invite", payload });
    setTimeout(() => void sb.removeChannel(ch), 1000);
  }
}

export const presence = new Presence();
