// Breakpoint coverage, checked by reading the stylesheets.
//
// This cannot tell you whether anything looks right - that still needs eyes on
// a real browser. What it can tell you is whether a control that must exist at
// a given width has a rule that applies there, which is a different question
// and the one that was answered wrongly: the inspector becomes an overlay at
// 1050px and narrower, but its close button was switched on only at 1051-1200px
// and at 760px and narrower. Between those, at 761-1050px, the inspector
// covered the map with a close button that was still display:none, leaving
// a pilot on a touch screen no way out but the Escape key.
//
// Two byte-identical copies of the same rule, and a gap between them. A scan
// catches that; reading it twice evidently did not.

import fs from "node:fs";
import path from "node:path";
import { suite, ROOT } from "./helpers.mjs";

const read = name => fs.readFileSync(path.join(ROOT, "web", name), "utf8");

// Media conditions in this project are plain width ranges, so a small parser is
// honest here. Anything it cannot read is reported rather than assumed open.
function mediaRanges(css, selector) {
  const ranges = [];
  const unparsed = [];
  const re = /@media([^{]+)\{/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    // Walk braces to find this block's extent.
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    const block = css.slice(re.lastIndex, i - 1);
    if (!block.includes(selector)) continue;
    const condition = match[1].trim();
    if (/print|prefers-|orientation|aspect-ratio/.test(condition)) continue;
    const max = /max-width:\s*(\d+)px/.exec(condition);
    const min = /min-width:\s*(\d+)px/.exec(condition);
    if (!max && !min) { unparsed.push(condition); continue; }
    ranges.push({ min: min ? Number(min[1]) : 0, max: max ? Number(max[1]) : Infinity, condition });
  }
  return { ranges, unparsed };
}

const covers = (ranges, width) => ranges.some(r => width >= r.min && width <= r.max);

export default function run() {
  const t = suite("responsive");
  const responsive = read("responsive.css");
  const styles = read("styles.css");

  // The width at which the inspector starts covering the map, read from the
  // stylesheet rather than written down here, so the test follows the design.
  const overlay = /@media\s*\(max-width:\s*(\d+)px\)\s*\{[^@]*?\.inspector\s*\{[^}]*position:\s*absolute/s.exec(styles);
  t.check(overlay !== null, "the width at which the inspector becomes an overlay is discoverable in styles.css");
  const overlayMax = overlay ? Number(overlay[1]) : 1050;
  t.equal(overlayMax, 1050, "which is 1050px and narrower");

  const { ranges, unparsed } = mediaRanges(responsive, ".inspector-close");
  t.equal(unparsed.join(", "), "", "every media condition carrying the close button is a plain width range");
  t.check(ranges.length > 0, `the close button is styled in ${ranges.length} media range(s)`);

  // Every width where the inspector overlays the map must have the control.
  const uncovered = [];
  for (let width = 320; width <= overlayMax; width += 1) {
    if (!covers(ranges, width)) uncovered.push(width);
  }
  const describe = list => list.length <= 4
    ? list.join(", ")
    : `${list[0]}-${list[list.length - 1]} (${list.length} widths)`;
  t.equal(describe(uncovered), "",
    "the close control is styled at every width where the inspector covers the map");

  // The specific band the review found, named so a regression is legible.
  for (const width of [761, 900, 1000, 1050]) {
    t.check(covers(ranges, width), `${width}px: the overlay inspector has a close control`);
  }
  for (const width of [390, 760, 1051, 1200]) {
    t.check(covers(ranges, width), `${width}px: and so do the widths that always worked`);
  }

  // One rule, not several copies that can drift apart. Two identical copies
  // are what allowed a gap to open between them unnoticed.
  const bodies = [...responsive.matchAll(/\.inspector-close\s*\{([^}]*)\}/g)]
    .map(m => m[1].split(";").map(part => part.trim()).filter(Boolean).sort().join("; "))
    .filter(body => body.includes("display: grid"));
  t.equal(bodies.length, 1, "the close button's appearance is defined once");

  // The DOM shim sees hidden=true but cannot catch an author display:flex
  // overriding it. Keep these source guards alongside real-browser checks.
  // Written as a set rather than an exact sequence, because the original form
  // pinned the two selectors in order and broke the moment a third element
  // needed the same protection - which is how `live-layer` came to be left out
  // of it for as long as it was.
  const markers = read("map-markers.css");
  const hiddenGroup = /([^{}]*\[hidden\][^{}]*)\{\s*display:\s*none/s.exec(markers)?.[1] ?? "";
  for (const className of ["layout-bar", "constellations", "live-layer"]) {
    t.check(hiddenGroup.includes(`.${className}[hidden]`),
      `.${className} honours hidden, which an author display rule would otherwise defeat`);
  }
  const layoutBar = /\.layout-bar\s*\{([^}]*)\}/s.exec(markers)?.[1] ?? "";
  t.check(/flex-wrap:\s*wrap/.test(layoutBar), "layout controls can wrap on narrow screens");
  const layoutButton = /\.layout-bar button\s*\{([^}]*)\}/s.exec(markers)?.[1] ?? "";
  t.check(/flex:\s*0 0 auto/.test(layoutButton), "layout buttons retain their intrinsic width");
  t.check(/white-space:\s*nowrap/.test(layoutButton), "layout button names stay on one line");
  t.check(/\.layout-bar button:focus-visible\s*\{[^}]*outline:/s.test(markers),
    "layout buttons have an explicit keyboard-focus indicator");
  t.check(/\.system-node\.compact > \.sov-ring\s*\{\s*display:\s*block/.test(markers),
    "compact systems show ownership rings");
  t.check(/\.system-node > rect\.sov-outline\s*\{[^}]*stroke:\s*var\(--sov-colour\)/s.test(markers),
    "hover and selection do not replace the alliance outline colour");

  const route = read("route.css");
  t.check(/@media\s*\(max-width:\s*760px\)\s*\{[^}]*\.corridor-save\.bridge-save\s*\{[^}]*grid-template-columns:\s*1fr auto/s.test(route),
    "bridge entry collapses to readable rows on phone-width rails");
  t.check(/\.corridor-save\.bridge-save input\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s.test(route),
    "both bridge system fields retain the available phone width");

  // --- the harness itself ---------------------------------------------------
  //
  // The shim is only worth what its fidelity is, and two things it can silently lack
  // are the text between tags and nesting. Without them every element built from markup
  // reports an empty `textContent`, so a test reading one compares "" against "" and
  // passes - a vacuous assertion inside the tool the rest of the suite trusts.
  const probe = document.createElement("div");
  probe.innerHTML = '<span>Synced <strong>3m</strong> ago</span>'
    + '<button class="neighbor"><span>Under attack</span><span>in 2h</span></button>';
  t.equal(probe.children.length, 2, "markup parses into its top-level elements");
  t.equal(probe.children[0].textContent, "Synced 3m ago",
    "text around a nested tag keeps document order, rather than being reordered or lost");
  t.equal(probe.children[1].textContent, "Under attackin 2h",
    "a container reports its whole subtree, as a browser does, rather than nothing");
  t.equal(probe.children[1].children.length, 2, "and nesting is represented");
  t.equal(probe.querySelectorAll("span").length, 3, "selectors reach through it");

  probe.innerHTML = '<p>a &amp; b &lt;c&gt; &#39;d&#39;</p>';
  t.equal(probe.children[0].textContent, "a & b <c> 'd'",
    "the entities escapeHtml writes are decoded, as textContent would report them");

  probe.innerHTML = '<div><input id="x" value="1"><br>tail</div>';
  t.equal(probe.children[0].textContent, "tail",
    "void elements do not swallow what follows them");
  t.equal(probe.children[0].children.length, 2, "but are still children");

  probe.innerHTML = "<span>before</span>";
  probe.children[0].textContent = "after";
  t.equal(probe.children[0].textContent, "after", "and setting textContent replaces the subtree");

  // --- `hidden` has to actually hide -----------------------------------------
  // The attribute works because the UA stylesheet maps it to display:none. Any
  // author rule that sets display on the same element beats it - equal
  // specificity, author sheet wins - so `<span class="live-layer" hidden>` was
  // displayed regardless, and the wormhole slot sat on the live bar reading
  // "holes: off" with routing switched off. Found by looking at it; no
  // assertion could have, because the markup says hidden and means it.
  // Every stylesheet, because a class used with `hidden` in the markup can have
  // its display set in any of them.
  const allCss = fs.readdirSync(path.join(ROOT, "web"))
    .filter(name => name.endsWith(".css"))
    .map(name => read(name))
    .join(String.fromCharCode(10));
  const markup = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  const hiddenTags = [...markup.matchAll(/<[^>]*\shidden(?:[\s>=])[^>]*>/g)].map(m => m[0]);
  const hiddenClasses = new Set(hiddenTags
    .flatMap(tag => (/class="([^"]+)"/.exec(tag)?.[1] ?? "").split(/\s+/))
    .filter(Boolean));
  t.check(hiddenClasses.has("live-layer"),
    `the live bar still uses a class alongside the hidden attribute (${[...hiddenClasses].join(", ")})`);
  // String.raw, because in an ordinary template literal `\.` is just "." and
  // `\s` is just "s" - the escapes are eaten before RegExp ever sees them, the
  // pattern matches nothing, and every class skips the check. That is exactly
  // what happened here: this guard passed while the bug it was written for was
  // still in the stylesheet.
  let guarded = 0;
  for (const className of hiddenClasses) {
    if (!new RegExp(String.raw`\.${className}\s*\{[^}]*display:`).test(allCss)) continue;
    guarded += 1;
    t.check(new RegExp(String.raw`\.${className}\[hidden\][^{}]*\{[^}]*display:\s*none`).test(allCss),
      `.${className} sets display, so it must honour [hidden] explicitly or the attribute does nothing`);
  }
  t.check(guarded > 0,
    `at least one class used with hidden also sets display, or this loop asserts nothing (${guarded})`);

  // --- a checkbox must not be stretched by a text-field rule --------------------
  const routeCss = read("route.css");
  t.check(/\.route-avoid-body input:not\(\[type="checkbox"\]\)/.test(routeCss),
    "the full-width input rule in the avoid shelf excludes checkboxes, which it stretched across the panel");

  // --- two-column rows need a gap, not just space-between ----------------------
  // space-between places the label and value at opposite ends, which is no gap
  // at all once the row is narrow enough for them to meet. At 390px the
  // activity row's label ran into its value.
  const neighborRule = /\.neighbor\s*\{([^}]*)\}/.exec(read("styles.css"))?.[1] ?? "";
  t.check(/justify-content:\s*space-between/.test(neighborRule), "the inspector row still uses space-between");
  t.check(/gap:\s*\d/.test(neighborRule), "and carries a gap, so the two ends cannot meet at a narrow width");

  return t.results;
}
