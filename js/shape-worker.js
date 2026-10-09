'use strict';
// Runs 3D enclosure scripts (shape3d.js) off the main thread. The script comes from the user or the AI, so the
// worker has no network or storage access: those globals are removed before any script runs.
importScripts('enclosure.js', 'shape3d.js');
(() => {
  const banned = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'WebTransport', 'Request', 'Response'];
  for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const k of banned) { try { delete o[k]; } catch (e) { } }
  for (const k of banned) { try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch (e) { } }
})();
self.onmessage = e => {
  const { id, code, ctx, opts } = e.data;
  try {
    const r = Shape3D.run(code, ctx, opts || {}), transfer = [];
    for (const p of r.parts) { if (p.pos) transfer.push(p.pos.buffer, p.nor.buffer); if (p.stl) transfer.push(p.stl.buffer); }
    self.postMessage({ id, ok: true, r }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message || String(err), line: err && err.line, logs: err && err.logs || [] });
  }
};
