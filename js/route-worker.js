'use strict';
// Runs placement + the autorouter off the UI thread. Receives the design, returns the new PCB.
importScripts('lib.js', 'model.js', 'pcb.js');
self.onmessage = e => {
  const { state, opt = {}, place } = e.data;
  try {
    Model.load(state);
    const onProgress = p => self.postMessage(Object.assign({ type: 'progress' }, p));
    let placement = null, routing = null, optimized = null;
    if (e.data.optimize) optimized = Pcb.optimize(Object.assign({}, e.data.optimize, { onProgress }));
    else {
      placement = place ? Pcb.autoPlace(place) : null;
      routing = opt.noRoute ? null : Pcb.route(Object.assign({}, opt, { onProgress }));
    }
    self.postMessage({
      type: 'done', placement, routing, optimized, pcb: Model.S.pcb, board: Model.S.board,
      positions: Model.S.components.filter(c => c.pcb).map(c => [c.ref, c.pcb]),
    });
  } catch (err) { self.postMessage({ type: 'error', message: err.message }); }
};
