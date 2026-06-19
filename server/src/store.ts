/**
 * Durable persistence for in-progress online games (Supabase / PostgREST).
 *
 * Rooms live in server memory, but a restart — a redeploy, or a free-tier
 * instance spinning down after idle — would erase every active game. To let
 * players "continue after the server restarted", each room serialises itself to
 * a single `active_games` table and is reloaded on boot.
 *
 * No SDK: we talk to PostgREST directly with `fetch` (Node 18+ global) so the
 * bundled server gains no new dependency. The SERVICE ROLE key is required (the
 * table is server-only; never expose this key to the browser). If the env vars
 * are unset — LAN / local dev — every call is a harmless no-op, so the server
 * runs with zero configuration.
 *
 * Table (run the SQL in SUPABASE_SETUP.md):
 *   create table public.active_games (
 *     room_code text primary key,
 *     data jsonb not null,
 *     updated_at timestamptz not null default now()
 *   );
 *   alter table public.active_games enable row level security;  -- service key bypasses RLS
 */

const URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ENABLED = URL.length > 0 && SERVICE_KEY.length > 0;
const ENDPOINT = `${URL}/rest/v1/active_games`;

export const persistenceEnabled = ENABLED;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** Upsert one room snapshot. Swallows errors — persistence must never break play. */
export async function saveRoom(roomCode: string, data: unknown): Promise<void> {
  if (!ENABLED) return;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ room_code: roomCode, data, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) console.warn("[store] saveRoom", roomCode, res.status, await res.text());
  } catch (err) {
    console.warn("[store] saveRoom failed", roomCode, err);
  }
}

/** Delete one room snapshot (game over / abandoned). */
export async function deleteRoom(roomCode: string): Promise<void> {
  if (!ENABLED) return;
  try {
    await fetch(`${ENDPOINT}?room_code=eq.${encodeURIComponent(roomCode)}`, {
      method: "DELETE",
      headers: headers({ Prefer: "return=minimal" }),
    });
  } catch (err) {
    console.warn("[store] deleteRoom failed", roomCode, err);
  }
}

/** Load every persisted room snapshot on boot. Returns [] on any failure. */
export async function loadAllRooms(): Promise<unknown[]> {
  if (!ENABLED) return [];
  try {
    const res = await fetch(`${ENDPOINT}?select=data`, { headers: headers() });
    if (!res.ok) {
      console.warn("[store] loadAllRooms", res.status, await res.text());
      return [];
    }
    const rows = (await res.json()) as { data: unknown }[];
    return rows.map((r) => r.data);
  } catch (err) {
    console.warn("[store] loadAllRooms failed", err);
    return [];
  }
}
