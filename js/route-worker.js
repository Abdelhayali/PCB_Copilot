'use strict';
// Runs placement + the autorouter off the UI thread. Receives the design, returns the new PCB.
importScripts('lib.js', 'model.js', 'pcb.js');
self.onmessage = e => {
  const { state, opt = {}, place } = e.data;
  try {
    Model.load(state);
    const placement = place ? Pcb.autoPlace(place) : null;
    const routing = opt.noRoute ? null : Pcb.route(Object.assign({}, opt, { onProgress: p => self.postMessage(Object.assign({ type: 'progress' }, p)) }));
    self.postMessage({
      type: 'done', placement, routing, pcb: Model.S.pcb, board: Model.S.board,
      positions: Model.S.components.filter(c => c.pcb).map(c => [c.ref, c.pcb]),
    });
  } catch (err) { self.postMessage({ type: 'error', message: err.message }); }
};
