// The harness every other test stands on.
//
// Two and a half thousand assertions run against this shim and it had no test
// of its own. That is the wrong way round: a bug here does not fail loudly, it
// makes some number of assertions elsewhere quietly meaningless, and they keep
// reporting a pass while they do it. Its own comments record two such episodes
// already - text between tags being dropped so every textContent comparison was
// "" against "", and nesting not being represented so a button holding two
// spans reported no text at all.
//
// So this pins the behaviours the application actually depends on, and the
// boundary of what the shim can represent.

import fs from "node:fs";
import path from "node:path";
import { suite, ROOT } from "./helpers.mjs";

export default function run() {
  const t = suite("dom shim");

  const el = (tag = "div") => document.createElement(tag);

  // --- selectors the application actually uses ----------------------------------
  const host = el();
  host.innerHTML = '<button class="a b" data-c="7" data-live-at="123">One</button>'
    + '<span class="a" data-c="8">Two</span>'
    + '<div class="edge" data-a="x"><i class="deep">Three</i></div>';

  t.equal(host.querySelectorAll("button").length, 1, "by tag");
  t.equal(host.querySelectorAll(".a").length, 2, "by class");
  t.equal(host.querySelectorAll("[data-c]").length, 2, "by attribute presence");
  t.equal(host.querySelectorAll('[data-c="7"]').length, 1, "by attribute value");
  t.equal(host.querySelectorAll("[data-c=7]").length, 1, "with or without quotes");
  t.equal(host.querySelectorAll(".edge[data-a]").length, 1, "compound: class and attribute together");
  t.equal(host.querySelectorAll("button.a").length, 1, "compound: tag and class together");
  t.equal(host.querySelectorAll(".a,.edge").length, 3, "a comma list is a union");
  t.equal(host.querySelector("[data-live-at]")?.textContent, "One", "querySelector takes the first");
  t.equal(host.querySelectorAll("[data-missing]").length, 0, "and something absent matches nothing");
  t.equal(host.querySelectorAll(".deep").length, 1, "the walk reaches nested children");

  // --- and the boundary of what it can represent --------------------------------
  // A descendant selector collects exactly the same parts as the compound one,
  // so "div .foo" would be answered as "div.foo": not nothing, which a test
  // might notice, but the wrong elements, which a test reports as a pass.
  for (const unsupported of ["div .foo", "div > .foo", ".a + .b", ".a ~ .b", "button:first-child", ".a:not(.b)"]) {
    let threw = null;
    try {
      host.querySelectorAll(unsupported);
    } catch (error) {
      threw = error;
    }
    t.check(threw, `${JSON.stringify(unsupported)} is refused rather than answered wrongly`);
    t.check(/cannot represent/.test(threw?.message ?? ""), `and says why (${JSON.stringify(unsupported)})`);
  }

  // --- the boundary is asked, never restated ------------------------------------
  //
  // The scan below asks the matcher rather than reimplementing the rule. A second copy
  // of a decision that lives in `_matchesOne` drifts the moment the refusal there is
  // widened, and then `querySelectorAll("*")`, `[data-x]]` and `.foo!` all pass this
  // scan as "inside the boundary" and throw at runtime. A guard whose whole job is
  // "nothing in the tree is outside the boundary" cannot hold its own opinion about
  // where the boundary is.
  //
  // It asks the matcher now, against a throwaway element, so the scan is
  // correct by construction however the rule changes.
  const representable = (selector) => {
    try {
      el().querySelectorAll(selector);
      return true;
    } catch {
      return false;
    }
  };
  t.check(!representable("*"), "the scan below asks the matcher, and the matcher refuses \"*\"");
  t.check(representable(".command-section"), "while an ordinary class selector is inside the boundary");

  // Every selector the application and the suite actually use must be inside
  // that boundary, or the refusal above turns into a crash at runtime.
  const files = [
    ...fs.readdirSync(path.join(ROOT, "web")).filter(n => n.endsWith(".js")).map(n => ["web", n]),
    ...fs.readdirSync(path.join(ROOT, "tests")).filter(n => n.endsWith(".mjs")).map(n => ["tests", n]),
  ];
  const outside = [];
  let counted = 0;
  // **Two things a scan like this gets wrong**, both harmless while it holds its own
  // loose opinion of the boundary and both immediate once it asks the matcher.
  //
  // Reading comments as code makes a comment *about* an unsupported selector report
  // itself as a violation - this file and `dom-shim.mjs` each contain one, written to
  // explain the refusal.
  //
  // And a capture stopping at the first quote of any kind turns `'[data-c="7"]'`
  // was scanned as `[data-c=` - a fragment that is not a selector at all. That
  // passed the old loose test and fails a real parse, which is the honest
  // outcome for a string the scanner invented.
  const code = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  for (const [dir, name] of files) {
    const text = code(fs.readFileSync(path.join(ROOT, dir, name), "utf8"));
    // The whole string literal, quote to matching quote, escapes included.
    for (const match of text.matchAll(/querySelectorAll?\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      counted += 1;
      for (const one of match[2].split(",").map(s => s.trim()).filter(Boolean)) {
        if (!representable(one)) outside.push(`${dir}/${name}: ${one}`);
      }
    }
  }
  t.check(counted > 20, `enough selectors were scanned to mean something (${counted})`);
  t.equal(outside.length, 0,
    `every selector in the project is one the shim can represent (${outside.slice(0, 3).join("; ")})`);

  // --- textContent is a subtree, not an element's own text -----------------------
  // The failure its own comment records: a button holding two spans reported
  // nothing, so assertions one level up compared "" against "".
  const nested = el();
  nested.innerHTML = '<button><span>Synced</span><span>3m ago</span></button>';
  t.equal(nested.querySelector("button").textContent, "Synced3m ago",
    "a parent reports the text of its whole subtree");
  const mixed = el();
  mixed.innerHTML = "<p>before<b>middle</b>after</p>";
  t.equal(mixed.querySelector("p").textContent, "beforemiddleafter",
    "and text runs keep their document order around the children");

  // --- dataset mirrors data-* the way the tick depends on ------------------------
  const dataNode = el();
  dataNode.innerHTML = '<span data-live-at="1700000000000" data-live-kind="age" data-live-embedded="true"></span>';
  const span = dataNode.querySelector("[data-live-at]");
  t.equal(span.dataset.liveAt, "1700000000000", "data-live-at becomes dataset.liveAt");
  t.equal(span.dataset.liveKind, "age", "hyphenated names become camel case");
  t.equal(span.dataset.liveEmbedded, "true", "including the longer ones");

  // --- setAttribute and getAttribute agree --------------------------------------
  const attr = el();
  attr.setAttribute("data-x", "1");
  t.equal(attr.getAttribute("data-x"), "1", "an attribute reads back");
  t.equal(attr.getAttribute("data-absent"), null, "and an absent one is null, not undefined");

  // --- listeners accumulate ------------------------------------------------------
  // Replacing meant the second of two handlers discarded the first, and app.js
  // registers two pointerdown handlers on the map.
  const target = el();
  const seen = [];
  target.addEventListener("pointerdown", () => seen.push("first"));
  target.addEventListener("pointerdown", () => seen.push("second"));
  target.dispatch("pointerdown");
  t.equal(seen.join(","), "first,second", "both listeners for one event type run");

  return t.results;
}
