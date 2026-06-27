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
12. Alien Outpost docking points 6 → 5. — 🔶 Phase 2 (the engine models a SINGLE
    centre docking point per outpost while the renderer draws several — the count
    mismatch needs the docking model reconciled first.)

## 4. NUMBER TOKENS & LAYOUT MODES
15. Official Layout (ON by default) using the disc table above + "Unbalanced
    Layout" button. — 🔶 Phase 2 (needs map-gen rewrite; data decoded above)
16. "Balanced Layout" mode (same tokens, randomized, no illegal duplicates). — 🔶 Phase 2

## 5. MOVEMENT, PARKING & BLOCKADES
19. No travel through the middle of a planet trio. — ✅ (engine blocks any step onto
    a 3-planet system centre; headlessly verified the board stays fully connected)
20. Colony-site parking: trade ships can't park; colony ship can't stay 2nd turn.
    — 🟡 (trade ships can no longer stop on a colony site ✅; the "colony ship must
    vacate/convert by its 2nd turn" rule is turn-flow, still to do)
21. Docking-point rules: pods required to stop; convert-by-EOT; Yes/No confirm;
    colony ship never on a dock. — 🟡 (engine now blocks colony ships from docks &
    trade ships without enough pods ✅; the Yes/No confirm + convert-by-EOT are
    client/turn-flow, still to do)
22. Blockade rule (no stopping beside another's Starport), incl. AI. — ✅ (engine
    rejects ending a move beside any other commander's spaceport; AI obeys it —
    headless 3-AI games still complete to 15 VP)
23. Finish one ship's movement before moving another; "Finish Move" popover. — 🔶 Phase 2 (client/turn-flow)
24. Skip the Mothership shake when the player has no ships on board. — ✅ (flight
    primary action + spacebar become "End turn" when you own no ships)
25. Stop at first contact with an Unknown Sector (red non-clickable nodes after). — 🔶 Phase 2 (client/turn-flow)

## 6. ENCOUNTERS
28. Fix reward order-of-operations (pay/donate BEFORE reward) for all cards. — ✅
    (rewards are now DEFERRED to closeEncounter, applied after the giveResources
    payment step: merchant, travelers, and the Pirate's Bargain rob. Verified
    headlessly — reward only lands after payment.)
29. Click to advance every encounter step incl. final; player-set AI step speed. — 🔶 Phase 2
30. Encounter resource prompt must not cover the player's own resources. — 🔶 Phase 2
31. AI never gives >1 resource in encounters — fix. — ✅ (gift now scales by
    difficulty — easy 1, normal 2, hard 3 — capped to keep a 2-card buffer, so the
    AI captures the travelers' free upgrade & extra fame. Verified headlessly.)

## 7. TRADING
32. Accept/decline prompt centered & visible to all. — 🔶 Phase 2
33. Initiator must pick who accepted (not auto-first). — 🔶 Phase 2
34. AI withdraws trade after ~1s; bots trade too fast; guarantee human a turn. — 🔶 Phase 2
35. Illegal AI counter-offers ("1 Food for nothing"). — ✅ (the AI no longer
    produces a counter that asks for nothing back — it declines instead. Verified
    headlessly with the reported 1-food-for-1-goods case.)
36. Trade window not refreshing after accept/decline; stale bank selection. — 🔶 Phase 2
37. "Any" button on either side of a trade. — 🔶 Phase 2
38a. Let player decline even when AI accepts. — 🔶 Phase 2
39. Consolidate redundant trade-window rows. — 🔶 Phase 2

## 8. MOTHERSHIP, SPEED & COMBAT
38b. Booster speed glitch (stayed 3, should be ≥4). — 🔶 Phase 2 (needs a repro
     of the post-encounter speed calc; not yet fixed.)
39b. Initial shake shows Speed only (no Combat); keep text on screen longer. — ✅
40. Bead order low→high: Black, Red, Yellow, Yellow, Blue. — ✅
41. Surface Scientist bonus boosters/weapons near stats ("2+2", +2 colored). — ✅
    (green "+N" next to booster/cannon counts on each fleet row)

## 9. UI / LAYOUT
42. "Establish Colony" button must not block the map. — 🔶 Phase 2
43. Auto-zoom-out default OFF. — ✅
44. Separate "End Trade/Build" from "Roll Dice"; roll appears center & dismisses. — 🔶 Phase 2 (not done)
45. Remove the redundant second "End Turn" button. — 🔶 Phase 2 (needs visual
    confirm of which of the End-turn controls is the duplicate before removing.)
46. Center the white shake effect (currently left). — ✅
47. Post-victory "New Game" → "Main Menu". — ✅
48. Green Folk cards named "[Resource] Increase". — ✅
49. Green node hit-box priority over player pieces; clickable at low zoom. — 🔶 Phase 2

## 10. VISUAL FEEDBACK & LOG
52. Expand Game Log (cover AI Build/Trade phases; longer history). — ✅ (the log
    now shows the last 40 entries in a scrollable panel auto-pinned to the newest
    line, instead of just the last 8. AI build/trade/move/establish turns were
    already logged by the engine uniformly; upgrade entries now read "added a
    freight pod" etc. Verified in preview: 40 lines, scrolls, pinned to bottom.)
53. Resource gained/lost feedback w/ pulse; slow 7-robbery feedback. — 🔶 Phase 2
54. Damaged-ship color must not collide with player colors. — ✅
55. Clicking a damaged ship does nothing (no green nodes). — ✅
56. Free Trade Ship movement lock-up. — 🔶 Phase 2
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
