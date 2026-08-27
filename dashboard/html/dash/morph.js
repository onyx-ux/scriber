// Redrawing a panel without throwing away what the person is doing inside it.
//
// Every screen on this dashboard is a template literal assigned straight to
// `innerHTML`, and the page polls every five seconds. Those two facts do not
// get along: `innerHTML` destroys and rebuilds every node underneath it, so a
// poll that lands while somebody is typing takes the caret, the selection, the
// scroll position and any text the server has not heard about yet.
//
// The page had worked around that three times, each one narrower than the
// last, and the widest of them was a real bug:
//
//   const typing = () => ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName);
//   if (typing()) { renderTop(); renderBanner(); return; }
//
// Focus in ANY field froze the WHOLE dashboard — recording state, job
// progress, the session list — until the person clicked away. The cure for a
// stolen caret was a dashboard that stopped telling the truth.
//
// So: patch the tree instead of replacing it. Nodes that are still wanted stay
// put, which means everything the browser hangs off a node — focus, caret,
// scroll offset, a half-typed word — stays with it. This is the one thing a
// virtual DOM does that a template literal cannot, and it is about eighty
// lines rather than a framework. See docs/adr/0002.
//
// Loaded as a classic script from an absolute path, by both the dashboard and
// the gatehouse. Absolute because the two pages are served from different
// prefixes (/app/ and /gatehouse/) and a relative src would resolve under each
// of them; '/dash/morph.js' is the same convention as the API constant, and
// nginx's catch-all `location /` already serves it under the same gate. No
// module syntax, no build step: browsers run it as-is and the test harness
// runs it in the same shared scope the page's own script gets.

(function attach(global) {
  'use strict';

  // Which children of the new tree are the same children as the old tree's.
  //
  // Pure, and separated from every DOM call on purpose: this is where the
  // subtle bugs live, so it has to be testable without a browser. Both
  // arguments are lists of keys; the answer says, for each node the new tree
  // wants, which old node to reuse (`from`, or -1 to build a fresh one), plus
  // which old nodes nothing claimed.
  //
  // Duplicate keys are consumed left to right rather than all matching the
  // first node, so two rows that key the same do not collapse into one.
  function plan(oldKeys, newKeys) {
    const free = new Map();
    oldKeys.forEach((key, i) => {
      if (!free.has(key)) free.set(key, []);
      free.get(key).push(i);
    });

    const claimed = new Set();
    const ops = newKeys.map((key) => {
      const queue = free.get(key);
      const from = queue && queue.length ? queue.shift() : -1;
      if (from >= 0) claimed.add(from);
      return { key, from };
    });

    const removed = [];
    for (let i = 0; i < oldKeys.length; i += 1) if (!claimed.has(i)) removed.push(i);

    return { ops, removed };
  }

  // What makes two nodes across two renders "the same node".
  //
  // `data-key` first, because that is the page saying so out loud and is the
  // only thing that survives reordering. `id` next, for the panels that
  // already have one. Otherwise position among siblings OF THE SAME TAG —
  // which is deliberately weaker than plain position: inserting a <p> above a
  // list of <div> rows leaves every row matched to itself, where counting all
  // children would shift each one down by a place and repaint the lot.
  //
  // The tag is part of the fallback key so a <div> is never patched into a
  // <span>. Explicit keys carry no tag, so patch() checks that separately.
  function keyOf(node, tally) {
    const bump = (name) => {
      tally[name] = (tally[name] || 0) + 1;
      return name + '/' + tally[name];
    };

    if (node.nodeType === 3) return bump('#text');
    if (node.nodeType !== 1) return bump('#node');

    const said = node.getAttribute('data-key') || node.getAttribute('id');
    return said ? '@' + said : bump(node.tagName);
  }

  // Elements whose value is live state rather than markup. A person's caret
  // and half-typed word live in the PROPERTY; the attribute the page renders
  // is only the starting position, and writing it over them is exactly the
  // theft this file exists to stop.
  const FIELDS = { INPUT: true, TEXTAREA: true, SELECT: true };

  // Whether this parent is a real DOM node or a stand-in.
  //
  // The test harnesses render the page against a bag of objects where
  // `innerHTML` is a stored string and there is no tree at all, which is the
  // right shape for asserting what the page DRAWS and the wrong shape for
  // patching. Rather than make every caller decide, morph() answers the
  // question itself and falls back to the assignment it replaced — so a stub
  // DOM, an old browser, or a detached node all still get their markup.
  function canMorph(parent) {
    return !!(
      parent &&
      parent.ownerDocument &&
      typeof parent.ownerDocument.createElement === 'function' &&
      typeof parent.insertBefore === 'function' &&
      parent.childNodes
    );
  }

  function sameKind(a, b) {
    return a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);
  }

  // Bring one surviving node up to date with what the new tree says it is.
  function patch(node, incoming) {
    if (node.nodeType === 3) {
      if (node.nodeValue !== incoming.nodeValue) node.nodeValue = incoming.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;

    // Hands entirely off whatever has focus. Not just its value: re-setting an
    // identical attribute is cheap but re-setting `class` on the focused
    // element is enough to interrupt a composition in some IMEs, and there is
    // nothing this page needs to say to a field urgently enough to be worth
    // that. It gets patched on the next poll after they click away.
    const focused = node.ownerDocument && node.ownerDocument.activeElement === node;
    if (focused) return;

    const want = incoming.attributes || [];
    for (let i = 0; i < want.length; i += 1) {
      const attr = want[i];
      if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
    }

    // Backwards: removeAttribute mutates the list being walked.
    const has = node.attributes || [];
    for (let i = has.length - 1; i >= 0; i -= 1) {
      const name = has[i].name;
      if (!incoming.hasAttribute(name)) node.removeAttribute(name);
    }

    // A field nobody is in still follows the page's state — that is how the
    // search box keeps agreeing with what it filtered. The property, not the
    // attribute: once a person has typed in a field the two stop tracking, and
    // the attribute is the one the browser then ignores.
    if (FIELDS[node.tagName]) {
      if ('value' in incoming && node.value !== incoming.value) node.value = incoming.value;
      if ('checked' in incoming && node.checked !== incoming.checked) node.checked = incoming.checked;
      // <textarea>'s children ARE its value. Recursing would fight the line above.
      if (node.tagName === 'TEXTAREA') return;
    }

    reconcile(node, incoming);
  }

  // Match the children of `from` to the children of `to`, in place.
  function reconcile(from, to) {
    const olds = [];
    for (let n = from.firstChild; n; n = n.nextSibling) olds.push(n);
    const news = [];
    for (let n = to.firstChild; n; n = n.nextSibling) news.push(n);

    const oldTally = {};
    const newTally = {};
    const { ops, removed } = plan(
      olds.map((n) => keyOf(n, oldTally)),
      news.map((n) => keyOf(n, newTally))
    );

    // Unclaimed nodes go first, so the placement pass below is comparing
    // against a list that only holds nodes somebody still wants.
    for (let i = 0; i < removed.length; i += 1) {
      const gone = olds[removed[i]];
      if (gone.parentNode === from) from.removeChild(gone);
    }

    const doc = from.ownerDocument;
    for (let want = 0; want < ops.length; want += 1) {
      const incoming = news[want];
      const reused = ops[want].from >= 0 ? olds[ops[want].from] : null;

      // An explicit key that changed tag — <div data-key="x"> becoming
      // <span data-key="x"> — is the one case a key can lie. Build fresh.
      const node = reused && sameKind(reused, incoming) ? reused : doc.importNode(incoming, true);
      if (node === reused) patch(node, incoming);

      const here = from.childNodes[want];
      if (here !== node) from.insertBefore(node, here || null);
    }

    while (from.childNodes.length > ops.length) from.removeChild(from.lastChild);
  }

  // The replacement for `el.innerHTML = html`.
  //
  // Returns whether it actually patched, which is what the tests read to tell
  // "morphed" apart from "fell back" — a silent fallback that never patches
  // would pass every assertion about markup and none about the caret.
  function morph(parent, html) {
    if (!canMorph(parent)) {
      parent.innerHTML = html;
      return false;
    }

    const holder = parent.ownerDocument.createElement('template');
    holder.innerHTML = html;
    reconcile(parent, holder.content);
    return true;
  }

  global.morph = morph;
  global.morphPlan = plan;
  global.morphKeyOf = keyOf;
  global.morphReconcile = reconcile;
})(typeof globalThis !== 'undefined' ? globalThis : this);
