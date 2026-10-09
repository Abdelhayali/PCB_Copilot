# PCB Copilot (CircuitPilot)

An AI copilot for electronics design: describe a circuit in plain language and it picks **real parts from the JLCPCB/LCSC database**, draws the schematic, runs ERC, then places and autoroutes a 2-layer PCB you can export as Gerbers. Use Claude, any OpenAI-compatible model or a **local model**, from the browser, your phone, or **Claude Code via MCP**.

![CircuitPilot — ESP32-C3 board schematic](docs/media/schematic.png)

## See it in action

**AI copilot designing a circuit** (local Qwen 27B model, real tool calls, sped up)

![AI copilot building a circuit](docs/media/ai-copilot.gif)

The result, a fully routed board with a BOM and the design calculations, from a one-sentence prompt:

![AI copilot result](docs/media/ai-copilot.png)

| Generate & route the PCB | Search 600k+ real parts |
|---|---|
| ![PCB generation](docs/media/pcb.gif) | ![Parts database](docs/media/parts-database.gif) |

| Create symbols & footprints | Real footprints from the database |
|---|---|
| ![Part editor](docs/media/part-editor.gif) | ![Edit a database part](docs/media/part-editor.png) |

**PCB editor** — layers panel, PCB tools, hand routing with T/B layer switching (vias are added automatically)

![Hand routing with layer switching](docs/media/pcb-routing.gif)

| Layers panel (show / hide / colour / active layer) | Hand-routed tracks + vias |
|---|---|
| ![Layers](docs/media/pcb-layers.png) | ![PCB editor](docs/media/pcb-editor.png) |

**3D board view** — PCB toolbar **◈ 3D / ▦ 2D**: solder mask, copper, ENIG/HASL pads, silkscreen on both sides and 3D part models (Top / Bottom / Iso, mask colour, pad finish)

![3D PCB view](docs/media/pcb-3d.png)

**3D-printable enclosure fitted to the board** — STL + parametric OpenSCAD, editable by hand or by the AI

| Inside (X-ray, lid lifted) | Closed |
|---|---|
| ![Enclosure X-ray](docs/media/enclosure.png) | ![Enclosure](docs/media/enclosure-closed.png) |

| Design rules (JLCPCB defaults) | Autorouted 2-layer PCB |
|---|---|
| ![Design rules](docs/media/design-rules.png) | ![PCB](docs/media/pcb.png) |

| Projects | Project knowledge |
|---|---|
| ![Projects](docs/media/projects.png) | ![Knowledge](docs/media/knowledge.png) |


## Features

- **Model picker** — Claude (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5) or any OpenAI-compatible endpoint (OpenAI, Gemini, Grok, OpenRouter, Ollama, LM Studio, llama.cpp, local servers).
- **Three copilot modes** — **Agent** edits the design with tools, **Ask** is read-only review and Q&A, **Plan** writes a BOM + netlist plan you approve with **Execute plan**.
- **Every palette part is a real JLCPCB part** — the schematic keeps clean symbols while the footprint and pinout come from a specific LCSC part (Basic parts where possible, LEDs by colour); **⇄ JLCPCB parts** converts older designs and **Export → BOM for JLCPCB assembly** matches part numbers for every value.
- **Real component database** — JLCPCB/LCSC search with stock and price; exact pinouts and real footprints for every part, cached locally.
- **Part editor** — create or modify symbols and footprints (generators for SOIC/TSSOP/QFN/DIP/SOT…, draggable pads); saved to *My Library*.
- **Projects** — saved on the server with autosave; same projects on PC and phone.
- **Project knowledge** — point a project at a folder of docs, guides and datasheets (md/txt/pdf/docx) the AI follows.
- **Checkpoints** — every Agent message snapshots the design; restore with one click. Full undo/redo.
- **Schematic editor** — built-in parts plus database/custom parts, power symbols, click pin-to-pin wiring, drag, rotate (R), auto-layout.
- **PCB** — auto-placement from the schematic, rule-driven A* 2-layer autorouter (runs in a Web Worker) with vias and neck-down, ratsnest, draggable footprints.
- **Copper pours, arcs, bottom-side parts, curved boards** — GND (or any net) pours with clearance cut-outs; arc tracks; footprints on the bottom side (mirrored, bottom copper/silk/paste); rounded, round/elliptical or custom board outlines.
- **3D board view** — switch the PCB editor between 2D and a 3D render of the manufactured board (both sides, parts, mask colour, pad finish).
- **Enclosure** — a third tab builds a 3D-printable case around the PCB (follows the board outline, height from the tallest part, screw standoffs on PCB mounting holes, automatic openings for USB/jacks and holes above LEDs/buttons, snap-fit lid with vents); exports STL (base + lid) and parametric OpenSCAD.
- **Placement optimizer** — moves / rotates / swaps parts and re-routes until every net is connected (also available to the AI).
- **Gerber export with DRC check** — problems pop up with *Fix on board / Re-route / Optimize / Download anyway*.
- **PCB editor** — Layers panel (show/hide, colour, active layer, dim inactive), PCB Tools (Select, Track `W`, Via `V`, Measure `M`), interactive 45°/90°/any-angle routing with T/B layer switching and automatic vias, live clearance check, track/via properties, segment delete; the autorouter keeps hand-routed tracks.
- **Design rules & DRC** — JLCPCB 2-layer defaults, editable per project (trace/power widths, per-net widths, clearance, vias, edge clearance, layers); exact-geometry DRC with markers on the board.
- **Exports** — Gerber + Excellon drill (.zip), BOM (.csv), netlist (.net), schematic and PCB SVG, project JSON.
- **Internet access for the AI** — `web_search` and `web_fetch` let any model (Claude, Gemini, local Qwen …) look up datasheets, application notes, prices and anything else, reading web pages and PDF datasheets; private / local addresses are blocked. Toggle in ⚙ Settings (DuckDuckGo by default, optional Brave Search key).
- **Light / dark theme** — header button cycles 🖥 System → ☀ Light → 🌙 Dark (remembered per browser; the PCB canvas stays black for layer contrast).
- **Automation** — MCP server for Claude Code / Claude Desktop / Cursor, plus a REST + OpenAPI interface.

## Run

No build step and no dependencies. Start the bundled server (static files + a proxy for local model servers):

```bash
python server.py 5173
```

On Windows you can simply double-click **`start.bat`** (starts the server, shows the LAN address, optionally opens a public Cloudflare link). Open http://localhost:5173 (or `http://<your-PC-IP>:5173` from another device on your LAN), then open **⚙ Settings** and add an API key.

API keys are stored in your browser's localStorage and sent directly from the page to the provider you choose — fine for personal/local use, but don't host it publicly with keys baked in.

## Project layout

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | UI layout and theme |
| `js/lib.js` | Symbol and footprint library |
| `js/model.js` | Design state, nets, undo, ERC, schematic auto-layout |
| `js/schematic.js` | Schematic rendering and editing |
| `js/pcb.js` | Placement, autorouter, PCB view, Gerber/drill/zip export |
| `js/ai.js` | Providers, tool definitions, agent loop |
| `js/app.js` | Panels, chat, settings, exports |
| `js/engine.js` | Design tools shared by the copilot, MCP server and REST API |
| `js/projects.js`, `js/editor.js` | Project manager / autosave, part editor |
| `server.py`, `store.py`, `partsdb.py`, `knowledge.py` | Server, project + library storage, parts database, knowledge folders |
| `mcp/circuitpilot-mcp.mjs` | MCP server (Claude Code) and REST API |
| `docs/capture.mjs` | Regenerates the README screenshots and GIFs (headless Chrome + ffmpeg) |

## Limitations

- Palette parts (resistor, capacitor, LED, diodes, transistors, MOSFETs, regulator, op-amp, crystal, fuse, inductor, potentiometer, buzzer) are backed by real JLCPCB parts — their footprints and pinouts come from the part library and pins are matched by name, so e.g. the AMS1117's IN/OUT/tab and each LED's cathode land on the right pads. Pin headers / generic connectors and the push button keep standard generated footprints (a 4-pin tact switch's internal pairs are not documented in the library); if you pick a generated footprint from the Footprint menu, verify its pin order against your part's datasheet.
- The router is a basic grid router (0.25 mm trace/clearance, no copper pours or rip-up-and-retry); dense boards may leave nets unrouted.
- Touch editing (drag/pinch) on phones is not implemented yet.

## Local models (llama.cpp, TabbyAPI, LM Studio, Ollama…)

In **⚙ Settings → OpenAI-compatible**, enter the server URL (e.g. `http://localhost:8080/v1` or click the **Local :8080** preset). The model list is fetched automatically from `/v1/models` and appears in the model picker. The model must support OpenAI-style tool calling for Agent mode.

Requests to `localhost` servers are routed through `server.py` (`/llm-proxy/<port>/...`), so local models work even when they only listen on 127.0.0.1 or don't send CORS headers — including from a phone on your LAN.

## Public URL (Cloudflare tunnel)

```bash
python server.py 5173 --allow-ports 8080 --password YOUR_PASSWORD
cloudflared tunnel --url http://localhost:5173
```

Always set a password when exposing the app: the LLM proxy gives access to your local model. The proxy only forwards to ports listed in `--allow-ports` (default `8080`).

## Component database (JLCPCB / LCSC)

Type a part number in the Parts search box (e.g. `ESP32-C3`, `AMS1117`, `CH340C`, `USB-C`) to search the JLCPCB/LCSC catalogue (stock, price, Basic/Extended). Click a result to place it: the exact pinout and real PCB footprint are loaded from the part library (see *Data sources* below).

The AI copilot has the same database through the `search_parts` and `get_part` tools, so you can ask for e.g. *"ESP32-C3 board with USB-C, AMS1117 regulator and a status LED"* and it will pick real in-stock parts.

Everything fetched is cached in a local SQLite database (`parts.db`), so parts you've used keep working offline. Part definitions are also saved inside each design file.

## Projects

Projects are stored on the server (`projects.db`, SQLite) and saved automatically — the status next to the project name shows **✓ Saved**. Use **▤ Projects** to open, duplicate, rename, delete or import projects, and **＋ New** to start one. The same projects appear on every device that opens the app. **Export → Project file (.json)** downloads a portable copy.

## Part editor (custom symbols & footprints)

- **＋ New part** (Parts panel) opens the editor: pins (number, name, side L/R/T/B, bulk edit), live symbol preview, and a footprint editor with generators (0805, SOT-23, SOT-223, SOIC-n, TSSOP-n, QFN-n(-EP), DIP-n, pin headers…), draggable pads (0.05 mm snap) and per-pad size/shape/drill.
- Select any placed part → **✎ Edit symbol & footprint** to fix a database part, or **✎ Make editable part** to turn a built-in part into a custom one.
- Saved parts go to **My Library** (shared across projects); every placed instance updates when you edit a part.
- The AI can do the same with the `create_part` / `update_part` tools.

## Project knowledge folder

Click **📚 Knowledge** in the copilot and enter a folder on the PC running the server. Design notes, requirements, coding/naming rules and datasheets (`.md .txt .pdf .docx .csv .json`, source code…) are given to the AI: small documents go straight into its context, the rest it searches and reads with `knowledge_search` / `knowledge_read`. Try it with [`examples/knowledge`](examples/knowledge).

Only document-type files inside the chosen folder are read (no `..` escapes, hidden folders and `.git`/`node_modules` are skipped). Anyone who can log in to the app can point it at a folder on the server PC, so keep the password private.

## Control from Claude Code (MCP) and other tools

`mcp/circuitpilot-mcp.mjs` exposes all 29 design tools — projects, parts database, schematic editing, ERC, custom parts, knowledge, PCB generation, Gerber export — through the **Model Context Protocol**. It runs the same engine as the browser app and talks to the running `server.py`, so every change shows up live in the browser.

**Claude Code** — this repo ships a `.mcp.json`, so just open the folder in Claude Code (with `server.py` running) and approve the `circuitpilot` server. Or add it globally:

```bash
claude mcp add circuitpilot -e CP_URL=http://localhost:5173 -- node /path/to/PCB_Copilot/mcp/circuitpilot-mcp.mjs
```

Then ask e.g. *"Using circuitpilot, create a project 'ESP32 sensor board' with an ESP32-C3-MINI-1, AMS1117 and USB-C, then generate the PCB and export Gerbers to ./fab"*.

The password is read from `access-password.txt` (or set `CP_PASSWORD`). Other MCP clients (Claude Desktop, Cursor, VS Code…) use the same command.

**REST / OpenAPI** for anything else (scripts, n8n, OpenAI function calling…):

```bash
node mcp/circuitpilot-mcp.mjs --http 5174
curl -H "Authorization: Bearer <password>" http://127.0.0.1:5174/tools
curl -H "Authorization: Bearer <password>" -X POST http://127.0.0.1:5174/tools/search_parts -d '{"query":"CH340C"}'
```

`GET /openapi.json` returns an OpenAPI 3.1 spec of every tool. Add `"project": "<id or name>"` to any call to switch project. The REST server listens on 127.0.0.1 only (add `--public` to expose it).

## Design rules (JLCPCB defaults) and DRC

**PCB → ⚙ Rules** edits the project's design rules. The autorouter follows them and **DRC** checks the finished board against them.

| Rule | Default (JLCPCB 2-layer, recommended) | JLCPCB minimum |
|---|---|---|
| Trace width | 0.25 mm | 0.127 mm (5 mil) |
| Power / GND trace width | 0.5 mm | — |
| Clearance (copper–copper) | 0.2 mm | 0.127 mm (5 mil) |
| Via diameter / drill | 0.6 / 0.3 mm | 0.5 / 0.3 mm, annular ring 0.13 mm |
| Copper to board edge | 0.3 mm | 0.3 mm |
| Hole to hole | — | 0.5 mm |

- Presets: **JLCPCB recommended**, **JLCPCB minimum (5/5 mil)**, **JLCPCB power/robust**, **Home etching / CNC (1 layer)** — then tweak any value.
- **Per-net widths** (e.g. `+5V` 0.8 mm, `MOTOR` 1.2 mm); power and ground nets automatically use the power width.
- **Neck-down**: when a wide trace can't reach a fine-pitch pad, the router narrows it (power width → trace width → fab minimum) and reports which nets were necked down.
- Clearance is computed against the real pad shapes, so traces escape fine-pitch QFN/USB-C pads at JLCPCB clearances. Vias are allowed inside a net's own large pads (e.g. module ground pads).
- **DRC** uses exact geometry: shorts and clearance, trace width, via drill and annular ring, hole-to-hole spacing, copper-to-edge, unrouted nets, and rules set below the fab minimums. Click a violation to zoom to it.
- The AI and MCP/REST clients get `get_design_rules`, `set_design_rules` and `run_drc`; `generate_pcb` reports the DRC result.

Values follow JLCPCB's published capabilities; check [jlcpcb.com/capabilities](https://jlcpcb.com/capabilities/pcb-capabilities) for the latest before ordering.

## PCB editor

| Action | How |
|---|---|
| Layers | **Layers** panel: eye = show/hide, swatch = colour, click a copper layer = make it active; **All / None / Top / Bot** quick views; *Dim inactive copper* |
| Select / move | `S` or `Esc` — click a footprint, track segment or via; drag footprints and vias; double-click a track to select all of it; `R` rotates a footprint |
| Route a track | `W`, click a pad / via / track to start (net is taken from it), click to add corners, click a pad of the same net to finish |
| While routing | `T` / `B` / `L` / `V` switch layer (adds a via) · `Space` cycles 45° / 90° / any angle · `/` flips the bend · `+` / `-` width · `Backspace` removes the last corner · `Esc` or right-click finishes |
| Via | `V`, click to place (takes the net of what is under it) |
| Measure | `M`, click two points (mm and mil) |
| Delete | select, then `Del` (a segment splits its track) |
| Edit | select a track or via → change net, layer, width / diameter, drill, position in **Properties** |

Live feedback: the coordinate bar shows X/Y, layer, width, net, and warns when the track being drawn violates the clearance rule; vias placed while routing are checked too. **Route** (autorouter) keeps every existing track and only routes what is still unconnected; the ratsnest and the “routed” count follow the real copper.

### Connectors on the board edge

**Board size is kept**: once a board exists (or you type a size in Board W×H), Auto-place and Generate PCB fit the parts *inside* the existing outline — rectangle, rounded, round or custom — scaling the schematic arrangement to the board, keeping parts inside the edge clearance, rotating long parts and tightening spacing when crowded. The board is never enlarged on its own: if the parts cannot fit you get a message with how much of the board they need. Clear the Board W×H boxes to size the board to the parts instead. The ✨ Optimizer also keeps the board size.

**Generate PCB** puts connectors on the nearest board edge automatically: USB, DC jacks, RF and card connectors are rotated so the **opening faces outward, flush with the edge** (so a cable can plug in); pin headers and terminals sit just inside the edge. To choose the edge yourself, select the footprint on the PCB and click **⇤ Left / ⤒ Top / ⤓ Bottom / Right ⇥** in Properties — or ask the AI ("put the USB connector on the bottom edge"), which uses the `place_footprint` tool. The choice is remembered for later re-placements; press **Route** afterwards to reconnect.

### More PCB tools

| Feature | How |
|---|---|
| Copper pour | **⬛ Pour GND** (whole board, both layers) or the **Copper area** tool `E`: click corners, click the first corner to close; set net / layer / clearance in Properties. Other nets keep the clearance rule, same-net pads/tracks connect, the outline edge clearance is respected. Exported with clearance cut-outs. |
| Arc track | `A`: click start, click end, click to set the curve. |
| Drag tracks | Select tool: drag a segment (neighbours stay attached; a new corner is added at pads) or drag a corner. |
| Bottom side | Select a footprint → **▼ Bottom** in Properties (mirrored, SMD pads on BottomLayer, BottomSilk, bottom paste/mask). The AI: `place_footprint {side: "bottom"}`. |
| Board outline | **▭ Board**: rectangle, rounded rectangle, circle/ellipse, or **Draw outline** (custom polygon with rounded corners). Router, DRC, pours and the Edge_Cuts Gerber follow it. |
| Optimize | **✨ Optimize** moves, rotates and swaps parts (and can grow the board) and re-routes until everything connects, keeping the best result. Connectors on edges stay put. The AI: `optimize_pcb`, or `get_pcb_layout` + `place_footprint` + `route_pcb`. |
| Gerbers | **Gerbers ⤓** runs DRC first. If anything is wrong a window lists it (click to zoom) with **Fix on board · Re-route · Optimize placement · Download anyway**. Export includes copper, mask, paste, silkscreen (top + bottom), outline and drill. Via MCP, `export_gerbers` refuses on DRC errors unless `force: true`. |

## Enclosure (3D print)

The **Enclosure** tab builds a printable case around the current PCB and previews it in 3D (drag to orbit, right-drag to pan, wheel to zoom; *Explode*, *X-ray*, *Lid*, *PCB* toggles).

- **Fits the board**: the cavity follows the board outline (rectangle, rounded, round or custom) plus a clearance gap; the height comes from the tallest part (estimated per package — override any part height).
- **Board support**: click **＋ Add M3 mounting holes** (adds non-plated Ø3.2 mm holes to the PCB, kept clear of parts and copper, in the NPTH drill file) to get **screw standoffs**; without holes the board rests on corner supports. Standoffs rise automatically to clear parts on the bottom side.
- **Openings**: automatic for edge connectors (USB, DC jack…, at the right wall and height) and holes in the lid above LEDs and buttons; add your own rectangle / circle cutouts on any wall, the lid or the floor.
- **Lid**: snap-fit lip with an adjustable fit tolerance, optional vent slots.
- **Export**: **STL ⤓** (base + lid; the lid is already oriented for printing), **OpenSCAD ⤓** (parametric source of the same design), or **All (.zip)** with print notes.
- **AI**: "make the walls 3 mm, add a 6×4 mm cable slot on the right and more room above the board" → `set_enclosure`, `add_enclosure_cutout`, `add_mounting_holes`, `get_enclosure`; Claude Code can also `export_enclosure` straight to a folder.

The geometry engine (CSG with watertight-mesh repair) is self-contained JavaScript, so it runs in the browser and in the MCP server; only the 3D preview loads three.js from cdnjs.

## Data sources & licenses

CircuitPilot's design, code and UI are original work. It uses third-party **data and libraries**, credited here as their terms require:

- **Component catalogue** (search, stock, price, LCSC numbers): JLCPCB / LCSC.
- **Part symbols & footprints** for database parts: the **JLCEDA/EasyEDA official library** — https://easyeda.com · https://lceda.cn. Its terms require this source to be declared; parts are used here only to design boards to be made with these parts.
- **three.js** (MIT) for the 3D previews; the CSG algorithm in `js/enclosure.js` follows csg.js by Evan Wallace (MIT).
- Web search results come from DuckDuckGo (or Brave Search with your own key).
