// A minimal DOM, sufficient to execute the atlas interface headlessly.
//
// This is deliberately not a browser. It implements only what web/app.js
// actually uses, so that interface logic can be verified without a browser or
// any installed dependency, in keeping with the project's offline-first rule.
// Anything it cannot model - real layout, paint, or CSS - is out of scope and
// must still be checked by eye.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The entities escapeHtml produces, turned back. A browser would give
// textContent the decoded form, and a test comparing it against a freshly
// formatted string has to see the same thing.
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&quot;": '"' };
const decodeEntities = text => text.replace(/&(amp|lt|gt|#39|quot);/g, m => ENTITIES[m]);

// One compound selector - "div.foo[data-x=1]" - as the list of its parts, or a
// refusal. Everything this shim will not answer correctly is refused here,
// once, rather than guessed at per element.
//
// The refusals are not fussiness. This shim carries the whole suite, and a
// selector it misreads makes every assertion downstream of it worthless while
// reading as a pass. Three forms have each cost real time:
//
//   - **Combinators and pseudo-classes.** "div .foo" collects exactly the same
//     parts as "div.foo" and answers a different question, confidently.
//   - **`#id`**, which the part pattern did not match at all, so `parts` came
//     back null and every `querySelector("#thing")` answered "no such element"
//     - for any id, including one sitting in the tree.
//   - **The substring operators `^= $= *= |=`.** The bracket alternative
//     swallows the whole `[...]`, so they reconstruct perfectly; `indexOf("=")`
//     then splits at the `=` and matches an attribute literally named
//     `data-x^`. Against an element really carrying `data-x="alpha"`,
//     `[data-x^="al"]` answered zero.
function compoundParts(selector) {
  const trimmed = String(selector).trim();
  const refuse = (why) => {
    throw new Error(
      `dom-shim cannot represent the selector ${JSON.stringify(selector)}. ${why} `
      + "It supports a single compound selector - tag, #id, .class, [attr], [attr=value] - and comma lists of them.",
    );
  };
  if (trimmed === "") refuse("It is empty, which a browser rejects outright.");
  if (/[\s>+~]/.test(trimmed) || trimmed.includes(":")) {
    refuse("Combinators and pseudo-classes would be matched wrongly rather than not at all.");
  }
  const parts = trimmed.match(/(^[a-zA-Z][\w-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])/g);
  // Reconstruction, so anything the pattern could not account for is refused
  // rather than silently dropped from the compound.
  if (!parts || parts.join("") !== trimmed) refuse("Part of it was not recognised.");
  for (const part of parts) {
    if (!part.startsWith("[")) continue;
    const body = part.slice(1, -1);
    const eq = body.indexOf("=");
    if (eq > 0 && "^$*|~!".includes(body[eq - 1])) {
      refuse("It uses a substring operator, which would match an attribute whose name ends in the operator.");
    }
  }
  return parts;
}

// A comma list. An empty list is refused for the same reason an empty compound
// is: `querySelectorAll("")` returning nothing looks like an answer, and a
// selector built from an undefined template variable is exactly how one
// arrives.
function selectorGroups(sel) {
  const groups = String(sel).split(",").map(x => x.trim()).filter(Boolean).map(compoundParts);
  if (!groups.length) {
    throw new Error(`dom-shim cannot represent the selector ${JSON.stringify(sel)}. It names nothing.`);
  }
  return groups;
}

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    // Text runs and child elements in document order. `children` stays
    // elements-only, because everything else walks it looking for tags.
    this._nodes = [];
    // A standing text node. app.js writes label text through
    // firstChild.nodeValue, which is how a real element built from markup
    // behaves; without one the jump panel's change handler threw here and no
    // test could dispatch a real event at it.
    this.firstChild = { nodeValue: "" };
    this.value = "";
    this.checked = false;
    this.open = false;
    this.clicks = 0;
    this._classes = new Set();
    this._html = "";
    const self = this;
    this.classList = {
      add: (...c) => c.forEach(x => self._classes.add(x)),
      remove: (...c) => c.forEach(x => self._classes.delete(x)),
      toggle: (c, on) => {
        const want = on === undefined ? !self._classes.has(c) : on;
        want ? self._classes.add(c) : self._classes.delete(c);
      },
      contains: c => self._classes.has(c),
    };
  }

  // What a browser means by textContent: this element's own text and all of its
  // descendants', in order. Setting it replaces the subtree, as a browser does.
  get textContent() {
    return (this._nodes ?? []).map(node => (typeof node === "string" ? node : node.textContent)).join("");
  }

  set textContent(value) {
    this._nodes = [String(value ?? "")];
    this.children = [];
  }

  // `id` reflects to the attribute, as a browser's does. Without this,
  // `node.id = "brief-read"` set a bare property that no selector could see.
  get id() { return this.attributes.id ?? ""; }
  set id(value) { this.setAttribute("id", String(value)); }

  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  get innerHTML() { return this._html; }

  // Parses only what the atlas emits: flat runs of elements carrying class and
  // data-* attributes, which is all that querySelectorAll is ever asked for.
  // Parses the nested markup the atlas actually emits.
  //
  // Not a flat scan for opening tags, which drops two things silently. Text between
  // tags is discarded, so every element built from markup has an empty `textContent`
  // and a test reading one compares "" against "". And nesting is not represented, so
  // a button holding two spans reports no text of its own where a browser reports
  // both - vacuous one level further up, in the place most likely to be read.
  //
  // It keeps a stack now, so children hang off their parent and textContent
  // concatenates a subtree the way a browser does. Still not a parser: void
  // elements are listed rather than inferred, and malformed markup is not
  // recovered from. The atlas emits its markup from template literals, so what
  // arrives here is well formed or the template is wrong.
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    this._nodes = [];
    const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);
    const token = /<\/?([\w-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
    const stack = [this];
    let match;
    while ((match = token.exec(this._html))) {
      const [raw, name, attrs, text] = match;
      const top = stack[stack.length - 1];
      if (text !== undefined) {
        if (text.trim()) (top._nodes ??= []).push(decodeEntities(text));
        continue;
      }
      if (raw.startsWith("</")) {
        if (stack.length > 1 && stack[stack.length - 1].tagName === name) stack.pop();
        continue;
      }
      const el = new El(name);
      const attr = /([\w-]+)="([^"]*)"/g;
      let a;
      while ((a = attr.exec(attrs ?? ""))) {
        el.setAttribute(a[1], decodeEntities(a[2]));
        if (a[1].startsWith("data-")) {
          el.dataset[a[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = decodeEntities(a[2]);
        }
      }
      el.parentNode = top;
      top.children.push(el);
      (top._nodes ??= []).push(el);
      if (!VOID.has(name) && !raw.endsWith("/>")) stack.push(el);
    }
  }

  setAttribute(k, v) { this.attributes[k] = String(v); if (k === "class") this.className = v; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  appendChild(n) { n.parentNode = this; this.children.push(n); (this._nodes ??= []).push(n); return n; }
  append(...ns) { ns.forEach(n => this.appendChild(n)); }
  insertBefore(n, ref) {
    const i = this.children.indexOf(ref);
    n.parentNode = this;
    i < 0 ? this.children.push(n) : this.children.splice(i, 0, n);
    return n;
  }
  replaceChildren(...ns) { this.children = []; this._nodes = []; ns.forEach(n => this.appendChild(n)); }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.children = p.children.filter(c => c !== this);
    p._nodes = (p._nodes ?? []).filter(c => c !== this);
    this.parentNode = null;
  }
  click() { this.clicks += 1; if (typeof this.onclick === "function") this.onclick(); }

  _walk(out = []) { for (const c of this.children) { out.push(c); c._walk(out); } return out; }
  // Handles compound selectors such as ".edge[data-a]". Treating the whole
  // string as one class name made filterConstellation's selector match
  // nothing, so that code path silently "passed" whatever it did.
  _matchesParts(parts) {
    return parts.every(part => {
      if (part.startsWith("#")) return this.getAttribute("id") === part.slice(1);
      if (part.startsWith(".")) return this._classes.has(part.slice(1));
      if (part.startsWith("[")) {
        const body = part.slice(1, -1);
        const eq = body.indexOf("=");
        if (eq === -1) return this.getAttribute(body) !== null;
        const name = body.slice(0, eq);
        const value = body.slice(eq + 1).replace(/^["']|["']$/g, "");
        return this.getAttribute(name) === value;
      }
      return this.tagName === part;
    });
  }

  _matchesOne(selector) { return this._matchesParts(compoundParts(selector)); }
  _matches(sel) { return selectorGroups(sel).some(parts => this._matchesParts(parts)); }

  // **Parsed before anything is walked.** Validating inside the per-element match
  // makes the refusal depend on what the tree happens to contain:
  // `querySelectorAll("*")` throws against an element with children and returns `[]`
  // against one without, because `filter` never calls the matcher and so never reaches
  // the check. A guard that fires only when there is something to match is not a guard
  // - it is a coin toss weighted by the fixture, and the empty case is the one a test
  // is most likely to be
  // asserting on.
  querySelectorAll(sel) {
    const groups = selectorGroups(sel);
    return this._walk().filter(n => groups.some(parts => n._matchesParts(parts)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  // Appends. Replacing meant the second of two listeners silently discarded
  // the first: app.js registers two pointerdown handlers on the map, so the
  // drag handler was being thrown away under the harness.
  addEventListener(type, fn) { ((this._listeners ??= {})[type] ??= []).push(fn); }
  // Every real element has one, and code that measures before it acts is
  // ordinary rather than exotic. Without it the rail's drag could not be driven
  // here at all, which is how its button guard reached the tree untested: a
  // mutation removing it changed nothing the suite could see.
  // Zeros unless a test sets `_rect`, so measuring is possible and no geometry
  // is invented.
  getBoundingClientRect() {
    const r = this._rect ?? {};
    const left = r.left ?? 0, top = r.top ?? 0;
    const width = r.width ?? 0, height = r.height ?? 0;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }
  dispatch(type, event = {}) {
    for (const fn of this._listeners?.[type] ?? []) fn({ preventDefault() {}, ...event });
  }
  get parentElement() { return this.parentNode ?? null; }
}

const registry = new Map();
const store = new Map();
const downloads = [];

// The ids the real page actually ships. Parsed from index.html rather than
// listed here, so the harness and the page cannot drift apart: fabricating an
// element for any id asked for meant a renamed id in index.html left the whole
// suite green while the real page threw on first render.
function pageIds() {
  const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
}

// The data-* attributes those elements ship with. An element built here carried
// an empty dataset whatever the page said, so app.js reading button.dataset.x
// on a control declared in index.html got undefined, and a test could not tell
// a working control from a broken one. Same reasoning as pageIds above: read
// the page rather than describe it.
function pageDatasets() {
  const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  const found = new Map();
  for (const tag of html.matchAll(/<\w+([^>]*\sid="[^"]+"[^>]*)>/g)) {
    const id = /\sid="([^"]+)"/.exec(tag[1]);
    if (!id) continue;
    const data = {};
    for (const attr of tag[1].matchAll(/\sdata-([\w-]+)="([^"]*)"/g)) {
      data[attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attr[2];
    }
    found.set(id[1], data);
  }
  return found;
}

export function installDom() {
  registry.clear();
  store.clear();
  downloads.length = 0;

  const known = pageIds();
  const datasets = pageDatasets();
  globalThis.__pageIds = known;

  globalThis.document = {
    createElement: t => new El(t),
    createElementNS: (_ns, t) => new El(t),
    // Only ids that exist in index.html resolve. Anything else is null, as in
    // a browser, so a reference to a missing element fails here too.
    getElementById: id => {
      if (!known.has(id)) return null;
      if (!registry.has(id)) {
        const el = new El("div");
        // **The id, or `#id` is a half-fix.** Adding `#id` to the selector
        // parser closed the hole for elements the shim builds and left it open
        // for every element it reads out of `index.html` - which is the half
        // the shim goes to trouble to model faithfully. `stage.querySelector
        // ("#map")` was null for an element sitting in that stage, and the new
        // `get id()` answered `""` confidently rather than `undefined`, which
        // is the worse of the two wrongs: a plausible empty string reads as an
        // answer.
        el.setAttribute("id", id);
        for (const [key, value] of Object.entries(datasets.get(id) ?? {})) {
          el.dataset[key] = value;
          el.setAttribute(`data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value);
        }
        registry.set(id, el);
      }
      return registry.get(id);
    },
    addEventListener() {},
    get activeElement() { return null; },
    // A real document has both, and code that sets a custom property on the
    // root or toggles a class on the body is ordinary rather than exotic. The
    // rail's width is a CSS variable on documentElement; without this the shim
    // would report "no root element" and the feature would be untestable
    // rather than tested.
    documentElement: (() => {
      const custom = new Map();
      const root = new El("html");
      root.style.setProperty = (name, value) => custom.set(name, String(value));
      root.style.getPropertyValue = name => custom.get(name) ?? "";
      root.style.removeProperty = name => custom.delete(name);
      return root;
    })(),
    body: new El("body"),
  };
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  globalThis.Blob = class { constructor(parts) { this.text = parts.join(""); } };
  // Attached to the real URL rather than replacing it. A browser's URL is both
  // a constructor and the home of createObjectURL; replacing it with an object
  // carrying only the download stubs made `new URL(...)` a TypeError, which is
  // the shim lying about the platform rather than standing in for it.
  URL.createObjectURL = blob => { downloads.push(blob.text); return "blob:stub"; };
  URL.revokeObjectURL = () => {};
  // THIS HARNESS IS NOT A CLOCK.
  //
  // Timers run immediately so that code which defers a render does not have to
  // be awaited by every test. The cost is that anything *measured in time* is
  // not measured here at all: a debounce fires on every call, a retry backoff
  // takes no time, and `new Promise(r => setTimeout(r, 0))` resolves in one
  // microtask instead of draining the queue.
  //
  // That is not a theoretical hazard. The core-store debounce was silently
  // twelve writes instead of one under this stub, and the suite reported it as
  // working, because a test written against an immediate scheduler measures the
  // scheduler rather than the code.
  //
  // A test that means to exercise timing must bring its own clock - borrow the
  // real one from `node:timers` for its own duration and put this back
  // afterwards, as tests/core-store.test.mjs does. Nothing fights back when it
  // does: the whole suite was run once with this line removed and passed
  // unchanged, so no assertion currently depends on timers being immediate.
  // The stub is a convenience for deferred renders, not a load-bearing part of
  // any test - which is worth knowing before anyone assumes it is one.
  globalThis.setTimeout = fn => { fn(); return 0; };

  // The real page nests #map inside .map-stage, and legend() appends to that
  // parent. Model it here so every test gets a document shaped like the one
  // the code was written against.
  const stage = new El("div");
  stage.className = "map-stage";
  stage.appendChild(document.getElementById("map"));
  globalThis.__mapStage = stage;

  // window stays undefined on purpose: app.js guards its init() on it, so
  // importing the module under test must not kick off a fetch.
  return { registry, store, downloads, El, stage };
}

export { El, registry, store, downloads };
