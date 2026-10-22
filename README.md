# ReLive

A shared 3D island that many people can be in at the same time. They can build anything they like
(houses, roads, gardens, forests, whole towns), reshape the land, own plots, and chat. Everything
anyone builds is saved and everyone online sees it live.

## Play

Double-click **Play ReLive.cmd**. It starts the world server and opens `http://localhost:8799/`.
Keep the black server window open while you play.

**Friends on the same Wi-Fi:** run `Play ReLive.cmd -Lan` once **as administrator**. The window then
prints addresses like `http://192.168.1.20:8799/` for your friends to open. Windows may ask to allow the
port through the firewall.

To test with two people on one PC, open a second tab at `http://localhost:8799/?as=friend`. It joins as
a separate person.

## Controls

| | |
|---|---|
| Move | `W A S D`, `Shift` to run, `Space` to jump or swim up |
| Fly | `F` (then `Space` up, `C` down) |
| Look | right-drag (or plain drag in Explore), scroll to zoom; zoom all the way in for first person |
| Free camera | `V` (or the camera button): `W A S D` fly the view over the land, middle-drag pan, `Q`/`E` orbit, wheel zooms out to 300 m. The House tool turns it on by itself. |
| Tools | `1` Explore · `2` Build · `3` Select & edit · `4` House generator · `5` Landscape · `6` Nature · `7` Land |
| Placing | `R` turn 90°, `Q`/`E` turn 15°, `[` `]` lift (Shift: 1 m), `G` grid on/off, `Esc` cancel |
| Editing | click to select, `G` move, `Del` delete, `Ctrl+D` copy, `Ctrl+Z` undo |
| Social | the ⌄ button folds the chat away to a round chat button (with an unread count); click it or press `Enter` to open it. `Enter` chat, `/w name msg`, `/near msg`, `/me …`, `/wave /cheer /clap /point /dance /sit`, `/tp name`, `/home` |
| Other | `M` map (click to teleport), `P` people, `H` help, `Tab` hide panel |

## What's in it

- **World:** a 1 km procedurally generated island with mountains, hills, lakes, beaches and forests of
  about 1,500 trees. Photo-scanned ground textures, real-time shadows, a sky with clouds and stars, an
  ocean with shoreline foam, wind-blown grass, and a shared 40-minute day/night cycle with working lamps.
- **Building:** about 30 modular parts (walls with real door and window openings, floors, stairs, gable,
  hip, lean-to and flat roofs, roads, bridges, a pool, fences, lights), each in many photo-scanned finishes
  with tints and resizing. There are about 70 photo-scanned Poly Haven props (furniture, lamps, statues, a
  ship, rocks) and six procedural tree species. Everything you build can be walked on, climbed and entered.
- **House generator:** drag a footprint and pick a style (cottage, modern villa, cabin, farmhouse,
  Mediterranean, glass office), 1-3 storeys and a roof. It builds a furnished house out of ordinary parts,
  so you can edit any piece afterwards.
- **Landscape and nature:** raise, lower, flatten, smooth and paint the ground. Paint or erase forests,
  bushes and rocks.
- **Land:** claim up to 6 plots of 32 × 32 m. Nobody else can build on or reshape your plots unless you
  open them. You can't claim land where someone else has already built.
- **Social:** avatars with name tags and speech bubbles, global, nearby and private chat, emotes, a people
  list, player cards (wave, message, visit, friend, mute), and a strong-language filter.

## Speed

Graphics are set to **Auto**. ReLive reads your graphics chip's name and starts on Low, Medium or High,
then **dynamic resolution** lowers the sharpness a little whenever the frame rate drops below 40 fps and
raises it again when there's room. You can override both in Settings.

On laptops with two graphics chips (for example Intel UHD + NVIDIA MX150), browsers usually run on the
weaker Intel chip. To use the NVIDIA one, open Windows **Settings → System → Display → Graphics**, add
your browser (Edge or Chrome), set it to **High performance**, and restart the browser.

## How it works

- `server/relive-server.ps1`: PowerShell + inline C# (no Node or Python needed). It serves the game,
  runs the WebSocket world, **enforces ownership** (plots, objects, terrain), rate-limits chat, and saves
  the world to `data/world.txt` every few seconds. Delete that file (with the server stopped) to reset the
  world.
- `js/`: a Three.js client: `terrain` (heightmap + splat shader), `environment` (sky, light, clouds,
  water), `trees` (procedural trees with LOD impostors), `grass` (GPU grass), `objects` (instanced
  placed objects, picking, colliders), `catalog` (every buildable item), `houses` (the generator),
  `build` (all tools), `player` (movement and physics), `avatar`, `net`, `ui`, `main`.
- Textures and props are CC0 assets from [Poly Haven](https://polyhaven.com), downloaded on demand. The
  avatars come from the three.js examples. The first visit needs an internet connection.
- If no server is reachable, the game runs solo and saves to the browser instead.

## Limits of this version

- Built for a few dozen players on one server. Thousands of players would need region servers, a real
  database and hosting (see the scaling notes in the chat where this was designed).
- Browser graphics: realistic, but not Unreal Engine 5. Interiors are lit by the sky as well as the lamps.
- Two avatar bodies, no voice chat, no in-world economy or scripting yet.
