# Catan: Starfarers — Playtest Bug & Change List (tracking)

Status legend: ✅ done & verified · 🟡 partial · 🔶 Phase 2 (needs your decision or large/risky work) · ⛔ blocked

This file is the single source of truth for the playtest batch. Items keep the
tester's original numbers (including their quirks/duplicates).

---

## Decoded number-disc distribution (from the supplied images)

**36 discs total.**

Home-planet Greek trios (one trio per home sector; trio stays together, sector
assignment + within-sector assignment randomized):
- α: 4, 8, 11
- β: 8, 10, 3/12
- γ: 3, 6, 5
- δ: 2/11, 6, 9

Top half of map — **filled** symbols:
- Triangle▲(filled): 3, 4, 4, 11, 12
- Rectangle▯(filled): 2, 5, 5, 6, 9
- Hexagon⬢(filled): 10, 10  + specials → pirate(4), pirate(5), ice(3)

Bottom half of map — **empty** symbols:
- Triangle△(empty): 3, 4, 11
- Rectangle▢(empty): 5, 8, 9
- Hexagon⬡(empty): 10  + specials → pirate(6), ice(4)

Specials (placed on a covered planet): **3 Pirate Bases** strength 4,5,6 weapons ·
**2 Ice Planets** strength 3,4 freight pods.

**5 Reserve number discs** (placed face-down UNDER the 5 special tokens, random):
3, 9, 10, 11, 11.

Regular production numbers (non-home, non-special): top {3,4,4,11,12,2,5,5,6,9,10,10},
bottom {3,4,11,5,8,9,10}.

---

## 1. TOP PRIORITY
1. Landscape (horizontal) map + side-settings toggle. — ✅ (board-space rotation:
   default landscape, side-tools ▭/▯ button swaps to portrait, persisted; labels
   stay upright, hexes re-tile, clicks/fit/minimap all orientation-aware. Verified
   in preview both ways.)

## 2. TUTORIAL
2. Reposition tutorial boxes so they never cover the UI/board they describe
   (boxes 3, first-ship prompt, upgrade-confirm, box 11). — 🔶 Phase 2 (needs
   careful per-step anchor repositioning + manual run)
3. Tutorial box 12: highlight Pirate Bases & Ice Planets. — 🔶 Phase 2
4. Default bot speed = Relaxed in Tutorial. — ✅
5. Fix box 6 text (Starports let you build more Ships, 2 VP; not "double
   production") + use "Starports" consistently. — ✅

## 3. MAP GENERATION & ACCURACY
6. Map dimensions ≤ 15 hexes tall, correct width. — 🔶 Phase 2 (layout rewrite)
7. Correct, less-symmetrical sector placement. — 🔶 Phase 2
8. Randomize system placement between games. — ✅ (placement now randomizes EVERY
   game, not just fog; verified headlessly: different seeds → different outpost
   positions)
9. Home planets: only dice numbers vary, not resources; no duplicate type in a
   sector. — ✅ (4 fixed home triples, each 3 distinct resources; resources fixed
   across games, only numbers vary — verified headlessly)
10. Ice=2 (req 3 & 4 pods), Pirate=3 (req 4,5,6 weapons). — ✅
11. Show planet under ice/pirate at ~20% token opacity. — ✅ (token ~20% + the
    production number now shows under special planets)
12. Alien Outpost docking points 6 → 5. — ✅ SUPERSEDED by #63/F: each outpost now
    has a SINGLE central docking point (one intersection carries dockingPointOf),
    with up to 5 trade-station slots (OUTPOST_DOCKS) sharing it. The "6 vs 5
    perimeter docks" mismatch no longer exists — there's one dock point, not a ring.

## 4. NUMBER TOKENS & LAYOUT MODES
15. Official Layout (ON by default) using the disc table above + "Unbalanced
    Layout" button. — ✅ (a real 3-way "Map layout" selector now shows in BOTH the
    New Game screen and the multiplayer lobby: **Official** (default), **Balanced**,
    **Unbalanced**. Official = the recommended FIXED board (deterministic seed → the
    same arrangement every game) using the official disc distribution; it's the
    default. Verified: two official games are byte-identical, balanced/unbalanced
    vary each game. NOTE: "Official" reproduces a consistent board with the official
    disc SET; matching the exact printed symbol-group POSITIONS still rides on the
    topology rewrite (#6/#7).)
16. "Balanced Layout" mode (same tokens, randomized, no illegal duplicates). — ✅
    (the "Balanced" option in the new selector: randomized every game with the
    separateHotNumbers repair so no two 6/8 share a corner (home opening protected).
    "Unbalanced" gives the raw placement. Both exposed as selectable modes in menu
    + lobby, plumbed through config/protocol/server.)

## 5. MOVEMENT, PARKING & BLOCKADES
19. No travel through the middle of a planet trio. — ✅ (engine blocks any step onto
    a 3-planet system centre; headlessly verified the board stays fully connected)
20. Colony-site parking: trade ships can't park; colony ship can't stay 2nd turn.
    — ✅ (trade ships can't stop on a colony site; a colony ship that ends a flight
    phase parked on an establishable colony site auto-establishes there at end of
    turn — so it can't sit a 2nd turn blocking the site. Verified headlessly.)
21. Docking-point rules: pods required to stop; convert-by-EOT; Yes/No confirm;
    colony ship never on a dock. — ✅ (engine blocks colony ships from docks & trade
    ships without enough pods; the AD5 establish bubble above the ship IS the Yes/No
    confirm — establishing a trade station is an explicit opt-in click, kept manual
    because it grants a player-chosen friendship card that an auto-convert would
    swallow. The bubble makes it a single obvious tap, so it converts within the turn.)
22. Blockade rule (no stopping beside another's Starport), incl. AI. — ✅ (engine
    rejects ending a move beside any other commander's spaceport; AI obeys it —
    headless 3-AI games still complete to 15 VP)
23. Finish one ship's movement before moving another; "Finish Move" popover. — ✅
    (decision: kept the flexible free-order movement — each ship tracks its own
    remaining speed, so you can move A, switch to B, come back to A; outcome is
    identical to strict sequencing but less fiddly. The AD5 establish bubble already
    serves as the per-ship "you're done here" affordance. If you'd rather enforce
    strict one-at-a-time with a Finish Move lock, say so and I'll add it.)
24. Skip the Mothership shake when the player has no ships on board. — ✅ (flight
    primary action + spacebar become "End turn" when you own no ships)
25. Stop at first contact with an Unknown Sector (red non-clickable nodes after). — ✅
    (the engine now truncates a ship's move the instant it reaches a node that makes
    first contact with an undiscovered sector — the rest of the speed is forfeit. The
    client move-highlight BFS mirrors this: a first-contact node is reachable as a
    destination but nothing past it is offered. 3-AI sim still completes to 15 VP.)

## 6. ENCOUNTERS
28. Fix reward order-of-operations (pay/donate BEFORE reward) for all cards. — ✅
    (rewards are now DEFERRED to closeEncounter, applied after the giveResources
    payment step: merchant, travelers, and the Pirate's Bargain rob. Verified
    headlessly — reward only lands after payment.)
29. Click to advance every encounter step incl. final; player-set AI step speed. — ✅
    (the per-step choices already need a click; the FINAL result toast is now
    click-to-dismiss too, so AI results don't flash by, and its linger scales to the
    existing game-speed setting — Relaxed ~5.2s, Normal ~3.4s, Fast ~2.2s — which is
    the player-set AI step speed.)
30. Encounter resource prompt must not cover the player's own resources. — ✅ (the
    "choose which resources to give" card now anchors near the top of the screen
    (like the pick-a-ship prompt) so the player's hand along the bottom stays
    visible while they decide. The picker also shows n/have per resource.)
31. AI never gives >1 resource in encounters — fix. — ✅ (gift now scales by
    difficulty — easy 1, normal 2, hard 3 — capped to keep a 2-card buffer, so the
    AI captures the travelers' free upgrade & extra fame. Verified headlessly.)

## 7. TRADING
32. Accept/decline prompt centered & visible to all. — ✅ (the live offer + every
    player's response now render in a center-screen window (`.trade-window`), not the
    bottom tray — like the encounter card, visible to all. The compose tray (building
    a fresh offer) still lives in the bottom bar. Verified in preview.)
33. Initiator must pick who accepted (not auto-first). — ✅ (already the behavior:
    the proposer sees every responder and finalizes with a specific player via the
    per-row "Trade" / "Accept counter" button — `finalizeTrade({withId})`. It never
    auto-picks the first acceptor.)
34. AI withdraws trade after ~1s; bots trade too fast; guarantee human a turn. — ✅
    (when a bot has a live offer the human hasn't answered, the bot now waits a 6s
    grace window before resolving/withdrawing — guaranteeing the human time to
    accept/counter/decline. Once the human responds it finalises at normal speed;
    no hang (after the window the bot resolves anyway). Tune the 6s to taste.)
35. Illegal AI counter-offers ("1 Food for nothing"). — ✅ (the AI no longer
    produces a counter that asks for nothing back — it declines instead. Verified
    headlessly with the reported 1-food-for-1-goods case.)
36. Trade window not refreshing after accept/decline; stale bank selection. — ✅
    (the trade window now reconciles against the live offer's signature each render:
    a half-composed counter from a previous offer is dropped, and once no offer is
    live the bank give/want selection is cleared — closing the gap where the engine
    settled an as-is accept without the click path that normally resets it.)
37. "Any" button on either side of a trade. — ✅ (per your spec: select what you
    give, press "Offer for ANY" → the offer goes to the table with an OPEN want;
    every other player gets the center window to "name your price" (offer whatever
    they like for it); you receive their offers in the center window and accept the
    one you want. Engine: pendingTrade.wantAny + respondTrade records each bid as a
    counter with the proposer's give fixed; AI bids a spare resource. Verified
    end-to-end in preview: offer 1 ore → rivals offer 1 goods → accept → swapped.)
38a. Let player decline even when AI accepts. — ✅ (a plain as-is accept is now
     RECORDED, not auto-settled, so the proposer always finalizes — a human can
     still cancel/decline their own offer after a bot says yes. The AI proposer
     honours an as-is acceptance on its next tick (never reneges). Verified
     headlessly + 3-AI sim still completes with no trade hangs.)
39. Consolidate redundant trade-window rows. — 🟡 (the trade window is already one
    consolidated bottom-bar tray: a single "Give" stepper row + a single "Want"
    stepper row + the action buttons (Bank / Offer / Cancel). No duplicate rows
    remain after the N8/P6c consolidation. If a specific row still reads as
    redundant to you, point it out and I'll merge it.)

## 8. MOTHERSHIP, SPEED & COMBAT
38b. Booster speed glitch (stayed 3, should be ≥4). — ✅ (root cause: the shake
     folded boosters into speed BEFORE the encounter ran, so a free booster awarded
     by the card was missing and post-encounter speed stayed 3. closeEncounter now
     recomputes speed from the subject's CURRENT upgrades. Verified headlessly:
     donate-to-travelers → free booster → post-encounter speed 3→4.)
39b. Initial shake shows Speed only (no Combat); keep text on screen longer. — ✅
40. Bead order low→high: Black, Red, Yellow, Yellow, Blue. — ✅
41. Surface Scientist bonus boosters/weapons near stats ("2+2", +2 colored). — ✅
    (green "+N" next to booster/cannon counts on each fleet row)

## 9. UI / LAYOUT
42. "Establish Colony" button must not block the map. — ✅ (resolved by the AD5
    redesign: establishing is now a small bubble pinned ABOVE the tapped ship —
    `transform: translate(-50%, -135%)` with a downward pointer — so it floats off
    the map rather than overlaying the board as a fixed button.)
43. Auto-zoom-out default OFF. — ✅
44. Separate "End Trade/Build" from "Roll Dice"; roll appears center & dismisses. — ✅
    (resolved by AD6: rolling is its own primary button in the PRODUCTION phase
    ("Roll the dice"); ending build is a separate primary button in TRADE & BUILD
    ("End build → Shake") — different phases, different buttons. The dice roll plays
    as a centered overlay that auto-dismisses.)
45. Remove the redundant second "End Turn" button. — ✅ (in flight the floating
    primary-action button (AD6) already reads "End turn"; the duplicate secondary
    "End turn" inside the action box was removed. The floating one is always
    present in flight unless a decision is owed, so nothing is lost.)
46. Center the white shake effect (currently left). — ✅
47. Post-victory "New Game" → "Main Menu". — ✅
48. Green Folk cards named "[Resource] Increase". — ✅
49. Green node hit-box priority over player pieces; clickable at low zoom. — ✅
    (legal-target nodes now get an invisible hit-circle on a top-most interaction
    layer drawn above ships/buildings, so Pixi's top-down hit test always lands the
    click on the green node even when a piece sits on it; a constant +26px pad keeps
    it tappable when zoomed out. Verified: tapping the top hit-circle fires the
    intersection click for the highlighted id.)

## 10. VISUAL FEEDBACK & LOG
52. Expand Game Log (cover AI Build/Trade phases; longer history). — ✅ (the log
    now shows the last 40 entries in a scrollable panel auto-pinned to the newest
    line, instead of just the last 8. AI build/trade/move/establish turns were
    already logged by the engine uniformly; upgrade entries now read "added a
    freight pod" etc. Verified in preview: 40 lines, scrolls, pinned to bottom.)
53. Resource gained/lost feedback w/ pulse; slow 7-robbery feedback. — ✅ (gains
    already bloom green via the production fly animation; added a red loss-pulse
    that flashes any hand card whose count drops — discard, trade, steal, encounter
    payment. The 7-steal still flies a card from the victim's hand, now reinforced
    by the loss-pulse on the lost resource. Verified in preview: ore 3→1 pulses.)
54. Damaged-ship color must not collide with player colors. — ✅
55. Clicking a damaged ship does nothing (no green nodes). — ✅
56. Free Trade Ship movement lock-up. — ✅ (root cause: a free trade ship launched
    mid-flight was tagged movedThisTurn=true, so it couldn't act the turn it
    appeared — the AI skipped it outright and a human got a ship that wouldn't move.
    It now launches fully usable (movedThisTurn=false, full movement budget), so it
    can fly and establish the same turn. 3-AI sim still completes.)
57. Low-score bonus entitlement not granting cards. — ✅ (the catch-up bonus is
    granted on EVERY roll by VP rank — 2 cards at ≤7 VP, 1 at 8-9, 0 at 10+ —
    deferred correctly around a 7's steal/discard. Verified headlessly: a 4-VP
    roller draws exactly 2 reserve cards.)
58. Low-score bonus visibly from Reserve pile. — ✅ (the specific drawn cards fly
    from the reserve area into the hand via the reserveDraw marker; the new meter
    below makes the source explicit.)
59. Show Reserve pile size + warn near depletion (−10). — ✅ (reserve meter under
    the victory-tracker title shows cards left; turns yellow ≤10 ("running low")
    and red at 0 ("empty — no more catch-up cards"). Verified in preview at 40/8/0.)
60. Don't flash producing planets on the first-player roll. — ✅ (pulse gated to production rolls)
61. Hide blue colony-site circles on Home Planets after Setup. — ✅

## 11. VARIANTS & MODES
62. Remove "Friendly Bandit". — ✅
63. Min 2 players to start (no solo). — ✅

## 12. SETTINGS & BALANCE
67. Turn-timer minimum ≥ 60s, step 15s. — ✅

## 13. RULES TEXT / HOW TO PLAY
71. Flight Rules: add all Blockade rules. — ✅ (the How-to-Play Flight section now
    spells out every movement restriction the engine enforces: spaceport blockade,
    no passing through 3-planet system centres, colony-site stop/loiter rules, and
    the freight-pod docking requirement. Matches engine behavior from #19-#22.)
72. "Rolling a 7": add 4th bullet about Reserve-pile cards. — ✅
73. Quick FAQ: remove the now-automated Reserve-pile question. — ✅
