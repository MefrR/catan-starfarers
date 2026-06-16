// The "More" panel: a tabbed overlay reached from the main menu. For now it
// holds the illustrated "How to Play" guide (every rule from the printed
// rulebook, each section paired with a small looping animation that shows the
// action — like the animated thumbnails in colonist.io's rules popup). The
// About tab is a placeholder for the social links / extras coming later.

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

// --- Resource colors (match the in-game hand cubes). ---
const ORE = "#d8453a";
const FUEL = "#e08a2e";
const CARBON = "#3d7fd6";
const FOOD = "#3fae6b";
const GOODS = "#9a6fd0";

// ---------------------------------------------------------------------------
// Tiny inline SVG icons reused across the animated scenes.
// ---------------------------------------------------------------------------
const shipSvg = (c: string): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M24 5 L33 32 L24 27 L15 32 Z" fill="${c}" stroke="rgba(0,0,0,.4)" stroke-width="1.5" stroke-linejoin="round"/><circle cx="24" cy="18" r="3.4" fill="#0a1322" opacity=".55"/></svg>`;

const colonySvg = (c: string): string =>
  `<svg class="htp-ic" viewBox="0 0 48 48"><path d="M11 35 H37 V25 A13 13 0 0 0 11 25 Z" fill="${c}" stroke="rgba(0,0,0,.4)" stroke-width="1.5" stroke-linejoin="round"/><rect x="20" y="27" width="8" height="8" rx="1.5" fill="#0a1322" opacity=".5"/></svg>`;

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
        <li><b>1 booster</b> attached to the mothership (base speed help)</li>
      </ul>
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
      number, you take <b>1 matching resource</b> from the supply. Planets produce:</p>
      <ul class="htp-list htp-res">
        <li><span style="--rc:${ORE}" class="htp-dot-res"></span> Red → <b>Ore</b></li>
        <li><span style="--rc:${FUEL}" class="htp-dot-res"></span> Orange → <b>Fuel</b></li>
        <li><span style="--rc:${CARBON}" class="htp-dot-res"></span> Blue → <b>Carbon</b></li>
        <li><span style="--rc:${FOOD}" class="htp-dot-res"></span> Green → <b>Food</b></li>
        <li><span style="--rc:${GOODS}" class="htp-dot-res"></span> Multicolor → <b>Goods</b></li>
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
      <p>Return the right resources to the supply to build. You can only build a piece if it remains
      in your personal supply or the upgrades tray.</p>
      <table class="htp-costs">
        <tr><td>Colony Ship</td><td><span class="cc" style="--rc:${ORE}"></span>1 <span class="cc" style="--rc:${FUEL}"></span>1 <span class="cc" style="--rc:${CARBON}"></span>1 <span class="cc" style="--rc:${FOOD}"></span>1</td></tr>
        <tr><td>Trade Ship</td><td><span class="cc" style="--rc:${ORE}"></span>1 <span class="cc" style="--rc:${FUEL}"></span>1 <span class="cc" style="--rc:${GOODS}"></span>2</td></tr>
        <tr><td>Spaceport</td><td><span class="cc" style="--rc:${CARBON}"></span>3 <span class="cc" style="--rc:${FOOD}"></span>2</td></tr>
        <tr><td>Booster <span class="htp-mini">(+1 speed)</span></td><td><span class="cc" style="--rc:${FUEL}"></span>2</td></tr>
        <tr><td>Cannon <span class="htp-mini">(+1 combat)</span></td><td><span class="cc" style="--rc:${CARBON}"></span>2</td></tr>
        <tr><td>Freight Pod <span class="htp-mini">(+1 capacity)</span></td><td><span class="cc" style="--rc:${ORE}"></span>2</td></tr>
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
      its power right away (resource doubling, permanent speed/combat, better trades, fame deals…).</p>
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
        <p class="q">When can I take my free reserve-pile cards?</p>
        <p class="a">During production or your trade &amp; build phase — but once you shake your
        mothership for flight, you forfeit them.</p>
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
