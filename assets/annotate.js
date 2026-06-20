/*
 * annotate.js — the dashboard's intent client (User-intent track §6, U4).
 *
 * Mints user-intent commands ({id, kind, ...}) and POSTs them to /api/annotate.
 * Every action is OPTIMISTIC: it updates a localStorage view immediately (so the
 * page reflects the tap right away) and fires the network write in the background;
 * the authoritative set wins on the next dashboard publish (~20 min), at which
 * point reflected optimistic entries are cleared.
 *
 * This is the transport + envelope + optimistic-cache seam only. The DOM wiring
 * (star buttons, selection mode, the review queue) is U6 and lives in render.py's
 * generated page, which calls into the `Annotate` global exposed here.
 *
 * Config is injected by the page (render.py emits it at publish time):
 *   window.ANNOTATE_CONFIG = { endpoint: "/api/annotate", appSecret: "..." }
 * The app secret is intentionally public (low blast radius — see §6); the READ
 * secret never appears here.
 */
(function (global) {
  "use strict";

  var CFG = global.ANNOTATE_CONFIG || {};
  var ENDPOINT = CFG.endpoint || "/api/annotate";
  var APP_SECRET = CFG.appSecret || "";
  var LS_KEY = "sf-rentals-optimistic-v1";

  // --- intent id ---------------------------------------------------------- //
  function intentId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "i-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // --- optimistic local view (localStorage) ------------------------------- //
  function loadLocal() {
    try {
      return JSON.parse(global.localStorage.getItem(LS_KEY)) ||
        { stars: {}, pairs: {}, intents: {} };
    } catch (e) {
      return { stars: {}, pairs: {}, intents: {} };
    }
  }

  function saveLocal(v) {
    try {
      global.localStorage.setItem(LS_KEY, JSON.stringify(v));
    } catch (e) { /* private mode / quota — optimistic view is best-effort */ }
  }

  function pairKey(a, b) {
    return [a, b].sort().join("|");
  }

  // --- transport ---------------------------------------------------------- //
  function send(intent) {
    var local = loadLocal();
    local.intents[intent.id] = { kind: intent.kind, ts: intent.ts, pending: true };
    saveLocal(local);
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-secret": APP_SECRET },
      body: JSON.stringify(intent),
    }).then(function (r) {
      if (!r.ok) throw new Error("annotate failed: " + r.status);
      return intent.id;
    }).catch(function (err) {
      // keep the optimistic view; the next publish reconciles. Surface for retry UX.
      if (global.console) global.console.warn(err);
      throw err;
    });
  }

  // --- public actions ----------------------------------------------------- //
  function star(unitId, starred) {
    if (starred === undefined) starred = true;
    var local = loadLocal();
    if (starred) local.stars[unitId] = true; else delete local.stars[unitId];
    saveLocal(local);
    return send({ id: intentId(), kind: "star", unit: unitId, starred: starred, ts: nowIso() });
  }

  function assertSame(a, b, snapshot, opts) {
    opts = opts || {};
    var local = loadLocal();
    local.pairs[pairKey(a, b)] = "same";
    saveLocal(local);
    return send({
      id: intentId(), kind: "same", units: [a, b], snapshot: snapshot || {},
      ts: nowIso(), note: opts.note || null, from_queue: !!opts.fromQueue,
    });
  }

  function assertDistinct(a, b, snapshot, opts) {
    opts = opts || {};
    var local = loadLocal();
    local.pairs[pairKey(a, b)] = "distinct";
    saveLocal(local);
    return send({
      id: intentId(), kind: "distinct", units: [a, b], snapshot: snapshot || {},
      ts: nowIso(), note: opts.note || null, from_queue: !!opts.fromQueue,
    });
  }

  function dismiss(a, b, signature) {
    var local = loadLocal();
    local.pairs[pairKey(a, b)] = "dismissed";
    saveLocal(local);
    return send({
      id: intentId(), kind: "dismiss", pair: [a, b], signature: signature || {}, ts: nowIso(),
    });
  }

  function revoke(targetId) {
    return send({ id: intentId(), kind: "revoke", target: targetId, ts: nowIso() });
  }

  // --- optimistic read helpers (for render's hydration) ------------------- //
  function optimisticStars() {
    return Object.keys(loadLocal().stars);
  }

  function optimisticPairState(a, b) {
    return loadLocal().pairs[pairKey(a, b)] || null;
  }

  // Drop optimistic entries the authoritative publish now reflects (§6).
  function reconcile(authoritative) {
    authoritative = authoritative || {};
    var local = loadLocal();
    var authStars = authoritative.stars || [];
    authStars.forEach(function (u) { delete local.stars[u]; });
    (authoritative.pairs || []).forEach(function (k) { delete local.pairs[k]; });
    (authoritative.intents || []).forEach(function (id) { delete local.intents[id]; });
    saveLocal(local);
    return local;
  }

  global.Annotate = {
    star: star,
    assertSame: assertSame,
    assertDistinct: assertDistinct,
    dismiss: dismiss,
    revoke: revoke,
    optimisticStars: optimisticStars,
    optimisticPairState: optimisticPairState,
    reconcile: reconcile,
    _intentId: intentId,
  };
})(typeof window !== "undefined" ? window : this);
