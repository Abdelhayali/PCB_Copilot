'use strict';
// AI Copilot: multi-provider model calls, tool definitions, agent loop (Agent / Ask / Plan modes).
const AI = (() => {
  const MODELS = [
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  ];
  const PRESETS = {
    'OpenAI': 'https://api.openai.com/v1',
    'Google Gemini': 'https://generativelanguage.googleapis.com/v1beta/openai',
    'xAI Grok': 'https://api.x.ai/v1',
    'OpenRouter': 'https://openrouter.ai/api/v1',
    'Local :8080': 'http://localhost:8080/v1',
    'Ollama (local)': 'http://localhost:11434/v1',
    'LM Studio (local)': 'http://localhost:1234/v1',
  };
  const defaults = { anthropicKey: '', oaiBase: 'https://api.openai.com/v1', oaiKey: '', oaiModels: '', model: 'claude-sonnet-5-5', maxTokens: 8192, includeContext: true };
  let settings = Object.assign({}, defaults);
  try { Object.assign(settings, JSON.parse(localStorage.getItem('cp.settings') || '{}')); } catch (e) { }
  const saveSettings = s => { settings = Object.assign(settings, s); try { localStorage.setItem('cp.settings', JSON.stringify(settings)); } catch (e) { } };
  // Local model servers (localhost / this PC) are reached through server.py's /llm-proxy/<port>/,
  // which works from phones on the LAN and sidesteps missing CORS headers.
  let proxyOk = null;
  async function hasProxy() {
    if (proxyOk !== null) return proxyOk;
    try { const r = await fetch('/llm-proxy/_ping'); proxyOk = r.ok && (await r.json()).ok === true; } catch (e) { proxyOk = false; }
    return proxyOk;
  }
  async function resolveBase(base) {
    base = String(base || '').trim().replace(/\/+$/, '');
    let u; try { u = new URL(base); } catch (e) { throw new Error('Invalid base URL: ' + base); }
    const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', location.hostname].includes(u.hostname);
    if (local && u.protocol === 'http:' && await hasProxy()) return `${location.origin}/llm-proxy/${u.port || 80}${u.pathname.replace(/\/+$/, '')}`;
    return base;
  }
  async function fetchModels(base, key) {
    const headers = {}; if (key) headers.authorization = 'Bearer ' + key;
    const res = await fetch(await resolveBase(base) + '/models', { headers, signal: AbortSignal.timeout(8000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status}: ${j.error?.message || res.statusText}`);
    const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
    if (!ids.length) throw new Error('Server returned no models');
    return ids;
  }
  const allModels = () => [...MODELS, ...settings.oaiModels.split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id, label: id, provider: 'openai' }))];

  // Tools live in engine.js (shared with the MCP server / REST API).
  const TOOLS = Engine.TOOLS, execTool = Engine.exec;

  // ---------- prompts ----------
  const BASE = `You are CircuitPilot, an expert electronics engineer embedded in a schematic + PCB design app. You design circuits by calling tools that edit the live schematic, then lay out the PCB.

DESIGN MODEL
- Components: ref (R1, C1, U1, Q1, D1, J1 ...), library type, value, schematic x/y (grid 10; a resistor is 60 wide; leave 80-160 between parts; signal flows left→right, supply at top, ground at bottom), rotation 0/90/180/270, and footprint.
- Connectivity is by named nets. Pins are referenced "REF.PIN" with the pin number or name ("R1.1", "Q1.B", "U1.VCC"). A name shared by several pins (e.g. "U1.GND") connects all of them.
- Nets named GND or supply names (VCC, VDD, +5V, +3V3, +12V, VBAT, VIN ...) render as power symbols. Give meaningful names to important signals (OUT, LED_K, SDA, TRIG ...); otherwise any name is fine.
- Pin numbering: resistor/capacitor/inductor 1,2; electrolytic 1=+ 2=-; diode/LED/zener/schottky 1=K(cathode) 2=A(anode); npn/pnp 1=B 2=E 3=C; nmos/pmos 1=G 2=S 3=D; regulator 1=IN 2=GND 3=OUT; opamp 2=IN- 3=IN+ 4=V- 6=OUT 7=V+; potentiometer 1, 2=W(wiper), 3; battery 1=+ 2=-.
- COMPONENT DATABASE: for real ICs, modules, regulators, connectors (ESP32, STM32, AMS1117, CH340, USB-C, etc.) use search_parts → pick an in-stock part (prefer Basic parts) → get_part → add_components with {"lcsc": "Cxxxx"}. This gives the exact pinout and real footprint; connect using the pin names returned by get_part. Simple passives (R, C, LED, diodes) can use the built-in types.
- CUSTOM PARTS: if a part is not in the database (or the user asks), create it with create_part (pins + footprint generator or explicit pads), then add_components {lcsc: <returned key>}. Fix wrong pinouts/footprints with update_part.
- PROJECT KNOWLEDGE: when the project has a knowledge folder, follow its requirements, conventions and guides. Use knowledge_search / knowledge_read for details not included below.
- PCB WORKFLOW: generate_pcb (connectors go on the board edge automatically) → if anything is unrouted, call optimize_pcb, or inspect get_pcb_layout and move parts with place_footprint (closer to their connections, rotate, side: "bottom" for small parts when the top is crowded), then route_pcb; repeat until all nets are routed → optionally add_copper_pour GND on both layers → run_drc and fix errors. Use set_board_shape for rounded / round / custom outlines.
- ENCLOSURE: the Enclosure tab builds a 3D-printable case fitted to the PCB (STL + OpenSCAD). Use add_mounting_holes for screw standoffs (then route_pcb), set_enclosure for wall/lid/heights/vents, add_enclosure_cutout for extra openings (switches, cables, displays), get_enclosure to check sizes. Connector openings and LED/button lid holes are automatic.
- If the database is unavailable, use type "ic" with "pins" = the exact datasheet pin names in pin-number order (e.g. NE555: ["GND","TRIG","OUT","RESET","CTRL","THR","DIS","VCC"]) and an appropriate footprint (DIP-8, SOIC-8, ...). Use "connector" for headers/terminals with descriptive pin names.

Use real, purchasable part values and show key calculations briefly (e.g. LED resistor = (Vs - Vf)/I). Keep replies concise and well formatted (markdown).`;

  const MODE = {
    agent: `MODE: AGENT — you can edit the design.
Workflow: 1) one or two sentences on the approach + key values; 2) add_components in ONE batch with sensible x/y; 3) connect ALL nets in ONE batch (every pin connected unless intentionally unused); 4) run_erc and fix real problems; 5) if the user wants a board/PCB, call generate_pcb and report routed/unrouted nets; 6) finish with a short summary (BOM highlights, things to double-check). If the design already has parts, modify it rather than starting over unless asked.`,
    ask: `MODE: ASK — read-only. You may inspect the design with get_design / run_erc / pcb_status / list_parts, but you cannot modify anything. Answer questions, review the design, explain circuit theory, suggest components and point out bugs.`,
    plan: `MODE: PLAN — do NOT modify the design. Produce a clear implementation plan in markdown:
## Goal  ## Key decisions & calculations  ## Bill of materials (table: Ref | Type | Value | Footprint | Purpose)  ## Connections (table: Net | Pins)  ## Steps
Use refs and pin names exactly as they will be used with the tools. End by telling the user to press **Execute plan** to build it.`
  };

  const designContext = Engine.designContext;

  // ---------- provider adapters (neutral history -> provider format) ----------
  function toAnthropic(hist) {
    const out = [];
    const push = (role, blocks) => { const last = out[out.length - 1]; if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: blocks }); };
    for (const m of hist) {
      if (m.role === 'user') push('user', [{ type: 'text', text: m.text }]);
      else if (m.role === 'assistant') {
        const b = []; if (m.text) b.push({ type: 'text', text: m.text });
        for (const t of m.toolCalls || []) b.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
        if (b.length) push('assistant', b);
      } else if (m.role === 'tool') push('user', m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: !!r.error })));
    }
    return out;
  }
  function toOpenAI(hist, system) {
    const out = [{ role: 'system', content: system }];
    for (const m of hist) {
      if (m.role === 'user') out.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') {
        const o = { role: 'assistant', content: m.text || '' };
        // Gemini "thinking" models require each tool call's thought_signature to be sent back unchanged.
        // Calls recorded before this fix (or from another provider) get Google's documented bypass value.
        const gem = /generativelanguage\.googleapis\.com/.test(settings.oaiBase);
        // In a parallel batch Gemini signs only the first call — replay exactly what it sent; batches recorded with no
        // signature at all (older history) get the bypass value on their first call.
        const signed = (m.toolCalls || []).some(t => t.extra);
        if (m.toolCalls && m.toolCalls.length) o.tool_calls = m.toolCalls.map((t, k) => Object.assign({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input || {}) } },
          t.extra ? { extra_content: t.extra } : (gem && !signed && k === 0) ? { extra_content: { google: { thought_signature: 'skip_thought_signature_validator' } } } : {}));
        out.push(o);
      } else if (m.role === 'tool') for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
    return out;
  }
  async function callModel(model, system, hist, tools, signal) {
    if (model.provider === 'anthropic') {
      if (!settings.anthropicKey) throw new Error('No Anthropic API key — open ⚙ Settings to add one.');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': settings.anthropicKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: model.id, max_tokens: +settings.maxTokens || 8192, system, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })), messages: toAnthropic(hist) })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${j.error?.message || res.statusText}`);
      return {
        text: j.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
        toolCalls: j.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })),
        usage: j.usage ? { in: j.usage.input_tokens, out: j.usage.output_tokens } : null
      };
    }
    const base = await resolveBase(settings.oaiBase);
    const headers = { 'content-type': 'application/json' };
    if (settings.oaiKey) headers.authorization = 'Bearer ' + settings.oaiKey;
    const res = await fetch(base + '/chat/completions', {
      method: 'POST', signal, headers,
      body: JSON.stringify({ model: model.id, messages: toOpenAI(hist, system), tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`API ${res.status}: ${j.error?.message || JSON.stringify(j).slice(0, 300) || res.statusText}`);
    const m = j.choices?.[0]?.message || {};
    return {
      text: (m.content || '').trim(),
      toolCalls: (m.tool_calls || []).map((t, i) => {
        let input = {}; try { input = JSON.parse(t.function.arguments || '{}'); } catch (e) { input = { __parse_error: t.function.arguments }; }
        return Object.assign({ id: t.id || 'call_' + Date.now() + '_' + i, name: t.function.name, input }, t.extra_content ? { extra: t.extra_content } : {});
      }),
      usage: j.usage ? { in: j.usage.prompt_tokens, out: j.usage.completion_tokens } : null
    };
  }

  // ---------- agent loop ----------
  let history = [], controller = null;
  try { history = JSON.parse(localStorage.getItem('cp.chat') || '[]'); } catch (e) { }
  const persist = () => { try { localStorage.setItem('cp.chat', JSON.stringify(history.slice(-200))); } catch (e) { } };

  async function run(text, mode, hooks) {
    const model = allModels().find(m => m.id === settings.model) || MODELS[2];
    const tools = TOOLS.filter(t => mode === 'agent' || t.ro);
    history.push({ role: 'user', text, mode, checkpoint: hooks.checkpoint });
    persist();
    controller = new AbortController();
    try {
      for (let step = 0; step < 40; step++) {
        let know = '';
        try {
          const k = await Engine.knowledgeDigest();
          if (k) know = `\n\nPROJECT KNOWLEDGE FOLDER: ${k.folder} (${k.files} files)\nFiles:\n${k.index}\n` + (k.included ? `\nIncluded documents:\n${k.included}` : '') + '\n(Use knowledge_search / knowledge_read for anything not included.)';
        } catch (e) { know = '\n\nPROJECT KNOWLEDGE FOLDER: unavailable (' + e.message + ')'; }
        const system = BASE + '\n\n' + MODE[mode] + know + (settings.includeContext ? '\n\n' + designContext() : '');
        const r = await callModel(model, system, history.map(({ role, text, toolCalls, results }) => ({ role, text, toolCalls, results })), tools, controller.signal);
        const msg = { role: 'assistant', text: r.text, toolCalls: r.toolCalls, model: model.label, mode };
        history.push(msg); persist(); hooks.onAssistant(msg, r.usage);
        if (!r.toolCalls.length) break;
        const results = [];
        for (const tc of r.toolCalls) {
          let content, error = false;
          try {
            if (tc.input && tc.input.__parse_error) throw new Error('Could not parse tool arguments as JSON');
            const out = await execTool(tc.name, tc.input, mode);
            content = typeof out === 'string' ? out : JSON.stringify(out);
          } catch (e) { content = 'Error: ' + e.message; error = true; }
          results.push({ id: tc.id, name: tc.name, content, error });
          hooks.onTool(tc, content, error);
          if (controller.signal.aborted) break;
        }
        for (const tc of r.toolCalls) if (!results.find(x => x.id === tc.id)) results.push({ id: tc.id, name: tc.name, content: 'Cancelled by user', error: true });
        history.push({ role: 'tool', results }); persist();
        if (controller.signal.aborted) break;
      }
    } catch (e) {
      if (e.name === 'AbortError') hooks.onError('Stopped.');
      else hooks.onError(e.message);
    } finally { controller = null; }
  }
  const stop = () => controller && controller.abort();
  const busy = () => !!controller;
  const reset = () => { history = []; persist(); };

  const partsApi = Engine.partsApi, loadPart = Engine.loadPart;
  return { MODELS, PRESETS, allModels, fetchModels, partsApi, loadPart, get settings() { return settings; }, saveSettings, run, stop, busy, reset, get history() { return history; }, execTool, TOOLS };
})();
