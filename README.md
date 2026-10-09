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

**EasyEDA-style PCB editor** — layers panel, PCB tools, hand routing with T/B layer switching (vias are added automatically)

![Hand routing with layer switching](docs/media/pcb-routing.gif)

| Layers panel (show / hide / colour / active layer) | Hand-routed tracks + vias |
|---|---|
| ![Layers](docs/media/pcb-layers.png) | ![PCB editor](docs/media/pcb-editor.png) |

| Design rules (JLCPCB defaults) | Autorouted 2-layer PCB |
|---|---|
| ![Design rules](docs/media/design-rules.png) | ![PCB](docs/media/pcb.png) |

| Projects | Project knowledge |
|---|---|
| ![Projects](docs/media/projects.png) | ![Knowledge](docs/media/knowledge.png) |


## Features

- **Model picker** — Claude (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5) or any OpenAI-compatible endpoint (OpenAI, Gemini, Grok, OpenRouter, Ollama, LM Studio, llama.cpp, local servers).
- **Three copilot modes** — **Agent** edits the design with tools, **Ask** is read-only review and Q&A, **Plan** writes a BOM + netlist plan you approve with **Execute plan**.
- **Real component database** — JLCPCB/LCSC search with stock and price; exact pinouts and footprints from the EasyEDA library, cached locally.
- **Part editor** — create or modify symbols and footprints (generators for SOIC/TSSOP/QFN/DIP/SOT…, draggable pads); saved to *My Library*.
- **Projects** — saved on the server with autosave; same projects on PC and phone.
- **Project knowledge** — point a project at a folder of docs, guides and datasheets (md/txt/pdf/docx) the AI follows.
- **Checkpoints** — every Agent message snapshots the design; restore with one click. Full undo/redo.
- **Schematic editor** — built-in parts plus database/custom parts, power symbols, click pin-to-pin wiring, drag, rotate (R), auto-layout.
- **PCB** — auto-placement from the schematic, rule-driven A* 2-layer autorouter (runs in a Web Worker) with vias and neck-down, ratsnest, draggable footprints.
- **EasyEDA-style PCB editor** — Layers panel (EasyEDA colours, show/hide, colour, active layer, dim inactive), PCB Tools (Select, Track `W`, Via `V`, Measure `M`), interactive 45°/90°/any-angle routing with T/B layer switching and automatic vias, live clearance check, track/via properties, segment delete; the autorouter keeps hand-routed tracks.
- **Design rules & DRC** — JLCPCB 2-layer defaults, editable per project (trace/power widths, per-net widths, clearance, vias, edge clearance, layers); exact-geometry DRC with markers on the board.
- **Exports** — Gerber + Excellon drill (.zip), BOM (.csv), netlist (.net), schematic and PCB SVG, project JSON.
- **Automation** — MCP server for Claude Code / Claude Desktop / Cursor, plus a REST + OpenAPI interface.

## Run

No build step and no dependencies. Start the bundled server (static files + a proxy for local model servers):

```bash
python server.py 5173
```

Open http://localhost:5173 (or `http://<your-PC-IP>:5173` from another device on your LAN), then open **⚙ Settings** and add an API key.

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

- Footprints are simplified generators, not KiCad library footprints — verify pad sizes and pinouts (especially TO-92/TO-220) before fabrication.
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

## Component database (JLCPCB / LCSC + EasyEDA)

Type a part number in the Parts search box (e.g. `ESP32-C3`, `AMS1117`, `CH340C`, `USB-C`) to search the JLCPCB/LCSC catalogue (stock, price, Basic/Extended). Click a result to place it: the exact pinout and real PCB footprint are loaded from the JLCEDA/EasyEDA official library (https://easyeda.com, https://lceda.cn).

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

## PCB editor (EasyEDA-style)

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
