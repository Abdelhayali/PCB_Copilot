// Web version settings. `relay` is the address of the CircuitPilot relay (relay/worker.js, a free Cloudflare Worker)
// used for part search, web search and Ollama Cloud when the app runs without server.py (GitHub Pages).
// Users can override it in ⚙ Settings → Relay.
window.CP_CONFIG = {
  relay: 'https://circuitpilot-relay.circuitpilot.workers.dev',
};
