// Board topology generator for Catan: Starfarers.
//
// Visual model (matches the printed board):
//   - The board is a lattice of flat-top hex *cells*. EVERY planet occupies its
//     own full hex. A "planetary system" is a cluster of 3 mutually-adjacent
//     planet-hexes (a little triangle sharing one common corner).
//   - Ships/colonies live on *intersections* = the corners of the hex lattice.
//     Corners shared by neighbouring hexes merge into one intersection, so the
//     corner graph is the ship-travel network.
//   - A "colony site" is an intersection adjacent to >=2 planets — i.e. a corner
//     shared by two planet-hexes of a system. A colony there produces from every
//     adjacent planet whose number is rolled.
//   - Alien outpost hexes expose their 6 corners as docking points for trade ships.
//   - Empty hexes (no planet) fill the rest of the lattice so the travel graph is
//     fully connected and the board reads as a continuous hex field.

import type {
  AlienCiv,
  Intersection,
  Planet,
  PlanetColor,
  Sector,
} from "./types.js";
import { OUTPOST_CIVS } from "./types.js";

export interface BoardTopology {
  sectors: Sector[];
  intersections: Record<string, Intersection>;
}

// --- Tunable geometry (normalized hex size = 1) ---
const HEX_SIZE = 1;
/** Rounding precision used to merge coincident hex corners. */
const SNAP = 1000;

const deg2rad = (d: number): number => (d * Math.PI) / 180;

/** Flat-top hex centre in normalized board space. */
function hexCenter(q: number, r: number): { x: number; y: number } {
  return {
    x: HEX_SIZE * 1.5 * q,
    y: HEX_SIZE * Math.sqrt(3) * (r + q / 2),
  };
}

/** Corner i (0..5) of a flat-top hex, at 60°·i around the centre. */
function hexCorner(cx: number, cy: number, i: number): { x: number; y: number } {
  const a = deg2rad(60 * i);
  return { x: cx + HEX_SIZE * Math.cos(a), y: cy + HEX_SIZE * Math.sin(a) };
}

const snapKey = (x: number, y: number): string =>
  `${Math.round(x * SNAP)}:${Math.round(y * SNAP)}`;
const hexKey = (q: number, r: number): string => `${q},${r}`;

// --- Deterministic RNG (mulberry32) so the same seed yields the same board ---
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Standard Catan number chits (no 7), cycled to cover all planets. */
const NUMBER_BAG = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

/** Planet colour triples for planetary systems (each system gets 3 planets). */
const SYSTEM_PALETTES: PlanetColor[][] = [
  ["red", "blue", "green"],
  ["orange", "multicolor", "red"],
  ["green", "orange", "blue"],
  ["multicolor", "red", "orange"],
  ["blue", "green", "multicolor"],
  ["red", "orange", "green"],
  ["orange", "blue", "multicolor"],
  ["green", "red", "blue"],
];

// --- Board layout -------------------------------------------------------------
//
// Slots sit on a coarse grid of 3 columns × 5 rows. Column anchors use even q so
// the half-step column offset keeps pixel-rows aligned. Each slot's anchor hex is
// (q = COL[c], r = ROW_V[row] - q/2); a slot occupies a 3-hex "down" triangle:
//   (q, r), (q+1, r), (q, r+1).
// A planetary system fills all three hexes with planets. An outpost / hub uses
// only the anchor hex (the other two become empty filler).

type SlotRole = "system" | "home" | "outpost" | "hub" | "emptyCluster";

const SLOT_COLS = [0, 4, 8]; // q anchors (even) for the upper (non-home) rows — 3 wide
const SLOT_ROWS_V = [0, 3, 6, 9, 12, 15]; // visual rows, top → bottom (5 deep-space + home)

// The Catanian Colonies edge (bottom row) is its own strip of FOUR home systems.
// Each system is 2 columns wide; spacing the anchors 3 apart leaves one empty
// hex-column of open space between neighbouring systems (a deep-space lane that
// becomes un-buildable once set-up ends).
const HOME_COLS = [0, 3, 6, 9]; // 4 home clusters, one-column gap between each

// Role grid for the upper rows [row][col]; the bottom row is all homes (built
// from HOME_COLS below, not this grid). The board is kept NARROW (3 columns) and
// extends UPWARD: five rows of deep space stacked above the Catanian home row.
// The DISCOVERABLE galaxy (Q9) is exactly 15 clusters: 8 planetary systems +
// 4 alien outposts + 3 empty clusters (3 cols × 5 rows = 15). Row 0 is the FAR
// edge (farthest from home): its two outposts are forced to be the Diplomats &
// Scientists (the two "advanced" civs sit at the top, away from home).
const SLOT_ROLES: SlotRole[][] = [
  ["outpost", "system", "outpost"],
  ["system", "emptyCluster", "system"],
  ["system", "system", "outpost"],
  ["emptyCluster", "system", "system"],
  ["outpost", "system", "emptyCluster"],
];

interface Slot {
  role: SlotRole;
  q: number;
  r: number;
  /** Visual row index (0 = top / far edge of the galaxy). */
  vrow: number;
  /** The 3 hexes of this slot's triangle. */
  hexes: [number, number][];
  /** Fog-randomized outposts tag their half: true = top (advanced civs:
   *  Diplomats/Scientists), false = bottom (Green Folk/Merchants). */
  topHalf?: boolean;
}

function buildSlots(): Slot[] {
  const slots: Slot[] = [];
  const makeSlot = (role: SlotRole, q: number, vrow: number): Slot => {
    // Snap to the integer hex lattice. For even q this is exact; for the odd
    // home anchors it lands the system on the nearest lattice row (a half-row
    // stagger), keeping every corner aligned so the travel graph stays connected.
    const v = SLOT_ROWS_V[vrow]!;
    const r = Math.round(v - q / 2);
    return {
      role,
      q,
      r,
      vrow,
      hexes: [
        [q, r],
        [q + 1, r],
        [q, r + 1],
      ],
    };
  };
  // Upper rows: 3 systems/outposts/empty-clusters per row, stacked upward.
  for (let row = 0; row < SLOT_ROLES.length; row++) {
    for (let c = 0; c < SLOT_COLS.length; c++) {
      slots.push(makeSlot(SLOT_ROLES[row]![c]!, SLOT_COLS[c]!, row));
    }
  }
  // Bottom row: the Catanian Colonies edge — four home systems.
  const homeRow = SLOT_ROWS_V.length - 1;
  for (const q of HOME_COLS) slots.push(makeSlot("home", q, homeRow));
  return slots;
}

export interface GenerateBoardOptions {
  setup?: "beginner";
  seed?: number;
  /**
   * Shuffle which upper-row slots are planetary systems vs alien outposts so an
   * outpost can sit where a planet cluster normally would, and vice-versa (P6b).
   * The central hub and the bottom Catanian home row stay put. Used for fog games
   * so the galaxy's layout — not just its contents — differs every match.
   */
  randomizeLayout?: boolean;
  /**
   * Balanced number placement: when not explicitly false, repair the chit layout
   * so no two "hot" numbers (6/8) share an intersection. Set false for a raw,
   * fully-random placement (the "Balanced Layout off" host option).
   */
  balancedLayout?: boolean;
}

/**
 * Generate the board topology: sectors (with planets + numbers) and the merged
 * intersection graph that ships traverse.
 */
export function generateBoard(opts: GenerateBoardOptions = {}): BoardTopology {
  const rand = rng(opts.seed ?? 0xc47a4);
  const slots = buildSlots();

  // P6b / Q9 + AE: in a fog game, randomize the *positions* of EVERYTHING in the
  // discoverable field — outposts can now sit where a planet cluster normally
  // would, and vice-versa. Constraint (per the printed board's flavour): the two
  // "advanced" civs (Diplomats & Scientists) live somewhere in the TOP half of
  // the map, and the two "basic" civs (Green Folk & Merchants) in the BOTTOM
  // half — but exactly where, within each half, is reshuffled every game. The
  // central hub and the bottom Catanian home row stay fixed.
  if (opts.randomizeLayout) {
    const upper = slots.filter((s) => s.role !== "home" && s.role !== "hub");
    // Halves by visual row: rows 0–2 = top, rows 3–4 = bottom.
    const topHalf = shuffle(upper.filter((s) => s.vrow <= 2), rand);
    const bottomHalf = shuffle(upper.filter((s) => s.vrow >= 3), rand);
    // 2 outposts per half; the rest of the field keeps its 8 systems + 3 empty
    // clusters, distributed at random across every non-outpost slot.
    const fillRoles = shuffle(
      [...new Array(8).fill("system"), ...new Array(3).fill("emptyCluster")] as SlotRole[],
      rand,
    );
    const topOut = topHalf.slice(0, 2);
    const botOut = bottomHalf.slice(0, 2);
    const outpostSet = new Set([...topOut, ...botOut]);
    for (const s of topOut) s.topHalf = true;
    for (const s of botOut) s.topHalf = false;
    // Reassign EVERY upper slot from scratch (don't trust pre-randomization
    // roles, or leftover original outposts would survive as extras).
    let fi = 0;
    for (const s of upper) {
      s.role = outpostSet.has(s) ? "outpost" : fillRoles[fi++]!;
    }
  }

  // Number chits, shuffled, cycled if we run out.
  const numbers = shuffle(NUMBER_BAG, rand);
  let numIdx = 0;
  const nextNumber = (): number => numbers[numIdx++ % numbers.length]!;

  // Randomize the rest of the board content each game (P3): the colour triple for
  // each planetary system, which civilization staffs each outpost, and where the
  // pirate bases / ice planets hide. The seed (Date.now-derived in setup) makes
  // every game's galaxy different — and in fog mode, undiscoverable until charted.
  const palettes = shuffle(SYSTEM_PALETTES, rand);
  const civOrder = shuffle(OUTPOST_CIVS, rand);

  const intersections: Record<string, Intersection> = {};
  const cornerId = new Map<string, string>();
  let nextIntersection = 0;

  const ensureIntersection = (x: number, y: number): Intersection => {
    const key = snapKey(x, y);
    let id = cornerId.get(key);
    if (id === undefined) {
      id = `i${nextIntersection++}`;
      cornerId.set(key, id);
      intersections[id] = { id, x, y, neighbors: [], adjacentPlanets: [] };
    }
    return intersections[id]!;
  };

  const linkNeighbors = (a: Intersection, b: Intersection): void => {
    if (a.id !== b.id && !a.neighbors.includes(b.id)) {
      a.neighbors.push(b.id);
      b.neighbors.push(a.id);
    }
  };

  /** Ensure all 6 corners of a hex and its perimeter edges; return the corners. */
  const hexCorners = (q: number, r: number): Intersection[] => {
    const { x: cx, y: cy } = hexCenter(q, r);
    const corners: Intersection[] = [];
    for (let i = 0; i < 6; i++) {
      const cc = hexCorner(cx, cy, i);
      corners.push(ensureIntersection(cc.x, cc.y));
    }
    for (let i = 0; i < 6; i++) linkNeighbors(corners[i]!, corners[(i + 1) % 6]!);
    return corners;
  };

  // Decide each hex's role. Planet hexes map to a system + colour slot; outpost
  // hexes carry the civ; everything else (incl. leftover slot hexes) is empty.
  const planetHex = new Map<string, { sysIdx: number; slotInSys: number }>();
  const outpostHex = new Map<string, string>(); // hexKey -> sectorId
  const usedHex = new Set<string>();

  // Assemble systems first (homes ordered first so setup seeds the bottom edge).
  interface SysDef {
    sectorId: string;
    q: number;
    r: number;
    hexes: [number, number][];
    home: boolean;
  }
  const homeSystems: SysDef[] = [];
  const otherSystems: SysDef[] = [];
  const outpostDefs: {
    sectorId: string;
    q: number;
    r: number;
    hexes: [number, number][];
    topRow: boolean;
  }[] = [];
  const emptyClusterDefs: { sectorId: string; q: number; r: number; hexes: [number, number][] }[] = [];
  const clusterHex = new Map<string, string>(); // hexKey -> emptyCluster sectorId

  for (const slot of slots) {
    const sectorId = `s${slot.q}_${slot.r}`;
    if (slot.role === "system" || slot.role === "home") {
      const def: SysDef = {
        sectorId,
        q: slot.q,
        r: slot.r,
        hexes: slot.hexes,
        home: slot.role === "home",
      };
      (slot.role === "home" ? homeSystems : otherSystems).push(def);
    } else if (slot.role === "outpost") {
      // Outposts span the full 3-hex slot triangle (like a planetary system).
      // "topRow" = advanced half. In fog games the slot was tagged with its
      // half during randomization; in charted games fall back to the fixed
      // far-top row (vrow 0) carrying the advanced civs.
      outpostDefs.push({
        sectorId, q: slot.q, r: slot.r, hexes: slot.hexes,
        topRow: slot.topHalf ?? slot.vrow === 0,
      });
      for (const [hq, hr] of slot.hexes) {
        outpostHex.set(hexKey(hq, hr), sectorId);
        usedHex.add(hexKey(hq, hr));
      }
    } else if (slot.role === "emptyCluster") {
      // A discoverable 3-hex cluster that turns out to be empty space. Visible-
      // empty in a charted (normal) game; a "???" cluster to chart in fog (Q9).
      emptyClusterDefs.push({ sectorId, q: slot.q, r: slot.r, hexes: slot.hexes });
      for (const [hq, hr] of slot.hexes) {
        clusterHex.set(hexKey(hq, hr), sectorId);
        usedHex.add(hexKey(hq, hr));
      }
    } else {
      // hub: anchor hex stays empty (mothership draws there); nothing claimed.
    }
  }

  // Q9: the two outposts on the far top row are always the Diplomats & Scientists
  // (the "advanced" civs sit at the end of the map, away from home). The other
  // two outposts take the remaining civs (Green Folk & Merchants). We still
  // shuffle WHICH top outpost is diplomats vs scientists, etc., for variety.
  const advanced: AlienCiv[] = shuffle(["diplomats", "scientists"], rand);
  const basic: AlienCiv[] = shuffle(["greenFolk", "merchants"], rand);
  void civOrder; // legacy shuffle kept for seed-stability of later draws
  let advIdx = 0;
  let basIdx = 0;
  const outpostCivFor = (op: { topRow: boolean }): AlienCiv =>
    op.topRow ? advanced[advIdx++ % advanced.length]! : basic[basIdx++ % basic.length]!;

  const orderedSystems = [...homeSystems, ...otherSystems];
  orderedSystems.forEach((sys, sysIdx) => {
    sys.hexes.forEach(([hq, hr], slotInSys) => {
      planetHex.set(hexKey(hq, hr), { sysIdx, slotInSys });
      usedHex.add(hexKey(hq, hr));
    });
  });

  // Full hex bounding box → generate corners for EVERY cell so the travel graph
  // is connected and the board reads as a continuous field of hexes.
  const allHexes: [number, number][] = [];
  const minV = Math.min(...SLOT_ROWS_V);
  const maxV = Math.max(...SLOT_ROWS_V) + 1;
  // Home anchors can extend further right than the upper rows, so widen the box
  // to include them (each system spans q..q+1) — this fills the gap columns with
  // empty space hexes so the field stays continuous and connected. The box stops
  // exactly at the rightmost content column (no trailing empty column on the right).
  const minQ = Math.min(...SLOT_COLS, ...HOME_COLS);
  const maxQ = Math.max(Math.max(...SLOT_COLS) + 1, Math.max(...HOME_COLS) + 1);
  const seenHex = new Set<string>();
  for (let q = minQ; q <= maxQ; q++) {
    for (let v = minV; v <= maxV; v++) {
      const r = Math.round(v - q / 2);
      const k = hexKey(q, r);
      if (seenHex.has(k)) continue;
      seenHex.add(k);
      allHexes.push([q, r]);
      hexCorners(q, r);
    }
  }
  // Also ensure any claimed hex outside the box is present.
  for (const k of usedHex) {
    if (!seenHex.has(k)) {
      const [q, r] = k.split(",").map(Number) as [number, number];
      seenHex.add(k);
      allHexes.push([q, r]);
      hexCorners(q, r);
    }
  }

  const sectors: Sector[] = [];

  // Starting-colony rule: the Catanian home systems must collectively show
  // exactly two 6s and two 8s — one "hot" production number per home system —
  // so every player's start sits next to a strong number. The remaining home
  // planets get cool (non-6/8) numbers; non-home systems keep the shuffled bag.
  // (Home systems sit on the bottom edge with column gaps, so their hot planets
  // never share a corner with each other — no within-home 6/8 adjacency.)
  const homeCount = homeSystems.length;
  const hotForHome = shuffle([6, 6, 8, 8].slice(0, homeCount), rand);
  const coolPool = shuffle(
    NUMBER_BAG.filter((n) => !HOT_NUMBERS.has(n)),
    rand,
  );
  let coolIdx = 0;
  const nextCool = (): number => coolPool[coolIdx++ % coolPool.length]!;
  const homeNumbers: number[][] = [];
  for (let h = 0; h < homeCount; h++) {
    const trip = [nextCool(), nextCool(), nextCool()];
    trip[Math.floor(rand() * 3)] = hotForHome[h] ?? nextCool();
    homeNumbers.push(trip);
  }
  const homePlanetIds = new Set<string>();

  // The Catanian home systems collectively start with a fixed resource spread
  // (matching the original opening): 3 fuel, 2 food, 3 ore, 2 carbon, 2 goods.
  // colors → resources: orange=fuel, green=food, red=ore, blue=carbon, multicolor=goods.
  const homeColorPool = shuffle<PlanetColor>(
    [
      "orange", "orange", "orange",
      "green", "green",
      "red", "red", "red",
      "blue", "blue",
      "multicolor", "multicolor",
    ],
    rand,
  );
  let homeColorIdx = 0;

  // Build planetary-system sectors with 3 planet-hexes each.
  orderedSystems.forEach((sys, sysIdx) => {
    const palette = palettes[sysIdx % palettes.length]!;
    const isHome = sysIdx < homeCount;
    const planets: Planet[] = sys.hexes.map(([hq, hr], k) => {
      const { x, y } = hexCenter(hq, hr);
      const planet: Planet = {
        id: `${sys.sectorId}_p${k}`,
        color: isHome ? (homeColorPool[homeColorIdx++] ?? palette[k]!) : palette[k]!,
        x,
        y,
        number: isHome ? homeNumbers[sysIdx]![k]! : nextNumber(),
        explored: true,
        special: "none",
      };
      if (isHome) homePlanetIds.add(planet.id);
      // Tag this planet's 6 hex corners as adjacent.
      const { x: cx, y: cy } = hexCenter(hq, hr);
      for (let i = 0; i < 6; i++) {
        const cc = hexCorner(cx, cy, i);
        const inter = intersections[cornerId.get(snapKey(cc.x, cc.y))!]!;
        if (!inter.adjacentPlanets.includes(planet.id)) inter.adjacentPlanets.push(planet.id);
      }
      return planet;
    });
    sectors.push({
      id: sys.sectorId,
      kind: "planetarySystem",
      q: sys.q,
      r: sys.r,
      planets,
      discovered: true,
      home: sys.home,
    });
  });

  // Outpost sectors: a SINGLE docking point — the shared CENTER corner of the
  // outpost's 3-hex triangle. A trade ship must sit exactly on that center
  // intersection to establish a trade station.
  for (const op of outpostDefs) {
    // Ensure all 3 hexes' corners exist (travel graph), then tag only the
    // common center corner (centroid of the 3 hex centers) as the docking point.
    const opCorners = new Set<string>();
    for (const [hq, hr] of op.hexes) {
      for (const c of hexCorners(hq, hr)) opCorners.add(c.id);
    }
    const cx = HEX_SIZE * 1.5 * op.q + 0.5;
    const cy = HEX_SIZE * Math.sqrt(3) * (op.r + op.q / 2 + 0.5);
    const centerId = cornerId.get(snapKey(cx, cy));
    if (centerId) intersections[centerId]!.dockingPointOf = op.sectorId;
    // Fog map: reaching ANY corner of the outpost's triangle charts it — so a
    // "???" disguised outpost reveals on approach like a real planetary system.
    for (const cid of opCorners) {
      const inter = intersections[cid]!;
      (inter.revealsSectors ??= []).push(op.sectorId);
    }
    sectors.push({
      id: op.sectorId,
      kind: "outpost",
      q: op.q,
      r: op.r,
      planets: [],
      outpostCiv: outpostCivFor(op),
      discovered: true,
    });
  }

  // Empty-cluster sectors (Q9): a discoverable 3-hex cluster that holds no
  // planets. Like outposts, reaching ANY corner of its triangle charts it (so a
  // fog "???" cluster can reveal as empty space). It exposes no docking point.
  for (const ec of emptyClusterDefs) {
    const ecCorners = new Set<string>();
    for (const [hq, hr] of ec.hexes) {
      for (const c of hexCorners(hq, hr)) ecCorners.add(c.id);
    }
    for (const cid of ecCorners) {
      const inter = intersections[cid]!;
      (inter.revealsSectors ??= []).push(ec.sectorId);
    }
    sectors.push({
      id: ec.sectorId,
      kind: "emptyCluster",
      q: ec.q,
      r: ec.r,
      planets: [],
      discovered: true,
    });
  }

  // Empty sectors for every remaining (unclaimed) hex.
  for (const [q, r] of allHexes) {
    const k = hexKey(q, r);
    if (planetHex.has(k) || outpostHex.has(k) || clusterHex.has(k)) continue;
    sectors.push({
      id: `s${q}_${r}`,
      kind: "empty",
      q,
      r,
      planets: [],
      discovered: true,
    });
  }

  // Place a few pirate bases / ice planets on non-home planetary systems — at
  // random systems each game (P3). Thresholds must be reachable: pirate bases need
  // cannons (max 6), ice planets need freight pods (max 5), so keep these modest.
  const tokenPlan: { special: "pirateBase" | "icePlanet"; value: number }[] = [
    { special: "pirateBase", value: 3 },
    { special: "icePlanet", value: 2 },
    { special: "pirateBase", value: 4 },
  ];
  const shuffledNonHome = shuffle(otherSystems, rand);
  tokenPlan.forEach((tok, i) => {
    const sysDef = shuffledNonHome[i];
    const sector = sysDef && sectors.find((s) => s.id === sysDef.sectorId);
    if (!sector || sector.planets.length === 0) return;
    // A random planet within the chosen system carries the token.
    const planet = sector.planets[Math.floor(rand() * sector.planets.length)]!;
    planet.special = tok.special;
    planet.specialValue = tok.value;
  });

  // Q8: never let the two "hot" numbers (6 and 8 — the highest-frequency chits)
  // sit on planets that share an intersection. Repair after assignment by
  // swapping a conflicting hot number with a cool one elsewhere on the board.
  // Home planets are protected so the two-6s/two-8s starting rule is preserved.
  // Skipped when "Balanced Layout" is off (opts.balancedLayout === false), which
  // allows raw/random chit placement (adjacent 6s & 8s become possible).
  if (opts.balancedLayout !== false) {
    separateHotNumbers(sectors, intersections, rand, homePlanetIds);
  }

  return { sectors, intersections };
}

/** The high-frequency production numbers that must never be neighbours (Q8). */
const HOT_NUMBERS = new Set([6, 8]);

/**
 * Build planet→planet adjacency from the shared corner graph: two planets are
 * "adjacent" iff some intersection touches both.
 */
function planetAdjacency(
  intersections: Record<string, Intersection>,
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const inter of Object.values(intersections)) {
    const ps = inter.adjacentPlanets;
    for (const a of ps) {
      let set = adj.get(a);
      if (!set) adj.set(a, (set = new Set()));
      for (const b of ps) if (a !== b) set.add(b);
    }
  }
  return adj;
}

/**
 * Repair the board so no 6 sits next to a 6/8 and no 8 sits next to a 6/8.
 * Greedy: find a hot planet adjacent to another hot planet, then swap its number
 * with a cool planet whose own neighbourhood would stay clean after the swap.
 */
function separateHotNumbers(
  sectors: Sector[],
  intersections: Record<string, Intersection>,
  rand: () => number,
  protectedIds: Set<string> = new Set(),
): void {
  const planets: Planet[] = [];
  for (const s of sectors) for (const p of s.planets) planets.push(p);
  const byId = new Map(planets.map((p) => [p.id, p]));
  const adj = planetAdjacency(intersections);
  const isHot = (p: Planet): boolean => p.number != null && HOT_NUMBERS.has(p.number);
  const neighbours = (p: Planet): Planet[] =>
    [...(adj.get(p.id) ?? [])].map((id) => byId.get(id)).filter((x): x is Planet => !!x);
  const conflicts = (p: Planet): boolean => isHot(p) && neighbours(p).some(isHot);

  for (let pass = 0; pass < 300; pass++) {
    // Resolve by moving a *non-protected* conflicting planet (home planets keep
    // their numbers so the starting two-6s/two-8s rule holds). A home hot planet
    // adjacent to a non-home hot is still fixed because that non-home neighbour
    // is itself conflicting and gets picked here.
    const bad = planets.find((p) => conflicts(p) && !protectedIds.has(p.id));
    if (!bad) return; // fully separated (or only protected planets remain)
    // Candidate cool planets whose neighbourhood (ignoring `bad`) has no hot
    // number, so giving them `bad`'s hot value introduces no new conflict.
    const cool = shuffle(
      planets.filter(
        (p) => p.number != null && !HOT_NUMBERS.has(p.number) && !protectedIds.has(p.id),
      ),
      rand,
    );
    let swapped = false;
    for (const c of cool) {
      if (c.id === bad.id) continue;
      const safe = neighbours(c).every((n) => n.id === bad.id || !isHot(n));
      if (!safe) continue;
      const tmp = bad.number;
      bad.number = c.number;
      c.number = tmp;
      swapped = true;
      break;
    }
    if (!swapped) return; // no safe swap available — accept the layout
  }
}

/**
 * Colony sites sit on a system *edge* — an intersection shared by exactly two
 * planets. The corner shared by all three planets of a system (the center,
 * adjacentPlanets.length === 3) is NOT buildable.
 */
export function isColonySite(inter: Intersection): boolean {
  return inter.adjacentPlanets.length === 2;
}
