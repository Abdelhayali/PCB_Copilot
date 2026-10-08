# PCB Copilot (CircuitPilot)

An AI-assisted schematic + PCB designer that runs entirely in the browser. Describe a circuit in plain language, and the copilot places parts, wires the schematic, runs ERC, then places and autoroutes a 2-layer PCB you can export as Gerbers.

## Features

- **Model picker** — Claude (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5) or any OpenAI-compatible endpoint (OpenAI, Gemini, Grok, OpenRouter, Ollama, LM Studio).
- **Three copilot modes**
  - **Agent** — edits the design with tools (add parts, connect nets, auto-layout, ERC, generate PCB).
  - **Ask** — read-only review and Q&A.
  - **Plan** — writes a BOM + netlist plan; press **Execute plan** to build it.
- **Checkpoints** — every Agent message snapshots the design; restore with one click. Full undo/redo.
- **Schematic editor** — 25 part types plus a generic IC with datasheet pin names, power symbols, click pin-to-pin wiring, drag, rotate (R), auto-layout.
- **PCB** — auto-placement from the schematic, A* 2-layer autorouter with vias, ratsnest, draggable footprints.
- **Exports** — Gerber + Excellon drill (.zip), BOM (.csv), netlist (.net), schematic and PCB SVG. Save/open projects as JSON.

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

## Limitations

- Footprints are simplified generators, not KiCad library footprints — verify pad sizes and pinouts (especially TO-92/TO-220) before fabrication.
- The router is a basic grid router (0.25 mm trace/clearance, no copper pours or rip-up-and-retry); dense boards may leave nets unrouted.
- Touch editing (drag/pinch) on phones is not implemented yet.

## Local models (llama.cpp, TabbyAPI, LM Studio, Ollama…)

In **⚙ Settings → OpenAI-compatible**, enter the server URL (e.g. `http://localhost:8080/v1` or click the **Local :8080** preset). The model list is fetched automatically from `/v1/models` and appears in the model picker. The model must support OpenAI-style tool calling for Agent mode.

Requests to `localhost` servers are routed through `server.py` (`/llm-proxy/<port>/...`), so local models work even when they only listen on 127.0.0.1 or don't send CORS headers — including from a phone on your LAN.
