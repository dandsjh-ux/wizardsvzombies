# Wizards vs Zombies

A co-op, isometric ARPG-style village defence game for **up to 3 players**, built with **three.js** and a small
authoritative **Node.js + WebSocket** server. It plays with a mouse or on a touch tablet.

Zombies attack a large walled medieval village in **30 waves**. Every 10th wave brings a boss, and each new tier of
10 waves makes the horde tougher. If they break through the palisade and destroy the **Well of Renewal** in the
village centre, the village falls. Clear a wave and the defenders get **30 seconds** to heal, shop, repair and fortify.

All 3D art comes from the attached *medieval village kit* GLB: buildings, palisade fences, gates, the well, props,
trees, terrain and the two rigged characters. The rigged characters are recoloured and animated in code to make the
wizards, the zombies, the bosses and the villagers.

## Features

- **One shared battle.** The first person to open the game and pick a class starts the battle. Anyone who joins later
  drops into the battle already in progress, up to 3 wizards. Late joiners get a level and gold catch-up.
- **Automatic reconnection.** Each browser keeps a token. If the connection drops (or the page reloads) the client
  reconnects and you are back in the same wizard with your level, gold, items and spells. Your slot is held for
  5 minutes. If every player is away, the world pauses; after 10 minutes with nobody there it resets.
- **Three wizard classes**, each with 8 spells to unlock and rank up (★★★) from Mystra the Arcanist:
  - **Striker** (offensive): Firebolt, Frost Shard, Chain Lightning, Flame Nova, Meteor, Arcane Barrage, Blizzard,
    Dragon's Breath.
  - **Healer** (defensive): Healing Light, Mend (repairs fences, gates, constructs and the Well), Holy Smite,
    Sanctuary, Divine Shield, Fortify, Purifying Nova, Divine Intervention.
  - **Augmenter** (buffs and attack): Arcane Spark, Empower, Haste, Hex of Weakness, Mana Surge, Gravity Well,
    Spectral Blades, Ascendance.
- **Constructs**: each class can build 3 kinds, using timber and stone bought from the Trader and enchanted with mana.
  - Striker: Flame Turret, Ember Trap, Storm Spire.
  - Healer: Stone Barricade, Healing Shrine, Mending Totem.
  - Augmenter: Frost Obelisk, Mana Font, Arcane Amplifier.
- **Gareth the Trader** sells health and mana potions, Carpenter's Kits (fence repair), Fire Bombs, Iron
  Reinforcement (permanently stronger fence sections), a Phoenix Charm (auto-revive), timber and stone.
- **HP, rechargeable mana, XP and levels** (up to 30). Each level raises max HP, max mana and spell power. Every wizard
  in the party gets XP for every kill. Healers also earn XP and gold for healing and repairs.
- **Well of Renewal**: walk up to the well and it fully restores your health and mana. Each wizard can use it once
  every 90 seconds.
- **Attack indicators**:
  - Red edge-of-screen arrows point to wall sections, gates or breaches under attack, and to the Well.
  - Orange arrows show where the next wave will come from.
  - Fence sections flash red when hit.
  - The rotating minimap shows fence health, zombies, the boss and incoming directions.
  - Announcements call out breaches and attacks on the Well.
- **Word Magic quiz**: Professor Quill stands outside the Library (north-west). Answer Year 4/5 English questions on
  **nouns, adjectives and verbs** (plurals, irregular past tenses, comparatives and superlatives, modal verbs,
  collective, proper and abstract nouns, prefixes and suffixes, expanded noun phrases) to earn XP. Each correct answer
  in a row raises the multiplier (×1, ×1.5, ×2 … up to ×5). The bank has 50 questions, and a wrong answer shows the
  correct one with an explanation.
- **Balance**: zombie numbers and HP scale with party size. XP and gold are normalised so a solo wizard levels as fast
  as a full party. Zombie types are Walkers, Runners, Brutes, Spitters (ranged), Bloaters (explode and wreck fences)
  and Wraiths (pass through fences). Elite brutes appear on waves 5, 15 and 25. The bosses are **Gravecrusher**
  (wave 10), **the Plague Mother** (wave 20) and **the Lich King** (wave 30). Boss slams and novas show a red warning
  circle on the ground first.

## Controls

| Action | Mouse / keyboard | Touch |
| --- | --- | --- |
| Move | Click the ground (hold to keep walking), or WASD / arrows | Tap the ground; hold and drag to walk |
| Attack | Click a zombie. Auto-attack (V) fires wand bolts at nearby zombies | Tap a zombie (auto-attack is on by default) |
| Cast spell | 1–8 casts at the mouse cursor; right-click repeats the last spell | Tap a spell: it picks a target for you (nearest zombie, best cluster, most-hurt ally, most-damaged fence) |
| Items | Q health, E mana, R repair kit, T fire bomb, G iron reinforcement | Item bar buttons |
| Talk / use the Well | Click the villager or Well, or press F nearby | Tap them, or the context button |
| Build | B, then click to place (R rotates, Esc cancels) | Build button, tap to position, then Place |
| Camera | `[` `]` rotate, mouse wheel zooms | Minimap buttons, pinch to zoom |
| Other | Enter chat, M mute, H help, Space ready-up during breaks | Chat button |

## Running locally

```bash
npm install
npm start            # http://localhost:3000
```

Open the page in up to three browsers or tabs. The first one to pick a class starts the battle.

Tests (rules, quiz bank, joining, reconnecting, waves, shops, building and the quiz through the message API):

```bash
npm test
```

To try late waves quickly, start the server with `DEV_COMMANDS=1 npm start` and run commands from the browser
console:

```js
__game.net.send({ t: 'dev', cmd: 'wave', n: 20 })   // jump to wave 20
__game.net.send({ t: 'dev', cmd: 'level', n: 15 })  // level up
__game.net.send({ t: 'dev', cmd: 'spells' })        // all class spells at rank 3
__game.net.send({ t: 'dev', cmd: 'rich' })          // gold, timber and stone
```

Dev commands are ignored unless that environment variable is set.

## Deploying to Render

The repo includes a `render.yaml` Blueprint:

1. Push this repo to GitHub.
2. In Render choose **New → Blueprint** and select the repo. It creates a Node web service that runs
   `npm ci --omit=dev` and `npm start`, with a health check at `/healthz`. Or create a **Web Service** by hand with
   those two commands. Render provides `PORT`, and WebSockets work out of the box at `/ws`.
3. Keep the service at **one instance**. The single shared battle lives in that server process's memory.

On Render's free plan the service sleeps after about 15 minutes without traffic, so the first visitor after a sleep
waits a little while it wakes. A restart or redeploy starts a fresh battle.

## Project layout

```
server/index.js      Express static server + WebSocket endpoint + fixed 20 Hz game loop
server/game.js       Authoritative simulation: waves, zombie AI (flow-field pathing), spells, constructs,
                     shops, Well, quiz, XP, joining, reconnecting
server/quiz-bank.js  The 50 Word Magic questions (answers never leave the server)
shared/data.js       Classes, spells, constructs, items, zombie types, wave scaling, XP curve
shared/layout.js     Seeded village map: buildings, decorations, palisade sections, NPC spots
shared/geom.js       Collision shapes, nav grid, A* (client) and Dijkstra flow fields (server)
shared/placement.js  Construct placement rules shared by the client preview and the server
public/js/*.js       three.js client: world, characters, effects, HUD, input, networking, audio
public/assets/village-kit.glb   Optimised kit (one copy of each asset)
tools/extract-kit.mjs           Rebuilds village-kit.glb from the full kit GLB
```

### About the GLB

The original kit (13 MB) contains hundreds of byte-identical copies of the same meshes, such as 175 terrain blobs and
212 path stones. `tools/extract-kit.mjs` keeps one template of each asset, centred at the origin, which brings it down
to about 3 MB. The game places and instances everything itself. To regenerate it:

```bash
node tools/extract-kit.mjs path/to/kit-medieval-village-kit.glb
```
