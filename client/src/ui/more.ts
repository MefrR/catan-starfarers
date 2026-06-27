// The "More" panel: a tabbed overlay reached from the main menu. For now it
// holds the illustrated "How to Play" guide (every rule from the printed
// rulebook, each section paired with a small looping animation that shows the
// action — like the animated thumbnails in colonist.io's rules popup). The
// About tab is a placeholder for the social links / extras coming later.

import type { Resource } from "@starfarers/shared";
import { resourceGlyphSvg, civAvatarSvg } from "./icons.js";
import { el } from "./dom.js";

// --- Resource colors (match the in-game hand cubes). ---
const ORE = "#d8453a";
const FUEL = "#e08a2e";
const CARBON = "#3d7fd6";
const FOOD = "#3fae6b";
const GOODS = "#9a6fd0";
const RES_COLOR: Record<Resource, string> = { ore: ORE, fuel: FUEL, carbon: CARBON, food: FOOD, goods: GOODS };

// A real resource "card" — the in-game glyph on a tinted mini card.
const resCard = (r: Resource): string =>
  `<span class="htp-rescard" style="--rc:${RES_COLOR[r]}">${resourceGlyphSvg(r)}</span>`;
// A cost as resource glyphs with counts (e.g. 1 ore · 1 fuel · 2 goods).
const cost = (parts: [Resource, number][]): string =>
  parts.map(([r, n]) => `<span class="htp-costres" style="--rc:${RES_COLOR[r]}">${resourceGlyphSvg(r)}<b>${n}</b></span>`).join("");

// ---------------------------------------------------------------------------
// Tiny inline SVG icons reused across the animated scenes.
// ---------------------------------------------------------------------------
const shipSvg = (c: string): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M24 5 L33 32 L24 27 L15 32 Z" fill="${c}" stroke="rgba(0,0,0,.4)" stroke-width="1.5" stroke-linejoin="round"/><circle cx="24" cy="18" r="3.4" fill="#0a1322" opacity=".55"/></svg>`;

const colonySvg = (c: string): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M11 35 H37 V25 A13 13 0 0 0 11 25 Z" fill="${c}" stroke="rgba(0,0,0,.4)" stroke-width="1.5" stroke-linejoin="round"/><rect x="20" y="27" width="8" height="8" rx="1.5" fill="#0a1322" opacity=".5"/></svg>`;

const spaceportSvg = (c: string): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><ellipse cx="24" cy="35" rx="20" ry="5.5" fill="none" stroke="${c}" stroke-width="2.4" opacity=".75"/><path d="M12 34 H36 V24 A12 12 0 0 0 12 24 Z" fill="${c}" stroke="rgba(0,0,0,.4)" stroke-width="1.5" stroke-linejoin="round"/><rect x="20" y="26" width="8" height="8" rx="1.5" fill="#0a1322" opacity=".5"/></svg>`;

// Colony ship = transport carrying a colony dome; trade ship carries a crate.
const colonyShipSvg = (c: string): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M24 6 L33 30 L24 26 L15 30 Z" fill="${c}" stroke="rgba(0,0,0,.4)" stroke-width="1.5" stroke-linejoin="round"/><path d="M18 22 H30 V17 A6 6 0 0 0 18 17 Z" fill="#0a1322" opacity=".55"/></svg>`;
const tradeShipSvg = (c: string): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M24 6 L33 30 L24 26 L15 30 Z" fill="${c}" stroke="rgba(0,0,0,.4)" stroke-width="1.5" stroke-linejoin="round"/><rect x="18" y="16" width="12" height="9" rx="1.5" fill="#0a1322" opacity=".55"/></svg>`;

const boosterSvg = (): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M18 6 H30 L27 28 H21 Z" fill="#6fd0ff" stroke="#27506e" stroke-width="1.6" stroke-linejoin="round"/><path d="M21 27 H27 L25 41 Q24 44 23 41 Z" fill="#ff8a3c" stroke="#a8521c" stroke-width="1"/></svg>`;
const freightPodSvg = (): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><rect x="8" y="14" width="32" height="22" rx="4" fill="#d8b25a" stroke="#7a5e22" stroke-width="1.6"/><path d="M8 23 H40 M24 14 V36" stroke="#7a5e22" stroke-width="1.4"/></svg>`;

const starSvg = (c = "#ffd23f"): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M24 4 L29.6 17 L43 18.2 L32.8 27.2 L36 40.4 L24 33.2 L12 40.4 L15.2 27.2 L5 18.2 L18.4 17 Z" fill="${c}" stroke="rgba(0,0,0,.35)" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

const outpostSvg = (c = "#7c5cff"): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><g fill="${c}" stroke="rgba(0,0,0,.4)" stroke-width="1.4"><circle cx="24" cy="15" r="9"/><circle cx="14" cy="31" r="9"/><circle cx="34" cy="31" r="9"/></g><circle cx="24" cy="25" r="6" fill="#0a0f1e"/></svg>`;

const rocketSvg = (): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M24 4 C31 12 34 23 34 31 H14 C14 23 17 12 24 4 Z" fill="#d8b25a" stroke="#7a5e22" stroke-width="1.4"/><circle cx="24" cy="18" r="5" fill="#6fd0ff" stroke="#27506e" stroke-width="1.4"/><path d="M14 29 L7 39 L16 35 Z" fill="#b07a2a"/><path d="M34 29 L41 39 L32 35 Z" fill="#b07a2a"/><path d="M20 32 H28 L25 41 H23 Z" fill="#ff8a3c"/></svg>`;

const alienSvg = (): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><ellipse cx="24" cy="23" rx="13" ry="16" fill="#7fe0a0" stroke="#2a6b44" stroke-width="1.4"/><ellipse cx="18" cy="21" rx="3.6" ry="5.2" fill="#10202a"/><ellipse cx="30" cy="21" rx="3.6" ry="5.2" fill="#10202a"/><path d="M19 33 Q24 36 29 33" fill="none" stroke="#2a6b44" stroke-width="1.4" stroke-linecap="round"/></svg>`;

const cannonSvg = (): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><rect x="8" y="20" width="22" height="10" rx="3" fill="#9aa3bd" stroke="#3a4566" stroke-width="1.4"/><rect x="28" y="22" width="14" height="6" rx="2" fill="#cfd6ec" stroke="#3a4566" stroke-width="1.2"/><circle cx="12" cy="25" r="6" fill="#6b7595" stroke="#3a4566" stroke-width="1.2"/></svg>`;

const skullSvg = (): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M24 6 C13 6 7 14 7 23 C7 29 11 32 13 33 V39 H35 V33 C37 32 41 29 41 23 C41 14 35 6 24 6 Z" fill="#c9cee0" stroke="#3a4566" stroke-width="1.4"/><circle cx="17" cy="23" r="4.5" fill="#10202a"/><circle cx="31" cy="23" r="4.5" fill="#10202a"/><path d="M22 31 h4 v6 h-4 z" fill="#10202a"/></svg>`;

const iceSvg = (): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><g stroke="#9fe3ff" stroke-width="2.6" stroke-linecap="round"><path d="M24 6 V42"/><path d="M8 15 L40 33"/><path d="M40 15 L8 33"/><path d="M24 12 l-5 -5 M24 12 l5 -5 M24 36 l-5 5 M24 36 l5 5"/></g></svg>`;

// A small resource "card" cube with the resource tint.
const cube = (c: string, extra = ""): string =>
  `<span class="htp-cube ${extra}" style="--rc:${c}"></span>`;

// A planet disc (radial-shaded), optionally with a number disc on it.
const planet = (c: string, num = "", cls = ""): string =>
  `<span class="htp-planet ${cls}" style="--pc:${c}">${num ? `<b>${num}</b>` : ""}</span>`;

// A single pip-face die showing a digit (kept simple & legible at small size).
const die = (n: number | string): string => `<span class="htp-die">${n}</span>`;

const stage = (sceneClass: string, inner: string): string =>
  `<div class="htp-stage"><div class="htp-scene ${sceneClass}">${inner}</div></div>`;

// ---------------------------------------------------------------------------
// Animated scenes — one per topic. Pure HTML + CSS (keyframes in style.css),
// each loops forever so the panel feels alive like the reference rules popup.
// ---------------------------------------------------------------------------
const SCENES: Record<string, string> = {
  goal: stage(
    "htp-goal",
    `<div class="htp-vptrack">${Array.from({ length: 15 })
      .map((_, i) => `<span class="htp-vp" style="--i:${i}"></span>`)
      .join("")}</div>
     <div class="htp-trophy">${starSvg()}<span>15 VP — you win!</span></div>`,
  ),

  setup: stage(
    "htp-setup",
    `${planet(FOOD, "", "p1")}${planet(ORE, "", "p2")}
     <span class="htp-node"></span>
     <span class="htp-drop">${colonySvg("#ffd23f")}</span>
     <span class="htp-float">+1 VP</span>`,
  ),

  production: stage(
    "htp-prod",
    `<div class="htp-dice">${die(2)}${die(3)}<span class="htp-eq">= 5</span></div>
     ${planet(ORE, "5", "htp-prodplanet")}
     <span class="htp-flycube">${cube(ORE)}</span>
     <div class="htp-hand">${cube(FOOD)}${cube(CARBON)}<span class="htp-handslot"></span></div>`,
  ),

  trade: stage(
    "htp-trade",
    `<div class="htp-side l">YOU</div><div class="htp-side r">RIVAL</div>
     <span class="htp-tradecard give">${cube(FOOD)}</span>
     <span class="htp-tradecard get">${cube(CARBON)}</span>
     <span class="htp-swap">⇄</span>`,
  ),

  build: stage(
    "htp-build",
    `<span class="htp-bcube b1">${cube(ORE)}</span>
     <span class="htp-bcube b2">${cube(FUEL)}</span>
     <span class="htp-bcube b3">${cube(CARBON)}</span>
     <span class="htp-bcube b4">${cube(FOOD)}</span>
     <span class="htp-bresult">${shipSvg("#ffd23f")}</span>`,
  ),

  flight: stage(
    "htp-flight",
    `<span class="htp-mship">${rocketSvg()}</span>
     <span class="htp-speed">Speed 4</span>
     <div class="htp-track">${Array.from({ length: 4 })
       .map((_, i) => `<span class="htp-dot" style="--i:${i}"></span>`)
       .join("")}</div>
     <span class="htp-flyship">${shipSvg("#4fa8ff")}</span>`,
  ),

  explore: stage(
    "htp-explore",
    `<span class="htp-qdisc"><span class="q">?</span><span class="n">8</span></span>
     <span class="htp-exship">${shipSvg("#52d273")}</span>
     <span class="htp-excolony">${colonySvg("#52d273")}</span>`,
  ),

  outposts: stage(
    "htp-outpost",
    `<span class="htp-opbig">${outpostSvg()}</span>
     <span class="htp-opship">${shipSvg("#ff5d5d")}</span>
     <span class="htp-fcard"><span>Friendship</span></span>
     <span class="htp-float op">+2 VP</span>`,
  ),

  encounters: stage(
    "htp-enc",
    `<div class="htp-card3d"><div class="htp-cface front">!</div><div class="htp-cface back">${alienSvg()}<em>Offer&nbsp;0–3</em></div></div>`,
  ),

  hazards: stage(
    "htp-hazard",
    `<div class="htp-haz pirate">
       <span class="htp-cannon">${cannonSvg()}</span>
       <span class="htp-shot"></span>
       <span class="htp-token tk-skull">${skullSvg()}</span>
       <span class="htp-token tk-medal">${starSvg()}</span>
     </div>
     <div class="htp-haz ice">
       <span class="htp-pods">2 freight pods</span>
       <span class="htp-token tk-ice">${iceSvg()}</span>
       <span class="htp-token tk-medal2">${starSvg()}</span>
     </div>`,
  ),

  seven: stage(
    "htp-seven",
    `<div class="htp-dice">${die(3)}${die(4)}<span class="htp-eq sev">= 7</span></div>
     <div class="htp-handrow">${Array.from({ length: 8 })
       .map((_, i) => cube([ORE, FUEL, CARBON, FOOD, GOODS, ORE, FOOD, CARBON][i]!, `s${i} ${i % 2 ? "drop" : ""}`))
       .join("")}</div>`,
  ),
};

interface Topic {
  id: string;
  title: string;
  tag: string;
  body: string; // the explanatory HTML beneath the animation
}

// ---------------------------------------------------------------------------
// Rulebook content — faithful to the printed Catan: Starfarers rules.
// ---------------------------------------------------------------------------
const TOPICS: Topic[] = [
  {
    id: "goal",
    title: "The Goal",
    tag: "Win",
    body: `
      <p>Command your fleet from the Catanian Colonies out into deep space. You begin with
      <b>2 colonies and 1 spaceport</b> already on the board — that's <b>4 victory points</b> to start.</p>
      <p>The first commander to reach <b>15 victory points</b> on their turn wins immediately.</p>
      <ul class="htp-list">
        <li>Colony — <b>1 VP</b></li>
        <li>Spaceport — <b>2 VP</b> (a colony upgraded; net +1 when you build it)</li>
        <li>Trade-station friendship marker — <b>2 VP</b></li>
        <li>Pirate-base / ice-planet medal — <b>1 VP</b> each</li>
        <li>Every <b>2 fame medal pieces</b> — <b>1 VP</b></li>
      </ul>
      <p>Earn points by spreading across the galaxy: build new colonies and spaceports on distant
      planets, and trade stations at alien outposts.</p>`,
  },
  {
    id: "setup",
    title: "Initial Placement",
    tag: "Setup",
    body: `
      <p>Each player starts with their <b>2 colonies and 1 spaceport</b> already placed in the
      Catanian Colonies, plus <b>1 colony ship</b> on a spaceport site, ready to launch.</p>
      <p>A colony always sits on an <b>intersection between two planets</b>, so it can earn two
      different resources. Choose wisely — your opening real-estate decides which resources flow to you.</p>
      <p>Starting bonuses every commander receives:</p>
      <ul class="htp-list">
        <li><b>3 resource cards</b> drawn from the reserve pile</li>
        <li><b>1 fame medal piece</b></li>
        <li><b>1 bonus attachment of your choice</b> for the mothership:</li>
      </ul>
      <div class="htp-bonus">
        <span class="htp-bonus-opt"><span class="htp-bonus-ic">${boosterSvg()}</span>Booster <em>+1 speed</em></span>
        <span class="htp-bonus-opt"><span class="htp-bonus-ic">${cannonSvg()}</span>Cannon <em>+1 combat</em></span>
        <span class="htp-bonus-opt"><span class="htp-bonus-ic">${freightPodSvg()}</span>Freight Pod <em>+1 capacity</em></span>
      </div>
      <p>Players roll the dice for turn order — the highest roller goes first.</p>`,
  },
  {
    id: "production",
    title: "Dice & Resources",
    tag: "Produce",
    body: `
      <p>Your turn opens with the <b>Production Phase</b>. Roll both dice; their sum decides which
      planets produce this turn.</p>
      <p>For every <b>colony</b> or <b>spaceport</b> you have next to a planet showing the rolled
      number, you take <b>1 matching resource</b> card from the supply. Planets produce:</p>
      <ul class="htp-list htp-res">
        <li>${resCard("ore")} Red planet → <b>Ore</b></li>
        <li>${resCard("fuel")} Orange planet → <b>Fuel</b></li>
        <li>${resCard("carbon")} Blue planet → <b>Carbon</b></li>
        <li>${resCard("food")} Green planet → <b>Food</b></li>
        <li>${resCard("goods")} Multicolor planet → <b>Goods</b></li>
      </ul>
      <p>Note: unlike classic Catan, a spaceport still produces only <b>1</b> resource per adjacent
      planet — not two. Bigger number discs (<b>6</b> and <b>8</b>) hit most often; <b>2</b> and
      <b>12</b> are rare.</p>
      <p><b>Reserve pile bonus:</b> on your own roll you also draw free cards based on your score —
      <b>2 cards at 4–7 VP</b>, <b>1 card at 8–9 VP</b>, and <b>none at 10+ VP</b>.</p>`,
  },
  {
    id: "trade",
    title: "Trading",
    tag: "Trade",
    body: `
      <p>In the <b>Trade & Build Phase</b> you may trade and build in any order, as often as your
      cards allow.</p>
      <p><b>Trade with players:</b> on your turn, offer resources to anyone and listen to
      counter-offers — only you can finalize the deal. When it is <i>not</i> your turn, you may only
      trade with the player who rolled.</p>
      <p><b>Trade with the supply:</b></p>
      <ul class="htp-list">
        <li><b>3:1</b> — return 3 identical resources for any 1 resource.</li>
        <li><b>2:1 goods</b> — goods are special: trade 2 goods for any 1 resource.</li>
      </ul>
      <p>Alien <b>friendship cards</b> can improve these rates (for example, Merchants give better
      exchange deals). "Success in trading leads to success in building."</p>`,
  },
  {
    id: "build",
    title: "Building & Costs",
    tag: "Build",
    body: `
      <p>Return the right resource cards to the supply to build. You can only build a piece if it
      remains in your personal supply or the upgrades tray.</p>
      <table class="htp-costs">
        <tr><td class="ci">${colonyShipSvg("#ffd23f")}</td><td>Colony Ship</td><td>${cost([["ore", 1], ["fuel", 1], ["carbon", 1], ["food", 1]])}</td></tr>
        <tr><td class="ci">${tradeShipSvg("#4fa8ff")}</td><td>Trade Ship</td><td>${cost([["ore", 1], ["fuel", 1], ["goods", 2]])}</td></tr>
        <tr><td class="ci">${spaceportSvg("#ffd23f")}</td><td>Spaceport</td><td>${cost([["carbon", 3], ["food", 2]])}</td></tr>
        <tr><td class="ci">${boosterSvg()}</td><td>Booster <span class="htp-mini">+1 speed</span></td><td>${cost([["fuel", 2]])}</td></tr>
        <tr><td class="ci">${cannonSvg()}</td><td>Cannon <span class="htp-mini">+1 combat</span></td><td>${cost([["carbon", 2]])}</td></tr>
        <tr><td class="ci">${freightPodSvg()}</td><td>Freight Pod <span class="htp-mini">+1 capacity</span></td><td>${cost([["ore", 2]])}</td></tr>
      </table>
      <p><b>Ships</b> are built on an unoccupied <b>spaceport site</b> (the 2 intersections beside a
      spaceport). <b>Spaceports</b> are built by upgrading one of your colonies — place a shipyard
      ring around it. Mothership upgrades attach to your mothership: up to <b>6 boosters</b>,
      <b>6 cannons</b>, and <b>5 freight pods</b>.</p>`,
  },
  {
    id: "flight",
    title: "Flight: Shake & Move",
    tag: "Fly",
    body: `
      <p>In the <b>Flight Phase</b> you first <b>shake your mothership</b>. Two colored balls fall
      into the engine cone and set your <b>base speed</b>:</p>
      <ul class="htp-list">
        <li><b>No black ball:</b> base speed = the two ball values added (3–5).</li>
        <li><b>A black ball:</b> base speed is always <b>3</b>, and you must resolve an
        <b>encounter</b> before moving.</li>
      </ul>
      <p>Your <b>speed</b> = base speed + boosters on your mothership (+ any Scientist boosters). It
      applies to <b>every</b> one of your ships. Move each ship up to that many intersections.</p>
      <p><b>Flight rules:</b> you may move fewer spaces or not at all, and may return to spaces you
      previously occupied. You can pass <i>through</i> ships, colonies and spaceports (they still
      count toward distance), but no two pieces may share an intersection, and you can't end on
      another player's spaceport site (no blockades).</p>`,
  },
  {
    id: "explore",
    title: "Explore & Colonize",
    tag: "Colony",
    body: `
      <p>Reach an intersection next to an <b>unexplored planetary system</b> and you immediately
      flip its face-down number discs — revealing planets, pirate bases or ice planets. Your ship
      may keep moving afterward if speed remains.</p>
      <p><b>Establish a colony:</b> end a <b>colony ship's</b> flight on an empty colony site (an
      intersection between two planets). Return the transport ship to your supply and place a colony.
      It scores <b>1 VP</b> and starts producing on the next roll.</p>
      <p>You <b>cannot</b> colonize a site next to an active pirate base or ice planet — clear it
      first.</p>`,
  },
  {
    id: "outposts",
    title: "Outposts & Trade Stations",
    tag: "Outpost",
    body: `
      <p>Beyond the planets lie <b>4 alien outposts</b> — Green Folk, Scientists, Merchants and
      Diplomats. Fly a <b>trade ship</b> onto an outpost's central <b>docking point</b> and you must
      establish a <b>trade station</b> there.</p>
      <p><b>Freight pods required:</b> your mothership's freight-pod count must be <i>greater</i> than
      the number of trade stations already at that outpost.</p>
      <p><b>Friendship card:</b> after docking, pick one face-up card from that civilization and use
      its power right away. Each civilization helps differently:</p>
      <div class="htp-civs">
        <div class="htp-civ"><span class="htp-civ-ic">${civAvatarSvg("greenFolk")}</span>
          <div><b>Green Folk</b> — bountiful harvests. Their cards hand you <b>extra resources</b>,
          turning your best planets into even bigger producers.</div></div>
        <div class="htp-civ"><span class="htp-civ-ic">${civAvatarSvg("scientists")}</span>
          <div><b>Scientists</b> — advanced tech. Their cards grant <b>permanent boosters and cannons</b>
          that count toward your speed and combat, on top of your mothership's upgrades.</div></div>
        <div class="htp-civ"><span class="htp-civ-ic">${civAvatarSvg("merchants")}</span>
          <div><b>Merchants</b> — master traders. Their cards give you <b>better exchange rates</b>
          with the supply, so scarce resources cost you fewer cards.</div></div>
        <div class="htp-civ"><span class="htp-civ-ic">${civAvatarSvg("diplomats")}</span>
          <div><b>Diplomats</b> — influence &amp; fame. <i>Reduced Tribute</i> raises your 7-discard
          limit, and <i>Fame for Sale</i> lets you <b>buy fame</b> (1 goods → 1 fame piece).</div></div>
      </div>
      <p><b>Friendship marker (2 VP):</b> whoever has the <b>most</b> trade stations at an outpost
      holds its marker. Overtake a rival and the marker — and its 2 VP — moves to you.</p>`,
  },
  {
    id: "encounters",
    title: "Encounters",
    tag: "Cards",
    body: `
      <p>A <b>black ball</b> when you shake triggers an <b>encounter</b>. The player to your left
      reads the card; only the reader sees the outcomes. You must <b>commit your choice</b> — pick a
      number (often "offer 0–3 resources") or answer yes/no — <i>before</i> the result is revealed.</p>
      <p>Encounters are wildly varied: friendly Merchants, distress calls, Travelers, and disguised
      <b>pirates</b> who attack if you offer too little. Some are resolved by shaking and comparing
      <b>mothership strength</b> against a rival.</p>
      <p>Outcomes can win or cost you <b>resources, upgrades, and fame medal pieces</b>. The 2
      <b>Wear &amp; Tear</b> cards affect <i>everyone</i> at once. Resolve the encounter fully, then
      move your ships.</p>`,
  },
  {
    id: "hazards",
    title: "Pirates & Ice Planets",
    tag: "Clear",
    body: `
      <p>Exploring can reveal hazards that block colonization until cleared. Each shows a threshold
      number.</p>
      <p><b>Pirate base:</b> move a ship adjacent and, if your <b>cannons</b> (plus any Scientist
      cannons) <b>≥</b> the token's number, you defeat it instantly.</p>
      <p><b>Ice planet:</b> move a ship adjacent and, if your <b>freight pods</b> <b>≥</b> the token's
      number, you terraform it instantly.</p>
      <p>Either way you flip the token into a <b>fame medal worth 1 VP</b> (this one can never be
      lost), drop a fresh number disc on the planet, and may then colonize it.</p>`,
  },
  {
    id: "seven",
    title: "Rolling a 7",
    tag: "7",
    body: `
      <p>A rolled <b>7</b> produces nothing from the planets. Instead:</p>
      <ul class="htp-list">
        <li>Every player holding <b>more than 7 cards</b> discards <b>half</b> (rounded down). Some
        friendship cards (Diplomats' Reduced Tribute) raise this limit.</li>
        <li>You <b>steal 1 random card</b> from one opponent of your choice.</li>
        <li>Each opponent then draws <b>1 free card</b> from the reserve pile.</li>
        <li>Finally, if you are entitled to them, you take <b>1–2 cards</b> from the
        reserve pile (2 cards at 4–7 VP, 1 at 8–9 VP, none at 10+).</li>
      </ul>`,
  },
  {
    id: "faq",
    title: "Quick FAQ",
    tag: "FAQ",
    body: `
      <div class="htp-faq">
        <p class="q">Does a spaceport produce two resources like in classic Catan?</p>
        <p class="a">No. A spaceport produces just <b>1</b> resource per adjacent planet, the same
        as a colony.</p>
        <p class="q">Why didn't my VP jump by 2 when I built a spaceport?</p>
        <p class="a">A spaceport upgrades a colony you already scored, so you advance just
        <b>1</b> space (1 → 2 VP).</p>
        <p class="q">Can ships block each other?</p>
        <p class="a">You can fly <i>through</i> other pieces but can't <i>end</i> on an occupied
        intersection, and never on another player's spaceport site.</p>
        <p class="q">Where can I build new ships?</p>
        <p class="a">Only on an empty <b>spaceport site</b> — the two intersections next to one of
        your spaceports. Build a second spaceport to launch from new regions.</p>
        <p class="q">Can I lose victory points?</p>
        <p class="a">Yes — a rival can take an outpost's friendship marker (−2 VP), and some
        encounters cost fame medal pieces. Pirate/ice medals can never be lost.</p>
      </div>`,
  },
];

let openCount = 0; // guard against double-open

/** Open the More overlay (How to Play + About tabs). */
export function openMorePanel(): void {
  if (openCount > 0) return;
  openCount++;

  const overlay = el(`<div class="acct-overlay more-overlay"></div>`);
  const card = el(`
    <div class="acct-card more-card">
      <button class="acct-close" title="Close">✕</button>
      <div class="more-head">
        <div class="more-kicker">Commander's handbook</div>
        <div class="acct-card-title">More</div>
      </div>
      <div class="acct-tabs more-tabs">
        <button class="acct-tab active" data-tab="howto">How to Play</button>
        <button class="acct-tab" data-tab="privacy">Privacy</button>
        <button class="acct-tab" data-tab="terms">Terms</button>
        <button class="acct-tab" data-tab="about">About</button>
      </div>
      <div class="acct-body more-body"></div>
    </div>`);
  overlay.appendChild(card);

  const body = card.querySelector(".more-body") as HTMLElement;
  const tabs = [...card.querySelectorAll<HTMLElement>(".acct-tab")];
  const show = (tab: string): void => {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    if (tab === "about") renderAbout(body);
    else if (tab === "privacy") renderPrivacy(body);
    else if (tab === "terms") renderTerms(body);
    else renderHowTo(body);
  };
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.tab!)));

  const close = (): void => {
    overlay.classList.remove("show");
    setTimeout(() => {
      overlay.remove();
      openCount = Math.max(0, openCount - 1);
    }, 200);
  };
  card.querySelector(".acct-close")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey);
    }
  };
  window.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));
  show("howto");
}

/** The illustrated How to Play guide: topic rail + animated content pane. */
function renderHowTo(body: HTMLElement): void {
  const view = el(`
    <div class="htp">
      <div class="htp-rail" role="tablist"></div>
      <div class="htp-content"></div>
    </div>`);
  const rail = view.querySelector(".htp-rail") as HTMLElement;
  const content = view.querySelector(".htp-content") as HTMLElement;

  const renderTopic = (topic: Topic): void => {
    // Re-inject the scene each time so its CSS animations restart from the top.
    content.replaceChildren(
      el(`
        <div class="htp-topic">
          <h3 class="htp-h">${topic.title}</h3>
          ${SCENES[topic.id] ?? ""}
          <div class="htp-text">${topic.body}</div>
        </div>`),
    );
    content.scrollTop = 0;
  };

  TOPICS.forEach((topic, i) => {
    const btn = el(
      `<button class="htp-tab ${i === 0 ? "active" : ""}" role="tab"><span class="htp-tag">${topic.tag}</span><span class="htp-tt">${topic.title}</span></button>`,
    );
    btn.addEventListener("click", () => {
      rail.querySelectorAll(".htp-tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      renderTopic(topic);
    });
    rail.appendChild(btn);
  });

  body.replaceChildren(view);
  renderTopic(TOPICS[0]!);
}

/** Privacy tab — the privacy policy. Reflects exactly what the game collects
 *  (accounts via Supabase/Google, gameplay records, friends, in-room chat) and
 *  what stays only on the device. Update the contact email + effective date. */
function renderPrivacy(body: HTMLElement): void {
  body.replaceChildren(
    el(`
      <div class="more-legal">
        <h3 class="legal-title">Privacy Policy</h3>
        <p class="legal-date">Effective date: 16 June 2026</p>
        <p>This policy explains what information Catan: Starfarers ("the game", "we") collects when
        you play, how it is used, and the choices you have. You can play <b>single-player without an
        account</b> — the sections below about accounts only apply once you sign in to play online.</p>

        <h4 class="legal-h">1. Information we collect</h4>
        <p><b>Account information.</b> When you create an account or sign in with Google, we receive
        your <b>email address</b> and store the profile details you choose: your <b>username</b>,
        <b>favorite color</b>, and <b>avatar</b>. We never see or store your password — sign-in is
        handled by our authentication provider.</p>
        <p><b>Gameplay records.</b> When you finish an online game (and single-player games while
        signed in), we store the result: final victory points, placement, the other players, and
        per-game stats (such as resources gained, distance flown, encounters, and trades). This
        powers your record and match history.</p>
        <p><b>Social features.</b> If you add friends, we store your friend list and pending
        requests. <b>Chat messages</b> you send in a game room are relayed to the other players in
        that room.</p>
        <p><b>Stored only on your device.</b> Your sound and music preferences, any saved
        single-player game, and your sign-in session are kept in your browser's local storage — not
        on our servers.</p>
        <p>We do <b>not</b> collect precise location, contacts, or device sensors, and the game does
        not run third-party advertising or tracking.</p>

        <h4 class="legal-h">2. How we use information</h4>
        <ul class="htp-list">
          <li>To create your account and show your profile to you and other players.</li>
          <li>To run online matches, friends, invitations, and in-room chat.</li>
          <li>To keep your win/loss record and game history.</li>
          <li>To keep the service working, secure, and free of abuse.</li>
        </ul>

        <h4 class="legal-h">3. How information is shared</h4>
        <p><b>With other players.</b> Your <b>username, color, avatar, online status, and game
        results</b> are visible to people you play with or who view your profile.</p>
        <p><b>With service providers.</b> We rely on trusted services to run the game: a hosted
        database and authentication provider (Supabase), Google (only if you choose Google sign-in),
        and our hosting provider. They process data on our behalf to deliver the service.</p>
        <p>We do <b>not sell</b> your personal information, and we don't share it with advertisers.</p>

        <h4 class="legal-h">4. Cookies &amp; local storage</h4>
        <p>We don't use advertising or cross-site tracking cookies. We use your browser's local
        storage to keep you signed in and to remember your settings (like sound on/off). Clearing
        your browser storage signs you out and resets those preferences.</p>

        <h4 class="legal-h">5. Data storage &amp; security</h4>
        <p>Account, friends, and game data are stored in a hosted Postgres database with row-level
        security, so each player can only modify their own records. No method of transmission or
        storage is perfectly secure, but we take reasonable measures to protect your information.</p>

        <h4 class="legal-h">6. Data retention</h4>
        <p>We keep your profile and game history for as long as your account exists so your record
        stays available. Delete your account and we remove your profile and associated records.</p>

        <h4 class="legal-h">7. Your choices &amp; rights</h4>
        <ul class="htp-list">
          <li><b>Edit</b> your username, color, and avatar any time from your profile.</li>
          <li><b>Access or delete</b> your account and its data — contact us using the email below.</li>
          <li><b>Play without an account</b> — single-player stores nothing on our servers.</li>
        </ul>
        <p>Depending on where you live, you may have additional rights (such as access, correction,
        or erasure). We honor valid requests.</p>

        <h4 class="legal-h">8. Children's privacy</h4>
        <p>The game is not directed to children under 13 (or the minimum age in your country), and we
        do not knowingly collect their personal information. If you believe a child has provided us
        data, contact us and we will remove it.</p>

        <h4 class="legal-h">9. Changes to this policy</h4>
        <p>We may update this policy as the game evolves. We'll revise the effective date above, and
        significant changes will be highlighted in the game.</p>

        <h4 class="legal-h">10. Contact</h4>
        <p>Questions or requests about your data? Reach us at
        <a class="legal-link" href="mailto:starfarersspace@gmail.com">starfarersspace@gmail.com</a>.</p>

        <p class="legal-note">This adaptation is an unofficial fan project and is not affiliated with
        or endorsed by Catan GmbH or Catan Studio.</p>
      </div>`),
  );
}

/** Terms tab — the terms of service. Plain-language, fits a free fan project.
 *  Update the contact email + effective date (and governing law) before launch. */
function renderTerms(body: HTMLElement): void {
  body.replaceChildren(
    el(`
      <div class="more-legal">
        <h3 class="legal-title">Terms of Service</h3>
        <p class="legal-date">Effective date: 16 June 2026</p>
        <p>Welcome to Catan: Starfarers. By playing the game or creating an account, you agree to
        these Terms. If you don't agree, please don't use the game.</p>

        <h4 class="legal-h">1. The game</h4>
        <p>Catan: Starfarers is a free, fan-made digital adaptation you can play solo against AI or
        online with others. We offer it as-is and may add, change, or remove features over time.</p>

        <h4 class="legal-h">2. Eligibility</h4>
        <p>You must be at least 13 years old (or the minimum age in your country) to create an
        account. By signing in you confirm you meet this requirement.</p>

        <h4 class="legal-h">3. Your account</h4>
        <p>You're responsible for activity on your account and for keeping your sign-in secure. Pick a
        username that isn't offensive or impersonating someone else — we may reclaim or change
        usernames that break these rules. See our Privacy Policy for what we collect.</p>

        <h4 class="legal-h">4. Fair play &amp; conduct</h4>
        <p>To keep the game fun for everyone, you agree not to:</p>
        <ul class="htp-list">
          <li>Cheat, exploit bugs, or use bots or automation to gain an unfair advantage.</li>
          <li>Harass, threaten, or abuse other players, including in chat.</li>
          <li>Post unlawful, hateful, or sexually explicit content, or spam.</li>
          <li>Attempt to disrupt, overload, reverse-engineer, or gain unauthorized access to the
          service or other players' accounts.</li>
          <li>Impersonate others or misrepresent your identity.</li>
        </ul>
        <p>We may suspend or remove accounts that break these rules.</p>

        <h4 class="legal-h">5. Your content</h4>
        <p>You keep ownership of the chat messages and name you submit. By sending them, you grant us
        permission to display and transmit them within the game so others can see them during play.
        You're responsible for what you post.</p>

        <h4 class="legal-h">6. Intellectual property</h4>
        <p>"CATAN", "Catan: Starfarers", and related marks are trademarks of Catan GmbH and Catan
        Studio. This is an <b>unofficial fan project</b>, not affiliated with or endorsed by them,
        based on the published rules. The game's own code and original artwork remain the property of
        their respective authors and may not be copied without permission.</p>

        <h4 class="legal-h">7. Availability</h4>
        <p>The game is provided free of charge with no guarantee of uptime. Online play depends on
        servers that may be unavailable, reset, or discontinued at any time, and in-progress games may
        be interrupted. We may modify or shut down the service without liability.</p>

        <h4 class="legal-h">8. Disclaimer of warranties</h4>
        <p>The game is provided "as is" and "as available", without warranties of any kind, whether
        express or implied, including fitness for a particular purpose and non-infringement. You use
        it at your own risk.</p>

        <h4 class="legal-h">9. Limitation of liability</h4>
        <p>To the fullest extent permitted by law, we are not liable for any indirect, incidental, or
        consequential damages, or for any lost data or game progress, arising from your use of the
        game.</p>

        <h4 class="legal-h">10. Termination</h4>
        <p>You may stop using the game and delete your account at any time. We may suspend or terminate
        access if you violate these Terms or to protect the service and its players.</p>

        <h4 class="legal-h">11. Changes to these terms</h4>
        <p>We may update these Terms as the game evolves. We'll revise the effective date above, and
        continued play after changes means you accept the updated Terms.</p>

        <h4 class="legal-h">12. Contact</h4>
        <p>Questions about these Terms? Reach us at
        <a class="legal-link" href="mailto:starfarersspace@gmail.com">starfarersspace@gmail.com</a>.</p>

        <p class="legal-note">This adaptation is an unofficial fan project and is not affiliated with
        or endorsed by Catan GmbH or Catan Studio.</p>
      </div>`),
  );
}

/** About tab — short blurb; placeholder for the social links / extras to come. */
function renderAbout(body: HTMLElement): void {
  body.replaceChildren(
    el(`
      <div class="more-about">
        <div class="more-about-logo">🚀</div>
        <h3>Catan: Starfarers</h3>
        <p>A faithful fan-made digital voyage — play solo against AI commanders or online with
        friends, racing to 15 victory points across the galaxy.</p>
        <p class="more-about-rules">Based on the official Catan: Starfarers rules by Klaus Teuber
        (Catan GmbH / Catan Studio). This adaptation is unofficial and made by fans.</p>
        <div class="more-links">
          <span class="more-link-soon">More features &amp; community links coming soon ✦</span>
        </div>
      </div>`),
  );
}
