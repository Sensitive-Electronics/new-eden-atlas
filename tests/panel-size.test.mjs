// The rail's limits, which exist to stop the map going under the inspector.
//
// The interesting cases are all about the window rather than the drag: a width
// that is fine on a wide monitor is not fine when the same stored preference
// opens on a laptop, and nothing about the drag itself would ever notice.

import fs from "node:fs";
import path from "node:path";
import { suite, ROOT } from "./helpers.mjs";
import {
  RAIL_DEFAULT, RAIL_MIN, RAIL_MAX, MAP_MIN, INSPECTOR_WIDTH,
  clampRailWidth, railCeiling, inspectorCost,
} from "../web/panel-size.js";

export default function run(app) {
  const t = suite("panel size");

  // --- the numbers duplicated from the stylesheet --------------------------
  //
  // MAP_MIN and INSPECTOR_WIDTH are the grid's own values, written again here
  // because the clamp needs them as numbers. A duplicate that drifts is worse
  // than either copy, and "if the stylesheet changes, this changes" is a note
  // asking someone to remember rather than a thing that holds.
  {
    const css = fs.readFileSync(path.join(ROOT, "web", "styles.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    t.check(css.includes(`minmax(${MAP_MIN}px,1fr)`) || css.includes(`minmax(${MAP_MIN}px, 1fr)`),
      `the shell grid still gives the map a ${MAP_MIN}px floor`);
    t.check(css.includes(`${INSPECTOR_WIDTH}px`),
      `and the inspector is still ${INSPECTOR_WIDTH}px wide`);
    t.check(css.includes(`var(--rail-width, ${RAIL_DEFAULT}px)`),
      `and the stylesheet's fallback rail width is still ${RAIL_DEFAULT}px`);
    // Both rules that size the rail must read the same variable, or the header
    // slides out of line with the panel under it.
    //
    // Named rather than counted. This asserted "exactly two occurrences", which
    // is a proxy for the real property and broke the moment the resize handle
    // started positioning itself from the same variable - a correct change that
    // failed a check measuring the wrong thing.
    for (const rule of ["topbar", "shell"]) {
      const body = (css.split(`.${rule} {`)[1] ?? "").split("}")[0];
      t.check(/grid-template-columns:\s*var\(--rail-width/.test(body),
        `.${rule} sizes its first column from the rail width variable`);
    }
  }

  // --- the resize handle is not inside the thing it resizes ----------------
  //
  // Two wrong fixes preceded the right one, and both were about pixels when the
  // cause was containment. `.rail` is a scroll container and it overflows, so
  // WebKit paints an overlay scrollbar over it - which takes no layout space,
  // is not a DOM element, and therefore sits outside the stacking order where
  // no z-index can reach it. A handle inside the rail hit-tested as the rail at
  // every one of its own pixels, while getBoundingClientRect reported it
  // perfectly placed.
  //
  // Nothing in a headless suite can hit-test. What it can hold is the structural
  // fact that made it possible: the handle must not be a child of the element it
  // resizes, and it must position itself against the shell.
  {
    const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
    const rail = html.split('<aside class="rail"')[1]?.split("</aside>")[0] ?? "";
    t.check(!rail.includes('id="railResize"'),
      "the resize handle is not inside the rail, which is a scroll container");
    t.check(html.includes('id="railResize"'), "but it is still on the page");

    // Comments stripped before anything is asserted against this. Three checks
    // tonight matched prose instead of code: a rule whose comment quotes the
    // wrong answers it replaced satisfies any search for them. A checker that
    // reads source and does not strip comments inherits the failure it exists
    // to catch.
    const css = fs.readFileSync(path.join(ROOT, "web", "styles.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const shell = (css.split(".shell {")[1] ?? "").split("}")[0];
    t.check(/position:\s*relative/.test(shell),
      "and the shell is a containing block, so the handle can be placed against it");
    const handle = (css.split(".rail-resize {")[1] ?? "").split("}")[0];
    // The property, not the spelling. This asserted `left: calc(var(...))` and
    // broke when the calc became unnecessary - the third check tonight to fail
    // on the shape of a correct change rather than on a wrong one.
    t.check(/left:\s*[^;]*var\(--rail-width/.test(handle),
      "the handle's left edge is derived from the rail width, so it tracks the rail");
    t.check(!/right:/.test(handle),
      "and it is placed from one side only, so width is not silently ignored");
  }

  // --- the rail can still scroll -------------------------------------------
  //
  // `overflow-y:auto` moved into `.rail` from responsive.css and landed above
  // an `overflow:hidden` that was already there for horizontal clipping. The
  // shorthand resets both axes, so the later one won and the region list could
  // not be scrolled at all - no scrollbar, no wheel, nothing, with both
  // declarations plainly present in the file and looking correct.
  //
  // A shorthand silently overriding a longhand written above it is exactly what
  // a headless suite can check and eyes cannot.
  {
    const css = fs.readFileSync(path.join(ROOT, "web", "styles.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const rail = (css.split(".rail {")[1] ?? "").split("}")[0];
    const decls = rail.split(";").map(d => d.trim()).filter(Boolean);
    const props = decls.map(d => d.split(":")[0].trim());

    t.check(props.includes("overflow-y"), "the rail declares a vertical overflow");
    t.check(!props.includes("overflow"),
      "and never the shorthand, which would reset the axis declared above it");

    // Order, because the bug was ordering rather than presence.
    const y = props.lastIndexOf("overflow-y");
    const shorthand = props.lastIndexOf("overflow");
    t.check(shorthand === -1 || shorthand < y,
      "no overflow shorthand follows the vertical one");
    t.check(/auto|scroll/.test(decls[y]?.split(":")[1] ?? ""),
      `the rail scrolls vertically (${decls[y] ?? "absent"})`);
  }

  // --- the shell's row is bounded, so its panels can overflow --------------
  //
  // `.shell` has a fixed height and three columns, and had no
  // `grid-template-rows`. An implicit row is `auto`, which sizes to the tallest
  // item's max-content - the rail with every section expanded - so the rail was
  // stretched to a row exactly as tall as its own content and could never
  // overflow. The scrollbar appeared, its thumb filled the track, and resizing
  // the window changed nothing, because the row tracked content rather than the
  // viewport.
  //
  // `min-height:0` on the items is necessary and not sufficient: it permits an
  // item to be shorter than its content, while an `auto` row still asks for
  // max-content. A panel that declares `overflow-y:auto` inside an unbounded
  // row has a scrollbar that can never do anything.
  {
    const css = fs.readFileSync(path.join(ROOT, "web", "styles.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const shell = (css.split(".shell {")[1] ?? "").split("}")[0];
    t.check(/grid-template-rows\s*:/.test(shell),
      "the shell sizes its row rather than leaving it to content");
    t.check(/grid-template-rows\s*:\s*minmax\(\s*0/.test(shell),
      "and the row may be shorter than its content, or the panels cannot scroll");
    const railShared = (css.split(".rail,.inspector {")[1] ?? "").split("}")[0];
    t.check(/min-height\s*:\s*0/.test(railShared),
      "and the panels may be shorter than theirs, which the row alone does not grant");
  }

  // --- one file decides the rail's layout ----------------------------------
  //
  // `responsive.css` carried an unconditional `.rail` rule setting overflow,
  // display and flex-direction, in a file whose name says otherwise. The rail's
  // layout came from two files that disagreed, and which won was decided by the
  // order of the link tags in index.html.
  {
    // Stripped, like the other reads in this file. These assert that a
    // property is *absent*, which is the direction a comment breaks: the
    // rule below is preceded by a comment explaining why its overflow moved
    // elsewhere, and the only thing keeping that out of the match is where
    // the comment happens to sit. A check that depends on comment placement
    // is the same defect this file has fixed three times.
    const responsive = fs.readFileSync(path.join(ROOT, "web", "responsive.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const unconditional = responsive.split("@media")[0];
    t.check(!/\.rail\s*\{[^}]*overflow/.test(responsive),
      "responsive.css does not set the rail's overflow");
    t.check(!/\.rail\s*\{[^}]*display:\s*flex/.test(unconditional),
      "nor its display mode outside a media query");
  }

  // --- the ceiling is what is left, not a constant -------------------------
  const wide = 2560;
  t.equal(railCeiling(wide), RAIL_MAX,
    "on a wide monitor the rail stops at its own maximum, not at the window");

  // 1400 wide: the inspector is still a column, so 1400 - 420 - 300 = 680,
  // which is more than RAIL_MAX, so RAIL_MAX still wins.
  t.equal(railCeiling(1400), RAIL_MAX, "and at 1400 there is still room to spare");

  // 1100: below the breakpoint, so the inspector is an overlay and costs
  // nothing. 1100 - 420 = 680, still over the maximum.
  t.equal(inspectorCost(1100), 0, "below the breakpoint the inspector is an overlay and costs nothing");
  t.equal(inspectorCost(1400), INSPECTOR_WIDTH, "above it, it is a column and costs its width");

  // 900: 900 - 420 = 480. Now the window is the binding constraint.
  t.equal(railCeiling(900), 480, "on a narrow window the window is what limits the rail");
  t.check(railCeiling(900) < RAIL_MAX, "and it is tighter than the fixed maximum");

  // --- the map keeps its floor ---------------------------------------------
  //
  // The property that matters, stated as itself: whatever the window, the rail
  // plus the inspector must leave the map at least its 420px.
  for (const viewport of [800, 900, 1000, 1200, 1201, 1400, 1920, 2560]) {
    const taken = railCeiling(viewport) + inspectorCost(viewport);
    const left = viewport - taken;
    t.check(left >= MAP_MIN || railCeiling(viewport) === RAIL_MIN,
      `at ${viewport}px the map keeps ${MAP_MIN}px, or the rail is already at its minimum`);
  }

  // --- a window too small for everything -----------------------------------
  //
  // Something must overflow and it is the map, which pans and scrolls, rather
  // than the rail, which would become a strip of clipped words.
  t.equal(railCeiling(500), RAIL_MIN, "when nothing fits, the rail falls back to its minimum");
  t.equal(clampRailWidth(400, 500), RAIL_MIN, "and a stored width cannot push past that");

  // --- clamping a stored preference ----------------------------------------
  t.equal(clampRailWidth(320, wide), 320, "a reasonable stored width is kept");
  t.equal(clampRailWidth(40, wide), RAIL_MIN, "a tiny one comes up to the minimum");
  t.equal(clampRailWidth(9000, wide), RAIL_MAX, "a huge one comes down to the maximum");
  t.equal(clampRailWidth(320.6, wide), 321, "fractions are rounded, because a grid column is pixels");

  // The same stored width, two machines.
  t.equal(clampRailWidth(520, 2560), 520, "520 is fine on a wide monitor");
  t.equal(clampRailWidth(520, 900), 480, "and the same preference is cut down on a laptop");

  // --- unreadable values are the default, never an error -------------------
  //
  // This is a cosmetic preference out of browser storage. A corrupt one must
  // not be the reason a map fails to draw.
  for (const bad of [null, undefined, NaN, "wide", {}, [], Infinity, -Infinity]) {
    t.equal(clampRailWidth(bad, wide), RAIL_DEFAULT,
      `${String(bad)} reads as the default rather than throwing`);
  }
  t.equal(clampRailWidth(undefined, 500), RAIL_MIN,
    "and the default is itself clamped when the window cannot hold it");

  // --- the bounds are coherent ---------------------------------------------
  t.check(RAIL_MIN < RAIL_DEFAULT && RAIL_DEFAULT < RAIL_MAX, "minimum, default and maximum are in order");
  t.equal(clampRailWidth(clampRailWidth(333, wide), wide), clampRailWidth(333, wide),
    "clamping twice is the same as clamping once");

  // --- what the application does with those limits -------------------------
  //
  // The pure part above is arithmetic. This is the part that can be wrong in a
  // way a pilot notices: a width that is not applied, or one that is saved when
  // it should not be.
  {
    const { applyRailWidth, restoreRailWidth } = app;
    const KEY = "new-eden-atlas-panels-v1";
    const root = globalThis.document.documentElement;
    const read = () => root.style.getPropertyValue("--rail-width");
    const stored = () => {
      const raw = globalThis.localStorage.getItem(KEY);
      try { return raw === null ? null : JSON.parse(raw); } catch { return "unparseable"; }
    };
    // The shim has no `window`, so the ceiling would never be reached and the
    // viewport half of the clamp would go unexercised - the half that exists
    // because the same preference opens on two different machines.
    const savedWindow = globalThis.window;
    const setViewport = px => {
      globalThis.window = { ...(savedWindow ?? {}), innerWidth: px, addEventListener() {} };
    };

    setViewport(2560);
    globalThis.localStorage.removeItem(KEY);

    applyRailWidth(320);
    t.equal(read(), "320px", "a width is applied to the grid as a custom property");
    t.equal(stored(), null, "and is not saved unless the pilot chose it");

    applyRailWidth(340, { save: true });
    t.equal(read(), "340px", "a chosen width is applied");
    t.equal(stored()?.railWidth, 340, "and saved");

    // The property this guards: a smaller window re-clamps the live width, but
    // must not rewrite the preference. Otherwise opening the app once on a
    // laptop would permanently shrink the width chosen on a monitor.
    setViewport(900);
    applyRailWidth(340);
    t.equal(read(), "340px", "a width that still fits the smaller window is kept");
    t.equal(stored()?.railWidth, 340, "and the saved preference is untouched");

    applyRailWidth(540);
    t.equal(read(), "480px", "a width too wide for this window is cut to what fits");
    t.equal(stored()?.railWidth, 340, "and the preference still says what the pilot asked for");

    // Restoring on a wide screen gets the preference back, unshrunk.
    setViewport(2560);
    restoreRailWidth();
    t.equal(read(), "340px", "the chosen width returns on a screen that can hold it");

    // --- a corrupt preference is not a broken layout ------------------------
    globalThis.localStorage.setItem(KEY, "{ not json");
    restoreRailWidth();
    t.equal(read(), `${RAIL_DEFAULT}px`, "an unparseable preference falls back to the default");

    globalThis.localStorage.setItem(KEY, JSON.stringify({ railWidth: null }));
    restoreRailWidth();
    t.equal(read(), `${RAIL_DEFAULT}px`, "and so does a null width, rather than a rail at its minimum");

    globalThis.localStorage.setItem(KEY, JSON.stringify({ railWidth: "wide" }));
    restoreRailWidth();
    t.equal(read(), `${RAIL_DEFAULT}px`, "and a width that is not a number");

    globalThis.localStorage.removeItem(KEY);
    restoreRailWidth();
    t.equal(read(), `${RAIL_DEFAULT}px`, "a first run is the default");

    globalThis.window = savedWindow;
  }

  // --- a wheel over the strip moves whatever can move ----------------------
  //
  // The forwarder was written as `ui.rail.scrollTop += delta` while the rail
  // was believed to be the scroll container. It usually is not: `.region-list`
  // is `flex: 1 1 auto` with its own overflow, so it shrinks to what the
  // sections leave and absorbs the scrolling, and the rail has nothing to move.
  // The forwarder was a no-op that swallowed the event - which reads as a stuck
  // list rather than as a control wired to the wrong element.
  {
    const { scrollTargetIn } = app;
    const el = (scrollHeight, clientHeight, child = null) => ({
      scrollHeight, clientHeight, scrollTop: 0,
      querySelector: sel => (sel === ".region-list" ? child : null),
    });

    const list = el(900, 300);
    t.equal(scrollTargetIn(el(400, 400, list)), list,
      "the index scrolls when it is the one that overflows");

    const flat = el(300, 300);
    const rail = el(900, 400, flat);
    t.equal(scrollTargetIn(rail), rail,
      "the rail scrolls when the index has nothing to move");

    t.equal(scrollTargetIn(el(400, 400, el(300, 300))), null,
      "and nothing is returned when nothing can scroll, so the wheel is left alone");
    t.equal(scrollTargetIn(null), null, "a missing rail is not an error");

    // The innermost wins, which is what a browser does with nested scrollers.
    const both = el(900, 400, el(900, 300));
    t.check(scrollTargetIn(both) !== both, "with both scrollable, the inner one takes it");
  }

  // --- the drag takes one pointer, and only the primary button -------------
  //
  // Added after a targeted mutation survived: deleting the button guard changed
  // nothing any assertion could see, which by this project's own standard makes
  // it a fix that cannot be proven. A right-click began a resize that followed
  // the mouse - with `preventDefault` swallowing the context menu on the way -
  // and a second finger started a second drag whose moves fought the first.
  //
  // Driven through the real listeners rather than by calling a function, so
  // what is exercised is the handler a pointer actually reaches.
  {
    const savedWindow = globalThis.window;
    globalThis.window = { ...(savedWindow ?? {}), innerWidth: 2560, addEventListener() {} };

    const root = globalThis.document.documentElement;
    const width = () => root.style.getPropertyValue("--rail-width");
    const handle = globalThis.document.getElementById("railResize");
    const rail = globalThis.document.getElementById("rail");
    rail._rect = { left: 0, top: 0, width: 280, height: 800 };

    app.bindRailResize();
    app.applyRailWidth(280);

    const down = button => handle.dispatch("pointerdown", { button, isPrimary: true, pointerId: 1 });
    const move = clientX => handle.dispatch("pointermove", { clientX, pointerId: 1 });
    const up = () => handle.dispatch("pointerup", { pointerId: 1 });

    // Secondary button: no drag.
    down(2); move(420);
    t.equal(width(), "280px", "a right-click does not begin a resize");
    up();

    // Middle button: no drag either.
    down(1); move(430);
    t.equal(width(), "280px", "nor a middle-click");
    up();

    // A second, non-primary pointer: no drag.
    handle.dispatch("pointerdown", { button: 0, isPrimary: false, pointerId: 2 });
    move(440);
    t.equal(width(), "280px", "nor a second finger while another pointer owns the drag");
    up();

    // The primary button does.
    down(0); move(360);
    t.equal(width(), "360px", "the primary button resizes, measured from the rail's left edge");
    up();

    // And a move after release is ignored, so a stray pointer does not resize.
    move(500);
    t.equal(width(), "360px", "a move after the drag ended changes nothing");

    globalThis.window = savedWindow;
  }

  return t.results;
}
