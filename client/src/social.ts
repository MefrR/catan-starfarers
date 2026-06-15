import type { GameState, PlayerColor } from "@starfarers/shared";
import { auth } from "./auth.js";

/**
 * Stats & history layer (Supabase). Records finished games and reads a player's
 * win/loss record + history. Single-player games are recorded by the local
 * client (the signed-in human writes their own result); multiplayer recording
 * is written server-side later. Everything no-ops cleanly when signed out.
 */

/** A per-player line in a recorded game's snapshot. */
export interface GamePlayerSnap {
  name: string;
  color: PlayerColor;
  vp: number;
  placement: number;
  isAi: boolean;
  userId: string | null;
  resources: number;
  encounters: number;
  pirates: number;
  ice: number;
  trades: number;
  distance: number;
}

export interface StatsSummary {
  games: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  bestVp: number;
}

export interface HistoryEntry {
  gameId: string;
  playedAt: string;
  result: "win" | "loss";
  placement: number;
  finalVp: number;
  vsAi: boolean;
  winnerName: string;
  winnerColor: PlayerColor;
  targetVp: number;
  players: GamePlayerSnap[];
}

/** Avoid double-recording the same in-engine game within a session. */
const recorded = new Set<string>();

/**
 * Record a finished SINGLE-PLAYER game for the signed-in human (every rival is
 * an AI). Best-effort: never throws into the game, no-ops when signed out.
 */
export async function recordLocalGame(state: GameState, humanId: string): Promise<void> {
  return recordGame(state, humanId, { vsAi: true, isAi: (id) => id !== humanId });
}

/**
 * Record a finished ONLINE game for the signed-in human. Each human client
 * records its OWN result row, so every account's history gets the game. The
 * shared game snapshot is inserted once (the first client wins the unique
 * client_game_id; the rest read the existing row back). We can't tell AI seats
 * apart from the shared state, so rivals are treated as human.
 */
export async function recordOnlineGame(state: GameState, humanId: string): Promise<void> {
  return recordGame(state, humanId, { vsAi: false, isAi: () => false });
}

/** Shared recorder for both single-player and online finished games. */
async function recordGame(
  state: GameState,
  humanId: string,
  opts: { vsAi: boolean; isAi: (playerId: string) => boolean },
): Promise<void> {
  try {
    const sb = auth.client();
    const me = auth.userId();
    if (!sb || !me) return;
    if (state.phaseState.phase !== "gameOver") return;
    if (recorded.has(state.id)) return;
    recorded.add(state.id);

    const stats = state.stats;
    const ranked = [...state.players].sort((a, b) => b.victoryPoints - a.victoryPoints);
    const placementOf = (id: string): number => ranked.findIndex((p) => p.id === id) + 1;
    const winner = state.players.find((p) => p.id === state.phaseState.winner) ?? ranked[0];

    const snaps: GamePlayerSnap[] = state.players.map((p) => ({
      name: p.name,
      color: p.color,
      vp: p.victoryPoints,
      placement: placementOf(p.id),
      isAi: opts.isAi(p.id),
      userId: p.id === humanId ? me : null,
      resources: stats?.resourcesGained[p.id] ?? 0,
      encounters: stats?.encountersFaced[p.id] ?? 0,
      pirates: stats?.piratesDefeated[p.id] ?? 0,
      ice: stats?.icePlanetsTerraformed[p.id] ?? 0,
      trades: stats?.tradesCompleted[p.id] ?? 0,
      distance: stats?.distanceFlown[p.id] ?? 0,
    }));

    const myPlacement = placementOf(humanId);
    const myVp = state.players.find((p) => p.id === humanId)?.victoryPoints ?? 0;

    // Insert the shared snapshot. In online games several clients attempt this;
    // only the first succeeds (client_game_id is unique). A duplicate error is
    // expected and ignored — we read the existing row back next.
    await sb
      .from("games")
      .insert({
        client_game_id: state.id,
        recorder_id: me,
        target_vp: state.config.targetVictoryPoints,
        vs_ai: opts.vsAi,
        winner_name: winner?.name ?? "",
        winner_color: winner?.color ?? "blue",
        players: snaps,
      });

    // Find the game row (whether this client inserted it or another did).
    const { data: game } = await sb
      .from("games")
      .select("id")
      .eq("client_game_id", state.id)
      .single();
    if (!game) return;

    await sb.from("game_players").insert({
      game_id: game.id,
      user_id: me,
      result: state.phaseState.winner === humanId ? "win" : "loss",
      placement: myPlacement,
      final_vp: myVp,
    });
  } catch {
    /* stats are best-effort — never disrupt the game */
  }
}

/** Aggregate a player's win/loss record. Null when signed out / unconfigured. */
async function fetchStats(userId: string | null): Promise<StatsSummary | null> {
  const sb = auth.client();
  if (!sb || !userId) return null;
  const { data, error } = await sb
    .from("game_players")
    .select("result, final_vp")
    .eq("user_id", userId);
  if (error || !data) return null;
  const games = data.length;
  const wins = data.filter((r) => r.result === "win").length;
  const bestVp = data.reduce((m, r) => Math.max(m, (r.final_vp as number) ?? 0), 0);
  return { games, wins, losses: games - wins, winRate: games ? wins / games : 0, bestVp };
}

/** The signed-in player's overall win/loss record. */
export async function fetchMyStats(): Promise<StatsSummary | null> {
  return fetchStats(auth.userId());
}

/** Any player's overall record (stats are public to signed-in users). */
export async function fetchUserStats(userId: string): Promise<StatsSummary | null> {
  return fetchStats(userId);
}

/** A player's recent games (most recent first). */
async function fetchHistory(userId: string | null, limit: number): Promise<HistoryEntry[]> {
  const sb = auth.client();
  if (!sb || !userId) return [];
  const { data, error } = await sb
    .from("game_players")
    .select("game_id, result, placement, final_vp, games(created_at, vs_ai, winner_name, winner_color, target_vp, players)")
    .eq("user_id", userId)
    .order("created_at", { foreignTable: "games", ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const rows = data as unknown as Array<{
    game_id: string;
    result: "win" | "loss";
    placement: number;
    final_vp: number;
    games: {
      created_at: string;
      vs_ai: boolean;
      winner_name: string;
      winner_color: PlayerColor;
      target_vp: number;
      players: GamePlayerSnap[];
    } | null;
  }>;
  return rows
    .filter((r) => r.games)
    .map((r) => ({
      gameId: r.game_id,
      playedAt: r.games!.created_at,
      result: r.result,
      placement: r.placement,
      finalVp: r.final_vp,
      vsAi: r.games!.vs_ai,
      winnerName: r.games!.winner_name,
      winnerColor: r.games!.winner_color,
      targetVp: r.games!.target_vp,
      players: r.games!.players ?? [],
    }));
}

/** The signed-in player's recent games. */
export async function fetchMyHistory(limit = 50): Promise<HistoryEntry[]> {
  return fetchHistory(auth.userId(), limit);
}

/** Any player's recent games (for viewing a friend's profile). */
export async function fetchUserHistory(userId: string, limit = 50): Promise<HistoryEntry[]> {
  return fetchHistory(userId, limit);
}

/** Head-to-head record vs one friend across the online games you both recorded. */
export interface FriendRecord {
  games: number;
  wins: number;
  losses: number;
  gameIds: Set<string>;
}
export async function fetchGamesWithFriend(friendId: string): Promise<FriendRecord> {
  const empty: FriendRecord = { games: 0, wins: 0, losses: 0, gameIds: new Set() };
  const sb = auth.client();
  const me = auth.userId();
  if (!sb || !me || !friendId) return empty;
  const [mine, theirs] = await Promise.all([
    sb.from("game_players").select("game_id, result").eq("user_id", me),
    sb.from("game_players").select("game_id").eq("user_id", friendId),
  ]);
  if (mine.error || theirs.error || !mine.data || !theirs.data) return empty;
  const theirSet = new Set((theirs.data as Array<{ game_id: string }>).map((r) => r.game_id));
  const shared = (mine.data as Array<{ game_id: string; result: "win" | "loss" }>).filter((r) => theirSet.has(r.game_id));
  const wins = shared.filter((r) => r.result === "win").length;
  return { games: shared.length, wins, losses: shared.length - wins, gameIds: new Set(shared.map((r) => r.game_id)) };
}
