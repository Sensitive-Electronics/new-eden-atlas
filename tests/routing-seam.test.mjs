// The one seam between the button and the operation that nothing covered.
//
// `tests/routing-operations.test.mjs` proves the rehydrator: build the
// planner's inputs once, hand them to `calculate` and to
// `freezeRouting` -> `thawRouting` -> `calculate`, and the routes match leg for
// leg. That is everything from `freezeRouting` inwards.
//
// It calls `planner.calculate` directly. **The button is `app.calculateRoute`**,
// and what it hands the planner is assembled in `app.js` from the UI and from
// four stores. So the question step 4's "Done when" actually asks - *does a
// route from an operation and a route from the button agree* - has an
// unexamined half: whether the object `app.js` assembles is the object the
// freeze receives.
//
// It was unexaminable until the assembly was one function. Inline, the only
// ways to build a frozen record were a second reading of the UI or a second
// reading of `state`, and a second reading is a second answer - so any
// agreement a test found would have been arranged by the test rather than
// guaranteed by the code.
//
// Which is why this freezes `state.routeInputsUsed` - **the object the button
// passed to the planner** - and not a second call to `plannerInputs()`. Calling
// it again would be the same mistake one layer up: `calculateRoute` rewrites
// the route boxes to canonical names between the two calls and
// `suspendedAvoidCount` re-reads the clock, so a second assembly can differ
// from the first for reasons that have nothing to do with the rehydrator.
//
// **The clock is pinned to `state.routeAt`.** `app.js` pins it on every click
// for exactly this reason, in as many words: overrides expire and heat is
// stamped, so the instant is the input that decides whether they still apply.
// A test that let the two sides read the wall clock twice would be flaky in
// proportion to how long it took to run.

import { suite, readArchive } from "./helpers.mjs";
import { RoutePlanner, emptyAvoid } from "../web/route-planner.js";
import { buildSnapshot, project, reference, characterRef } from "../web/snapshot.js";
import { evaluate } from "../web/operations.js";
import { createStore, edgeKey } from "../web/overrides.js";
import { openWindow } from "../web/ask-window.js";

const CHARACTER = 95465499;

export default function run(app) {
  const t = suite("routing seam");
  const { state, ui } = app;
  const atlas = readArchive();
  state.atlas = atlas;
  const planner = new RoutePlanner(atlas);
  state.routePlanner = planner;

  const drive = ({ avoidSystems = "", suspend = false } = {}) => {
    ui.routeFrom.value = "Jita";
    ui.routeTo.value = "Amarr";
    ui.routeMode.value = "shortest";
    ui.avoidSystems.value = avoidSystems;
    ui.avoidRegions.value = "";
    ui.routeMinSec.value = "";
    ui.routeMaxSec.value = "";
    app.setAvoidance(!suspend);
    app.calculateRoute();
    return state.route;
  };

  // The operation, over a snapshot frozen from **the same assembly the button
  // just used**, at the same instant.
  const viaOperation = (inputs, at) => {
    const snapshot = buildSnapshot({
      now: at,
      archive: atlas,
      brief: {
        mode: "escape",
        items: [{ system: planner.resolveSystem("Jita") }, { system: planner.resolveSystem("Amarr") }],
      },
      characters: [{ id: CHARACTER, name: "a name its owner chose" }],
      routing: { [CHARACTER]: inputs },
    });
    const shown = project(snapshot);
    return evaluate(snapshot, {
      op: "jumps_between",
      from: reference(shown, "finding:0"),
      to: reference(shown, "finding:1"),
      character: reference(shown, characterRef(CHARACTER)),
    }, { planner, now: at });
  };

  // --- with a system avoided -------------------------------------------------
  //
  // Non-empty on purpose. An agreement over an empty avoid list is an agreement
  // about a route neither side had to work for; the whole failure this guards
  // is a conversion that drops an avoided system, which produces a shorter
  // route through the gate the pilot said to keep away from, with every leg
  // correct.
  {
    const button = drive({ avoidSystems: "Ahbazon" });
    t.check(Boolean(button), "the button produced a route");
    const inputs = state.routeInputsUsed;
    const measured = viaOperation(inputs, state.routeAt);

    t.check(!measured.fault, `the operation produced one too (${measured.fault ?? "no fault"})`);
    t.equal(measured.result, button.jumps, "the two agree on the number of jumps");

    // **Not only the count.** Two routes of equal length through different
    // systems agree on a number and strand somebody differently.
    //
    // Compared **by absolute leg index**, because `rendered` is bounded: past
    // `RENDER_LIMIT` it is a head and a tail, so that the destination always
    // shows. The first version of this test joined the rendered names and
    // compared them to the whole path, and failed on a 24-system route against
    // a 20-row rendering - a real difference between a route and a *rendering*
    // of one, which is exactly the distinction the bound exists to make.
    t.check(measured.rendered.length > 0, "the operation rendered the legs it measured");
    t.equal(measured.population, button.systems.length,
      "and says the population is the whole path, however much of it it shows");
    for (const row of measured.rendered) {
      const expected = button.systems[row.leg];
      t.check(Boolean(expected) && expected.name === row.systemName,
        `leg ${row.leg} is ${expected ? expected.name : "off the end"} on both sides`);
    }
    // **The legs the rendering does not show are checked another way.** Past
    // `RENDER_LIMIT` the rendering is a head and a tail, so a divergence in the
    // unshown middle is invisible to the loop above - and an equal-length
    // divergence is exactly what lives there. `avoidedAnyway` is the
    // operation's own report of entering an avoided system and is not bounded
    // by the render limit, so it covers the whole path.
    //
    // The count it replaced - `matched >= 2` - incremented unconditionally, so
    // it only ever restated that the rendering had two rows.
    t.equal(measured.caveats.avoidedAnyway.length, 0,
      "and the operation reports entering no avoided system, over the whole path");

    // And not only the path. `legKinds` is built from how each leg was
    // *travelled*, and a dropped bridge link with a stargate between the same
    // pair gives an identical sequence and an identical count - while one
    // reads "1 jump" and the other "1 jump through a structure that may be out
    // of fuel".
    t.equal(measured.caveats.bridgeJumps, button.bridgeJumps ?? 0,
      "and on how many legs were bridges");
    t.equal(measured.caveats.wormholeJumps, button.wormholeJumps ?? 0,
      "and on how many were wormholes");

    // The avoided system is genuinely absent from both, so neither side can be
    // passing by ignoring the list equally.
    t.check(!button.systems.some(system => system.name === "Ahbazon"),
      "the button's route really avoids it");
    t.check(!measured.rendered.some(row => row.systemName === "Ahbazon"),
      "and so does the operation's");
  }

  // --- with the list suspended ----------------------------------------------
  //
  // Switched off rather than cleared. Both sides must route as though it were
  // empty **and** both must be able to say a standing order is being held back,
  // or the advisor reports a route through an avoided system as an ordinary one
  // while the route box beside it protests.
  {
    const button = drive({ avoidSystems: "Ahbazon", suspend: true });
    const inputs = state.routeInputsUsed;
    const measured = viaOperation(inputs, state.routeAt);

    t.check(!measured.fault, "a suspended list still routes");
    t.equal(measured.result, button.jumps, "and the two still agree on the jumps");
    t.check(button.avoidanceSuspended > 0, "the button records what is held back");
    t.equal(measured.caveats.avoidSuspended, button.avoidanceSuspended,
      "and the operation reports the same count rather than silence");

    // The proof that this case is different from the one above: with the list
    // off, the route is allowed through.
    t.check(button.systems.some(system => system.name === "Ahbazon"),
      "a suspended list does not keep the route out");
  }

  // Every test file in this suite shares one `app` module, so a file that
  // leaves a route, an avoid list or a suspended toggle behind is a file that
  // decides what a later one sees. This one drives the real button twice.
  // --- the turn reads the present, through the caller that got it wrong -----
  //
  // `jumps_between` reads expiring links against `tools.now`. `operations.js`
  // and `routing-inputs.js` both say at length that this has to be the present:
  // a snapshot freezes what was observed and cannot freeze the future, and a
  // wormhole's expiry is a claim about the future.
  //
  // `advisorTurn` passed `record.snapshot.takenAt` for a day, with a comment
  // arguing the opposite, so an hour-old brief would have routed a pilot
  // through a hole that died forty minutes earlier and reported `lapsedLinks:
  // 0`.
  //
  // **This drives the turn, not a helper.** The first version of this check
  // asserted the shape of `advisorTools()`; a hostile audit reintroduced the
  // defect at the call site and the suite stayed green, because the thing
  // asserted was the thing that had never been wrong.
  {
    const NOW = Date.now();
    const takenAt = NOW - 2 * 60 * 60 * 1000;
    const died = NOW - 60 * 60 * 1000;
    const a = planner.resolveSystem("Jita").system_id;
    const b = planner.resolveSystem("Amarr").system_id;
    const key = edgeKey(a, b);

    const inputs = {
      avoid: emptyAvoid(),
      limits: { min: null, max: null },
      // One wormhole, alive when the brief was taken and gone an hour ago.
      bridges: {
        links: new Map([[key, [a, b]]]),
        kinds: new Map([[key, "wormhole"]]),
        expiry: new Map([[key, died]]),
        named: new Map(), names: [], count: 1, source: "scout", syncedAt: takenAt,
      },
      overrides: createStore(),
      heat: { kills: new Map(), weight: 0, at: null, applied: false },
      mode: "shortest",
    };
    const snapshot = buildSnapshot({
      now: takenAt,
      archive: atlas,
      brief: {
        mode: "escape",
        items: [{ system: planner.resolveSystem("Jita") }, { system: planner.resolveSystem("Amarr") }],
      },
      characters: [{ id: CHARACTER, name: "a name its owner chose" }],
      routing: { [CHARACTER]: inputs },
    });
    const shown = project(snapshot);

    const store = app.state.askWindows;
    while (store.open.length) app.closeAsk(store.open[0].id);
    const window_ = openWindow(store, snapshot, { now: takenAt });
    t.check(!window_.fault, `a window opens on the aged brief (${window_.fault ?? "no fault"})`);

    // A core that answers with one `jumps_between`, echoing the request id.
    //
    // `window` stays undefined in the shim on purpose - `app.js` guards `init`
    // on it - so a fake one is built here the way `tests/vault.test.mjs` builds
    // its own, and put back in a `finally` so a throw cannot leave the rest of
    // the run thinking it is in a browser.
    const savedWindow = globalThis.window;
    globalThis.window = {
      ...(savedWindow ?? {}),
      __TAURI__: { core: {
        invoke: (name, args) => Promise.resolve({
          v: 1,
          id: args.envelope.id,
          ok: true,
          payload: {
            snapshotId: shown.snapshotId,
            operations: [{
              op: "jumps_between",
              from: reference(shown, "finding:0"),
              to: reference(shown, "finding:1"),
              character: reference(shown, characterRef(CHARACTER)),
            }],
          },
        }),
      } },
    };

    const done = (outcome) => {
      globalThis.window = savedWindow;
      t.check(!outcome.fault, `the turn produced a brief (${outcome.fault ?? "no fault"})`);
      const measured = outcome.figures && outcome.figures[0];
      t.check(Boolean(measured), "carrying the figure it was asked for");
      // The discriminator. Read against the present, the hole is gone and the
      // count says so; read against `takenAt`, it was alive and the count is 0.
      t.equal(measured.caveats.lapsedLinks, 1,
        "a link that died since the brief was taken is dropped and reported");

      app.setAvoidance(true);
      ui.avoidSystems.value = "";
      ui.routeFrom.value = "";
      ui.routeTo.value = "";
      app.clearRouteResult();
      state.avoid = null;
      state.limits = null;
      state.routeAt = null;
      state.routeInputsUsed = null;
      while (store.open.length) app.closeAsk(store.open[0].id);
      return t.results;
    };
    return app.advisorTurn(window_, "how far is it").then(done, (error) => {
      globalThis.window = savedWindow;
      t.check(false, `the turn threw: ${error && error.message}`);
      return t.results;
    });
  }

  app.setAvoidance(true);
  ui.avoidSystems.value = "";
  ui.routeFrom.value = "";
  ui.routeTo.value = "";
  app.clearRouteResult();
  state.avoid = null;
  state.limits = null;
  state.routeAt = null;
  return t.results;
}
