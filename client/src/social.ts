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
 * Record a finished single-player game for the signed-in human. Best-effort:
 * never throws into the game, and silently skips when signed out / unconfigured.
 */
export async function recordLocalGame(state: GameState, humanId: string): Promise<void> {
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
      isAi: p.id !== humanId, // in single-player every rival is AI
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

    const { data: game, error } = await sb
      .from("games")
      .insert({
        client_game_id: state.id,
        recorder_id: me,
        target_vp: state.config.targetVictoryPoints,
        vs_ai: true,
        winner_name: winner?.name ?? "",
        winner_color: winner?.color ?? "blue",
        players: snaps,
      })
      .select("id")
      .single();
    // Unique-violation (23505) = already recorded elsewhere; just stop.
    if (error || !game) return;

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

/** Aggregate the signed-in player's win/loss record. Null when signed out. */
export async function fetchMyStats(): Promise<StatsSummary | null> {
  const sb = auth.client();
  const me = auth.userId();
  if (!sb || !me) return null;
  const { data, error } = await sb
    .from("game_players")
    .select("result, final_vp")
    .eq("user_id", me);
  if (error || !data) return null;
  const games = data.length;
  const wins = data.filter((r) => r.result === "win").length;
  const bestVp = data.reduce((m, r) => Math.max(m, (r.final_vp as number) ?? 0), 0);
  return { games, wins, losses: games - wins, winRate: games ? wins / games : 0, bestVp };
}

/** The signed-in player's recent games (most recent first). */
export async function fetchMyHistory(limit = 20): Promise<HistoryEntry[]> {
  const sb = auth.client();
  const me = auth.userId();
  if (!sb || !me) return [];
  const { data, error } = await sb
    .from("game_players")
    .select("result, placement, final_vp, games(created_at, vs_ai, winner_name, winner_color, target_vp, players)")
    .eq("user_id", me)
    .order("created_at", { foreignTable: "games", ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const rows = data as unknown as Array<{
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
