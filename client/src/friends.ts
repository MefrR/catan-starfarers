import type { PlayerColor } from "@starfarers/shared";
import { auth } from "./auth.js";

/**
 * Friends layer (Supabase `friendships` table). Players find each other by
 * username, send/accept requests, and list friends. All functions no-op
 * gracefully when signed out / unconfigured.
 */

export interface FriendUser {
  id: string;
  username: string | null;
  displayName: string;
  favoriteColor: PlayerColor;
}

/** A friendship row paired with the OTHER party's profile. */
export interface FriendEdge {
  friendshipId: string;
  user: FriendUser;
}

const mapUser = (row: Record<string, unknown>): FriendUser => ({
  id: row.id as string,
  username: (row.username as string | null) ?? null,
  displayName: (row.display_name as string) || "Commander",
  favoriteColor: ((row.favorite_color as string) || "blue") as PlayerColor,
});

/** Fetch profiles for a set of user ids, keyed by id. */
async function fetchProfiles(ids: string[]): Promise<Map<string, FriendUser>> {
  const sb = auth.client();
  const out = new Map<string, FriendUser>();
  if (!sb || ids.length === 0) return out;
  const { data } = await sb
    .from("profiles")
    .select("id, username, display_name, favorite_color")
    .in("id", ids);
  for (const row of data ?? []) out.set(row.id as string, mapUser(row));
  return out;
}

/** Search profiles by username prefix (excludes yourself). */
export async function searchUsers(query: string): Promise<FriendUser[]> {
  const sb = auth.client();
  const me = auth.userId();
  const q = query.trim().replace(/[%_]/g, "");
  if (!sb || !me || q.length < 2) return [];
  const { data } = await sb
    .from("profiles")
    .select("id, username, display_name, favorite_color")
    .ilike("username", `${q}%`)
    .neq("id", me)
    .limit(10);
  return (data ?? []).map(mapUser);
}

/** Accepted friends, each paired with the other player's profile. */
export async function listFriends(): Promise<FriendEdge[]> {
  const sb = auth.client();
  const me = auth.userId();
  if (!sb || !me) return [];
  const { data } = await sb
    .from("friendships")
    .select("id, requester_id, addressee_id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${me},addressee_id.eq.${me}`);
  const rows = data ?? [];
  const otherId = (r: Record<string, unknown>): string =>
    (r.requester_id as string) === me ? (r.addressee_id as string) : (r.requester_id as string);
  const profiles = await fetchProfiles(rows.map(otherId));
  return rows
    .map((r) => ({ friendshipId: r.id as string, user: profiles.get(otherId(r)) }))
    .filter((e): e is FriendEdge => !!e.user)
    .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
}

/** Pending requests sent TO me (I can accept/decline). */
export async function listIncoming(): Promise<FriendEdge[]> {
  const sb = auth.client();
  const me = auth.userId();
  if (!sb || !me) return [];
  const { data } = await sb
    .from("friendships")
    .select("id, requester_id")
    .eq("status", "pending")
    .eq("addressee_id", me);
  const rows = data ?? [];
  const profiles = await fetchProfiles(rows.map((r) => r.requester_id as string));
  return rows
    .map((r) => ({ friendshipId: r.id as string, user: profiles.get(r.requester_id as string) }))
    .filter((e): e is FriendEdge => !!e.user);
}

/** Pending requests I've sent (awaiting their response). */
export async function listOutgoing(): Promise<FriendEdge[]> {
  const sb = auth.client();
  const me = auth.userId();
  if (!sb || !me) return [];
  const { data } = await sb
    .from("friendships")
    .select("id, addressee_id")
    .eq("status", "pending")
    .eq("requester_id", me);
  const rows = data ?? [];
  const profiles = await fetchProfiles(rows.map((r) => r.addressee_id as string));
  return rows
    .map((r) => ({ friendshipId: r.id as string, user: profiles.get(r.addressee_id as string) }))
    .filter((e): e is FriendEdge => !!e.user);
}

/** Send a friend request. If they already requested ME, accept that instead. */
export async function sendRequest(addresseeId: string): Promise<"sent" | "accepted" | "exists" | "error"> {
  const sb = auth.client();
  const me = auth.userId();
  if (!sb || !me || addresseeId === me) return "error";
  // Already a row in either direction?
  const { data: existing } = await sb
    .from("friendships")
    .select("id, requester_id, status")
    .or(
      `and(requester_id.eq.${me},addressee_id.eq.${addresseeId}),and(requester_id.eq.${addresseeId},addressee_id.eq.${me})`,
    )
    .maybeSingle();
  if (existing) {
    if (existing.status === "accepted") return "exists";
    // A pending request already exists. If THEY sent it to me, accept it.
    if ((existing.requester_id as string) === addresseeId) {
      await sb.from("friendships").update({ status: "accepted" }).eq("id", existing.id);
      return "accepted";
    }
    return "exists"; // I already sent one
  }
  const { error } = await sb.from("friendships").insert({ requester_id: me, addressee_id: addresseeId });
  return error ? "error" : "sent";
}

/** Accept a pending request addressed to me. */
export async function acceptRequest(friendshipId: string): Promise<void> {
  const sb = auth.client();
  if (!sb) return;
  await sb.from("friendships").update({ status: "accepted" }).eq("id", friendshipId);
}

/** Decline a request, cancel one I sent, or unfriend — all just delete the row. */
export async function removeFriendship(friendshipId: string): Promise<void> {
  const sb = auth.client();
  if (!sb) return;
  await sb.from("friendships").delete().eq("id", friendshipId);
}
