// Captures README screenshots and GIFs by driving headless Chrome over the DevTools protocol.
// Needs: server.py running, Chrome, ffmpeg. Usage: node docs/capture.mjs [--no-ai]
// Demo projects it creates are deleted at the end.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'media');
const BASE = process.env.CP_URL || 'http://localhost:5173';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const W = 1440, H = 900, PORT = 9333;
const NO_AI = process.argv.includes('--no-ai');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

let password = process.env.CP_PASSWORD || '';
try { password = password || fs.readFileSync(path.join(ROOT, 'access-password.txt'), 'utf8').trim(); } catch { }
const token = password ? crypto.createHash('sha256').update('circuitpilot:' + password).digest('hex') : '';

// ---------- Chrome + CDP ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-capture-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; } catch { } await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = {}, listeners = {};
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending[m.id]) { const p = pending[m.id]; delete pending[m.id]; m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method && listeners[m.method]) listeners[m.method](m.params);
};
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending[id] = { res, rej }; ws.send(JSON.stringify({ id, method, params })); });
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
if (token) await cdp('Network.setCookie', { name: 'cp_auth', value: token, url: BASE });
async function load() {
  const loaded = new Promise(r => listeners['Page.loadEventFired'] = r);
  await cdp('Page.navigate', { url: BASE }); await loaded; await sleep(1500);
}

// ---------- capture helpers ----------
async function shot(name) {
  await sleep(1600); // let autosave settle so the header shows "Saved"
  await js(`const c = document.getElementById('fakecur'); if (c) c.style.display = 'none'; document.querySelector('#toast').classList.remove('on'); return 1`);
  await sleep(300);
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  await js(`const c = document.getElementById('fakecur'); if (c) c.style.display = ''; return 1`);
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); console.log('saved', name + '.png');
}
async function record(name, fn, { maxFrame = 0.9, hold = 2.0, width = 1100 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-frames-')), frames = [];
  listeners['Page.screencastFrame'] = p => {
    const f = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    fs.writeFileSync(f, Buffer.from(p.data, 'base64')); frames.push({ f, t: p.metadata.timestamp });
    cdp('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => { });
  };
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await sleep(300); await fn(); await sleep(600);
  await cdp('Page.stopScreencast'); delete listeners['Page.screencastFrame'];
  let list = '';
  frames.forEach((fr, i) => {
    const d = i < frames.length - 1 ? Math.min(maxFrame, Math.max(0.04, frames[i + 1].t - fr.t)) : hold;
    list += `file '${fr.f.replace(/\\/g, '/')}'\nduration ${d.toFixed(3)}\n`;
  });
  list += `file '${frames[frames.length - 1].f.replace(/\\/g, '/')}'\n`;
  fs.writeFileSync(path.join(dir, 'list.txt'), list);
  const gif = path.join(OUT, name + '.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
    '-vf', `fps=12,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('saved', name + '.gif', (fs.statSync(gif).size / 1e6).toFixed(1) + ' MB', frames.length + ' frames');
}
// Visible cursor for the GIFs + real mouse events.
let cur = { x: W / 2, y: H / 2 };
async function cursor() {
  await js(`if (!document.getElementById('fakecur')) { const c = document.createElement('div'); c.id = 'fakecur';
    c.style.cssText = 'position:fixed;z-index:99999;width:18px;height:18px;margin:-3px 0 0 -3px;pointer-events:none;transition:none;left:${cur.x}px;top:${cur.y}px;background:url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 18 18%22><path d=%22M2 1 L2 15 L6 11 L9 17 L11 16 L8 10 L14 10 Z%22 fill=%22white%22 stroke=%22black%22 stroke-width=%221%22/></svg>") no-repeat';
    document.body.appendChild(c); }`);
}
async function moveTo(x, y, steps = 14, buttons = 0) {
  const sx = cur.x, sy = cur.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    cur = { x: sx + (x - sx) * e, y: sy + (y - sy) * e };
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cur.x, y: cur.y, buttons, button: buttons ? 'left' : 'none' });
    await js(`const c = document.getElementById('fakecur'); if (c) { c.style.left = '${cur.x}px'; c.style.top = '${cur.y}px'; }`);
    await sleep(16);
  }
}
async function click(x, y) {
  await moveTo(x, y);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
}
async function drag(x1, y1, x2, y2) {
  await moveTo(x1, y1);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  await moveTo(x2, y2, 24, 1);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
}
const center = sel => js(`const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`);
const clickSel = async sel => { const [x, y] = await center(sel); await click(x, y); };
async function type(sel, text) {
  await clickSel(sel);
  for (const ch of text) { await cdp('Input.insertText', { text: ch }); await sleep(45); }
}

// ---------- demo content ----------
const created = [];
async function newProject(name) {
  const id = await js(`await Projects.create(${JSON.stringify(name)}); return Model.S.id;`);
  created.push(id); return id;
}
async function buildEsp32Board() {
  await js(`
    const E = (n, i) => Engine.exec(n, i);
    await E('add_components', { components: [
      { lcsc: 'C165948', ref: 'J1', x: -460, y: 20 },
      { type: 'resistor', ref: 'R1', value: '5.1k', x: -330, y: 150, rot: 90 },
      { type: 'resistor', ref: 'R2', value: '5.1k', x: -280, y: 150, rot: 90 },
      { lcsc: 'C6186', ref: 'U1', x: -150, y: -230 },
      { type: 'capacitor', ref: 'C1', value: '10u', x: -280, y: -230, rot: 90 },
      { type: 'capacitor', ref: 'C2', value: '22u', x: -30, y: -230, rot: 90 },
      { lcsc: 'C2838502', ref: 'U2', x: 160, y: 0 },
      { type: 'capacitor', ref: 'C3', value: '100n', x: 40, y: -230, rot: 90 },
      { type: 'resistor', ref: 'R3', value: '10k', x: -70, y: -60, rot: 90 },
      { type: 'switch', ref: 'SW1', value: 'RESET', x: -70, y: 60, rot: 90 },
      { type: 'resistor', ref: 'R4', value: '1k', x: 400, y: -150 },
      { type: 'led', ref: 'D1', value: 'Green', x: 490, y: -110, rot: 90 },
      { type: 'connector', ref: 'J2', value: 'I2C', pins: ['+3V3', 'SDA', 'SCL', 'GND'], x: 470, y: 110, rot: 180 },
    ]});
    await E('connect', { connections: [
      { net: '+5V', pins: ['J1.VBUS', 'U1.VIN', 'C1.1'] },
      { net: 'GND', pins: ['J1.GND', 'J1.EH', 'R1.2', 'R2.2', 'U1.GND', 'C1.2', 'C2.2', 'C3.2', 'U2.GND', 'SW1.2', 'D1.K', 'J2.GND'] },
      { net: 'CC1', pins: ['J1.CC1', 'R1.1'] }, { net: 'CC2', pins: ['J1.CC2', 'R2.1'] },
      { net: 'USB_DP', pins: ['J1.DP1', 'J1.DP2', 'U2.IO19'] }, { net: 'USB_DN', pins: ['J1.DN1', 'J1.DN2', 'U2.IO18'] },
      { net: '+3V3', pins: ['U1.VOUT', 'C2.1', 'C3.1', 'U2.3V3', 'R3.1', 'J2.+3V3'] },
      { net: 'EN', pins: ['U2.EN', 'R3.2', 'SW1.1'] },
      { net: 'LED_STATUS', pins: ['U2.IO8', 'R4.1'] }, { net: 'LED_A', pins: ['R4.2', 'D1.A'] },
      { net: 'I2C_SDA', pins: ['U2.IO4', 'J2.SDA'] }, { net: 'I2C_SCL', pins: ['U2.IO5', 'J2.SCL'] },
    ]});
    await Projects.saveNow(); App.showView('sch'); Sch.select(null); Sch.fit();`);
  await sleep(800);
}

try {
  await load(); await cursor();
  created.push(await js(`return Model.S.id`)); // fresh profile autosaves an empty project
  // Use the local model if one is configured on :8080, keep the browser profile clean otherwise.
  await js(`AI.saveSettings({ oaiBase: 'http://localhost:8080/v1', oaiModels: 'Qwen3.8-27B-Uncensored', model: 'Qwen3.8-27B-Uncensored' }); AI.reset(); return true;`);
  await load(); await cursor();

  // 1) Hero: ESP32-C3 board schematic + PCB
  await newProject('ESP32-C3 sensor board');
  await buildEsp32Board();
  await js(`App.renderAll(); return 1`);
  await shot('schematic');

  // 2) GIF: generate the PCB
  await record('pcb', async () => {
    await clickSel('.tab[data-view="pcb"]'); await sleep(600);
    await clickSel('#btnGen'); await sleep(1800);
    await js(`Pcb.fit(); return 1`); await sleep(1200);
  }, { hold: 2.5 });
  await js(`Pcb.fit(); return 1`); await sleep(400);
  await shot('pcb');
  // 3D view of the board
  await js(`document.querySelector('#btn3d').click(); return 1`); await sleep(5000);
  await shot('pcb-3d');
  await js(`document.querySelector('#btn3d').click(); return 1`); await sleep(500);

  // EasyEDA-style editor: layers panel + hand routing with layer switching
  await js(`if (document.querySelector('#layerPanel').classList.contains('collapsed')) document.querySelector('#layerPanel .ltitle').click(); return 1`);
  await shot('pcb-layers');
  await js(`document.querySelector('#layerPanel .ltitle').click(); Model.mutate(() => { Model.S.pcb.traces = Model.S.pcb.traces.filter(t => t.net !== 'LED_A' && t.net !== 'LED_STATUS'); }); Pcb.ui.drc = null; Pcb.render(); return 1`);
  const padXY = key => js(`const svg = document.querySelector('#pcbSvg'), m = svg.getScreenCTM(), idx = Model.pinIndex();
    const p = Model.S.components.flatMap(c => Pcb.padsOf(c, idx)).find(p => p.key === Model.resolvePins(${JSON.stringify(key)})[0]); return [m.a * p.x + m.e, m.d * p.y + m.f];`);
  await js(`const idx = Model.pinIndex(), P = Model.S.components.flatMap(c => Pcb.padsOf(c, idx)), k = ['U2.IO8', 'R4.1', 'R4.2', 'D1.A'].map(n => Model.resolvePins(n)[0]);
    const q = P.filter(p => k.includes(p.key)); const xs = q.map(p => p.x), ys = q.map(p => p.y);
    Pcb.vp.fit([Math.min(...xs) - 3, Math.min(...ys) - 4, Math.max(...xs) + 3, Math.max(...ys) + 4], 1); return 1`); await sleep(300);
  const key = async k => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k }); await sleep(450); };
  await record('pcb-routing', async () => {
    const [ax, ay] = await padXY('U2.IO8'), [bx, by] = await padXY('R4.1'), [cx, cy] = await padXY('R4.2'), [dx, dy] = await padXY('D1.A');
    await key('w');
    // LED_STATUS: U2.IO8 → out → bottom layer (via) → back to top (via) → R4.1
    const mx = (ax + bx) / 2;
    await click(ax, ay); await moveTo(ax + 50, ay, 16); await click(ax + 50, ay);
    await key('b'); await moveTo(mx, by + 40, 18); await click(mx, by + 40);
    await key('t'); await moveTo(bx, by, 20); await sleep(250); await click(bx, by); await sleep(600);
    // LED_A: R4.2 → D1.A on the top layer
    await click(cx, cy); await moveTo(dx, dy, 20); await sleep(300); await click(dx, dy); await sleep(800);
    await key('Escape');
  }, { hold: 2.5, maxFrame: 0.5 });
  await shot('pcb-editor');
  await js(`Pcb.fit(); return 1`);
  await js(`document.querySelector('#btnRules').click(); return 1`); await sleep(500);
  await shot('design-rules');
  await js(`document.querySelector('#rulesClose').click(); return 1`);

  // 3) GIF: parts database search → place
  await js(`App.showView('sch'); Sch.fit(); return 1`); await sleep(400);
  await record('parts-database', async () => {
    await type('#partSearch', 'CH340C'); await sleep(3500);
    await clickSel('.dbpart[data-lcsc]'); await sleep(2500);
  }, { hold: 2.5 });
  await shot('parts-database');
  await js(`const c = Model.S.components.find(c => c.lcsc === 'C84681' || /CH340/.test(c.value)); if (c) Model.mutate(() => Model.removeComponent(c.ref)); document.querySelector('#partSearch').value = ''; App.refreshParts(); Sch.select(null); return 1`);

  // 4) Part editor screenshot (database part) + GIF (new part)
  await js(`Sch.select('U2'); document.querySelector('#pEdit').click(); return 1`); await sleep(1000);
  await shot('part-editor');
  await js(`PartEditor.close(); return 1`);
  await record('part-editor', async () => {
    await clickSel('#btnNewPart'); await sleep(700);
    await js(`document.querySelector('#edName').select(); return 1`);
    await type('#edName', 'BME280-like sensor'); await sleep(300);
    await js(`document.querySelector('#edGen').value = 'QFN-<n>-EP'; document.querySelector('#edGenN').value = '16'; window.confirm = () => true; return 1`);
    await clickSel('#edGenBtn'); await sleep(900);
    await clickSel('#edFromPads'); await sleep(900);
    const [x, y] = await center('#edFp [data-i="16"]');
    await drag(x, y, x + 60, y + 30); await sleep(700);
    await drag(x + 60, y + 30, x, y); await sleep(900);
  }, { hold: 2 });
  await js(`PartEditor.close(); return 1`);

  // 4b) Enclosure fitted to the board (mounting holes → screw standoffs), X-ray + exploded
  await js(`Model.mutate(() => Pcb.addMountingHoles({})); App.showView('enc'); return 1`); await sleep(4000);
  await js(`document.querySelector('#encXray').click(); document.querySelector('#encExplode').click(); return 1`); await sleep(800);
  await shot('enclosure');
  await js(`document.querySelector('#encXray').click(); document.querySelector('#encExplode').click(); return 1`); await sleep(600);
  await shot('enclosure-closed');
  await js(`App.showView('sch'); return 1`);

  // 5) Projects + knowledge dialogs
  await js(`Projects.show(); return 1`); await sleep(1200); await shot('projects');
  await js(`Projects.close(); return 1`);
  await js(`await Engine.exec('set_knowledge_folder', { path: ${JSON.stringify(path.join(ROOT, 'examples', 'knowledge'))} }); document.querySelector('#btnKnow').click(); return 1`);
  await sleep(1500); await shot('knowledge');
  await js(`document.querySelector('#knowClose').click(); return 1`);

  // 6) GIF: real AI copilot run with the local model
  if (!NO_AI) {
    await newProject('AI demo: 3.3V supply');
    await js(`App.showView('sch'); return 1`);
    await record('ai-copilot', async () => {
      await type('#prompt', 'Design a USB 5V to 3.3V supply with the AMS1117-3.3 from the parts database, input and output caps, and a green power LED. Then make the PCB.');
      await sleep(400); await clickSel('#btnSend');
      for (let i = 0; i < 600; i++) { await sleep(1000); if (!(await js(`return AI.busy()`))) break; }
      await sleep(1500);
    }, { maxFrame: 0.6, hold: 3, width: 1100 });
    await shot('ai-copilot');
  }
} catch (e) {
  console.error('capture failed:', e);
  process.exitCode = 1;
} finally {
  chrome.kill(); await sleep(800); // stop autosave first, then delete the demo projects
  for (const id of new Set(created.filter(Boolean)))
    await fetch(`${BASE}/api/projects/${id}`, { method: 'DELETE', headers: password ? { authorization: 'Bearer ' + password } : {} }).catch(() => { });
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('done; removed demo projects:', created.length);
}
