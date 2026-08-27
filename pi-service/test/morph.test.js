import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The DOM patcher the two pages share, tested without a browser.
//
// dashboard/html/dash/morph.js replaces `el.innerHTML = html` so that a poll
// landing while somebody is typing stops taking their caret. What it can be
// asked here is everything except the browser's HTML parser: the matching, the
// key rules, the patching, the placement, and the promise that a focused field
// is not touched. The one line this file cannot reach — `template.innerHTML =
// html`, where a real parser turns markup into nodes — is exercised against
// real Chrome instead; see docs/adr/0002.
//
// The fake DOM below is deliberately small and deliberately faithful. It
// implements the exact surface morph.js uses and nothing else, and it keeps
// the two rules that make this class of bug possible in the first place:
// removing a node from a tree updates the tree, and a form field's `value`
// PROPERTY stops tracking its attribute the moment somebody types into it.
//
// Note there is no HTML parser here and no need for one — every "new tree" in
// these tests is built by hand, which is also clearer about what is being
// compared than a string would be.

const MORPH = fileURLToPath(new URL('../../dashboard/html/dash/morph.js', import.meta.url));

async function load() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(await readFile(MORPH, 'utf8'), sandbox, { filename: 'morph.js' });
  return sandbox;
}

// plan() builds its answer inside the sandbox, so its arrays carry that
// realm's Array.prototype — and deepStrictEqual compares prototypes, so two
// identical lists from either side of the boundary are not equal. Copying into
// this realm before asserting is the whole of the fix, and it is worth a name
// rather than a spread at six call sites that would each look like a typo.
const here = (list) => [...list];

// ---------------------------------------------------------------------------
// A DOM, in about the space its absence would take to explain
// ---------------------------------------------------------------------------

const FIELD = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function makeDoc() {
  const doc = {
    activeElement: null,
    createElement: (tag) => el(tag, doc),
    importNode: (node) => clone(node, doc),
  };
  return doc;
}

function el(tag, doc, attrs) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    parentNode: null,
    attributes: [],
    kids: [],

    get childNodes() { return this.kids; },
    get firstChild() { return this.kids[0] || null; },
    get lastChild() { return this.kids[this.kids.length - 1] || null; },
    get nextSibling() {
      if (!this.parentNode) return null;
      return this.parentNode.kids[this.parentNode.kids.indexOf(this) + 1] || null;
    },

    getAttribute(name) {
      const found = this.attributes.find((a) => a.name === name);
      return found ? found.value : null;
    },
    hasAttribute(name) { return this.attributes.some((a) => a.name === name); },
    setAttribute(name, value) {
      const found = this.attributes.find((a) => a.name === name);
      if (found) found.value = String(value);
      else this.attributes.push({ name, value: String(value) });
    },
    removeAttribute(name) {
      const at = this.attributes.findIndex((a) => a.name === name);
      if (at >= 0) this.attributes.splice(at, 1);
    },

    insertBefore(child, ref) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const at = ref ? this.kids.indexOf(ref) : this.kids.length;
      this.kids.splice(at < 0 ? this.kids.length : at, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const at = this.kids.indexOf(child);
      if (at >= 0) this.kids.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    appendChild(child) { return this.insertBefore(child, null); },
  };

  for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);

  // A field's value property mirrors its attribute until somebody types, and
  // then it does not. Getting this wrong in the fake would hide the only bug
  // that matters here.
  if (FIELD.has(node.tagName)) {
    let typed = null;
    Object.defineProperty(node, 'value', {
      enumerable: true,
      get() { return typed === null ? (this.getAttribute('value') ?? '') : typed; },
      set(v) { typed = String(v); },
    });
    let ticked = null;
    Object.defineProperty(node, 'checked', {
      enumerable: true,
      get() { return ticked === null ? this.hasAttribute('checked') : ticked; },
      set(v) { ticked = !!v; },
    });
  }

  return node;
}

function text(value, doc) {
  return { nodeType: 3, nodeValue: String(value), ownerDocument: doc, parentNode: null,
    get nextSibling() {
      if (!this.parentNode) return null;
      return this.parentNode.kids[this.parentNode.kids.indexOf(this) + 1] || null;
    } };
}

function clone(node, doc) {
  if (node.nodeType === 3) return text(node.nodeValue, doc);
  const copy = el(node.tagName, doc);
  node.attributes.forEach((a) => copy.setAttribute(a.name, a.value));
  node.kids.forEach((k) => copy.appendChild(clone(k, doc)));
  return copy;
}

// A tiny builder so the trees in these tests read as trees.
function tree(doc, tag, attrs, kids) {
  const node = el(tag, doc, attrs);
  (kids || []).forEach((k) => node.appendChild(typeof k === 'string' ? text(k, doc) : k));
  return node;
}

// ---------------------------------------------------------------------------
// plan — which old node each new node is
// ---------------------------------------------------------------------------

test('an unchanged list reuses every node and removes none', async () => {
  const { morphPlan } = await load();
  const { ops, removed } = morphPlan(['a', 'b', 'c'], ['a', 'b', 'c']);

  assert.deepEqual(here(ops.map((o) => o.from)), [0, 1, 2]);
  assert.deepEqual(here(removed), []);
});

test('an insertion builds one node and keeps the rest', async () => {
  const { morphPlan } = await load();
  const { ops, removed } = morphPlan(['a', 'c'], ['a', 'b', 'c']);

  assert.deepEqual(here(ops.map((o) => o.from)), [0, -1, 1]);
  assert.deepEqual(here(removed), []);
});

test('a removal names the old node nobody claimed', async () => {
  const { morphPlan } = await load();
  const { ops, removed } = morphPlan(['a', 'b', 'c'], ['a', 'c']);

  assert.deepEqual(here(ops.map((o) => o.from)), [0, 2]);
  assert.deepEqual(here(removed), [1]);
});

test('a reorder moves nodes rather than rebuilding them', async () => {
  const { morphPlan } = await load();
  const { ops, removed } = morphPlan(['a', 'b', 'c'], ['c', 'a', 'b']);

  assert.deepEqual(here(ops.map((o) => o.from)), [2, 0, 1], 'a reorder rebuilt something');
  assert.deepEqual(here(removed), []);
});

// Two rows keying the same is a page bug, but collapsing them into one node is
// a worse answer than drawing both.
test('duplicate keys are handed out left to right, not all to the first', async () => {
  const { morphPlan } = await load();
  const { ops, removed } = morphPlan(['x', 'x', 'y'], ['x', 'x', 'x']);

  assert.deepEqual(here(ops.map((o) => o.from)), [0, 1, -1]);
  assert.deepEqual(here(removed), [2]);
});

test('an empty tree either way is not a special case', async () => {
  const { morphPlan } = await load();

  const nothing = morphPlan([], []);
  assert.deepEqual(here(nothing.ops), []);
  assert.deepEqual(here(nothing.removed), []);

  assert.deepEqual(here(morphPlan([], ['a']).ops.map((o) => o.from)), [-1]);

  const emptied = morphPlan(['a'], []);
  assert.deepEqual(here(emptied.ops), []);
  assert.deepEqual(here(emptied.removed), [0]);
});

// ---------------------------------------------------------------------------
// keyOf — what makes two nodes the same node
// ---------------------------------------------------------------------------

test('data-key wins, then id, then position within the tag', async () => {
  const { morphKeyOf } = await load();
  const doc = makeDoc();

  assert.equal(morphKeyOf(el('div', doc, { 'data-key': 'row-7', id: 'ignored' }), {}), '@row-7');
  assert.equal(morphKeyOf(el('div', doc, { id: 'top' }), {}), '@top');

  const tally = {};
  assert.equal(morphKeyOf(el('div', doc), tally), 'DIV/1');
  assert.equal(morphKeyOf(el('div', doc), tally), 'DIV/2');
});

// The point of counting within a tag rather than across all children: a
// heading appearing above a list must not shunt every row onto its neighbour's
// key and repaint the lot.
test('a node inserted above a list does not shift the list off its keys', async () => {
  const { morphKeyOf } = await load();
  const doc = makeDoc();

  const before = {};
  const was = [el('div', doc), el('div', doc)].map((n) => morphKeyOf(n, before));

  const after = {};
  const now = [el('p', doc), el('div', doc), el('div', doc)].map((n) => morphKeyOf(n, after));

  assert.deepEqual(now.slice(1), was, 'the rows moved to different keys');
});

test('text nodes key by their own position, apart from elements', async () => {
  const { morphKeyOf } = await load();
  const doc = makeDoc();
  const tally = {};

  assert.equal(morphKeyOf(text('one', doc), tally), '#text/1');
  assert.equal(morphKeyOf(el('br', doc), tally), 'BR/1');
  assert.equal(morphKeyOf(text('two', doc), tally), '#text/2');
});

// ---------------------------------------------------------------------------
// reconcile — the patch itself
// ---------------------------------------------------------------------------

test('a node that survives a redraw is the same object afterwards', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const parent = tree(doc, 'div', {}, [tree(doc, 'p', { 'data-key': 'a' }, ['first'])]);
  const kept = parent.kids[0];

  morphReconcile(parent, tree(doc, 'div', {}, [tree(doc, 'p', { 'data-key': 'a' }, ['changed'])]));

  assert.equal(parent.kids[0], kept, 'the node was replaced rather than patched');
  assert.equal(kept.kids[0].nodeValue, 'changed', 'the text did not follow');
});

test('attributes are added, changed and removed to match', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const parent = tree(doc, 'div', {}, [el('span', doc, { class: 'old', title: 'gone' })]);
  morphReconcile(parent, tree(doc, 'div', {}, [el('span', doc, { class: 'new', role: 'note' })]));

  const span = parent.kids[0];
  assert.equal(span.getAttribute('class'), 'new');
  assert.equal(span.getAttribute('role'), 'note');
  assert.equal(span.getAttribute('title'), null, 'a dropped attribute stayed behind');
});

test('a row inserted in the middle leaves its neighbours alone', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const row = (k) => tree(doc, 'div', { 'data-key': k }, [k]);
  const parent = tree(doc, 'div', {}, [row('a'), row('c')]);
  const [first, last] = parent.kids;

  morphReconcile(parent, tree(doc, 'div', {}, [row('a'), row('b'), row('c')]));

  assert.equal(parent.kids.length, 3);
  assert.equal(parent.kids[0], first);
  assert.equal(parent.kids[2], last, 'the row after the insertion was rebuilt');
  assert.equal(parent.kids[1].getAttribute('data-key'), 'b');
});

test('a reordered list moves the same nodes into their new places', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const row = (k) => tree(doc, 'div', { 'data-key': k }, [k]);
  const parent = tree(doc, 'div', {}, [row('a'), row('b'), row('c')]);
  const was = [...parent.kids];

  morphReconcile(parent, tree(doc, 'div', {}, [row('c'), row('a'), row('b')]));

  assert.deepEqual(parent.kids, [was[2], was[0], was[1]], 'a sort rebuilt the rows');
});

test('rows the server stopped sending are taken out', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const row = (k) => tree(doc, 'div', { 'data-key': k }, [k]);
  const parent = tree(doc, 'div', {}, [row('a'), row('b'), row('c')]);

  morphReconcile(parent, tree(doc, 'div', {}, [row('b')]));

  assert.equal(parent.kids.length, 1);
  assert.equal(parent.kids[0].getAttribute('data-key'), 'b');
});

// A key is a claim that two nodes are the same node, and a changed tag is that
// claim being wrong. Patching across it would leave a <div> answering to a
// <span>'s markup.
test('the same key on a different tag builds a new node', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const parent = tree(doc, 'div', {}, [el('div', doc, { 'data-key': 'x' })]);
  const was = parent.kids[0];

  morphReconcile(parent, tree(doc, 'div', {}, [el('span', doc, { 'data-key': 'x' })]));

  assert.notEqual(parent.kids[0], was);
  assert.equal(parent.kids[0].tagName, 'SPAN');
});

test('the patch reaches all the way down, not just one level', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const parent = tree(doc, 'div', {}, [
    tree(doc, 'section', { 'data-key': 's' }, [tree(doc, 'b', { 'data-key': 'deep' }, ['was'])]),
  ]);
  const deep = parent.kids[0].kids[0];

  morphReconcile(parent, tree(doc, 'div', {}, [
    tree(doc, 'section', { 'data-key': 's' }, [tree(doc, 'b', { 'data-key': 'deep' }, ['now'])]),
  ]));

  assert.equal(parent.kids[0].kids[0], deep, 'a nested node was rebuilt');
  assert.equal(deep.kids[0].nodeValue, 'now');
});

// ---------------------------------------------------------------------------
// The whole point
// ---------------------------------------------------------------------------

test('a field somebody is typing in is not touched at all', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const parent = tree(doc, 'div', {}, [el('input', doc, { 'data-key': 'q', value: '', class: 'in' })]);
  const box = parent.kids[0];

  box.value = 'half a wo';       // typed, so the property has left the attribute behind
  doc.activeElement = box;

  morphReconcile(parent, tree(doc, 'div', {}, [
    el('input', doc, { 'data-key': 'q', value: '', class: 'in changed' }),
  ]));

  assert.equal(parent.kids[0], box, 'the field was replaced under the caret');
  assert.equal(box.value, 'half a wo', 'the poll took what they had typed');
  assert.equal(box.getAttribute('class'), 'in', 'the focused field was written to anyway');
});

test('a field nobody is in still follows the page', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const parent = tree(doc, 'div', {}, [el('input', doc, { 'data-key': 'q', value: 'old' })]);
  const box = parent.kids[0];
  box.value = 'stale';

  morphReconcile(parent, tree(doc, 'div', {}, [el('input', doc, { 'data-key': 'q', value: 'fresh' })]));

  assert.equal(parent.kids[0], box);
  assert.equal(box.value, 'fresh', 'an unfocused field stopped tracking the page');
});

test('a checkbox nobody is in follows the page too', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const parent = tree(doc, 'div', {}, [el('input', doc, { 'data-key': 'c', type: 'checkbox' })]);
  const box = parent.kids[0];
  assert.equal(box.checked, false);

  morphReconcile(parent, tree(doc, 'div', {}, [
    el('input', doc, { 'data-key': 'c', type: 'checkbox', checked: 'checked' }),
  ]));

  assert.equal(box.checked, true);
});

// A textarea's children are its value. Recursing into it would fight the
// property assignment and put the old text back.
test('a textarea is set by value, not by rebuilding its children', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const was = tree(doc, 'textarea', { 'data-key': 't' }, ['old']);
  const parent = tree(doc, 'div', {}, [was]);

  morphReconcile(parent, tree(doc, 'div', {}, [
    el('textarea', doc, { 'data-key': 't', value: 'new' }),
  ]));

  assert.equal(parent.kids[0], was);
  assert.equal(was.value, 'new');
  assert.equal(was.kids.length, 1, 'the textarea was recursed into as well');
});

test('sibling fields do not shield each other — only the focused one is spared', async () => {
  const { morphReconcile } = await load();
  const doc = makeDoc();

  const parent = tree(doc, 'div', {}, [
    el('input', doc, { 'data-key': 'a', value: 'one' }),
    el('input', doc, { 'data-key': 'b', value: 'two' }),
  ]);
  const [a, b] = parent.kids;
  a.value = 'typing here';
  doc.activeElement = a;

  morphReconcile(parent, tree(doc, 'div', {}, [
    el('input', doc, { 'data-key': 'a', value: 'server' }),
    el('input', doc, { 'data-key': 'b', value: 'server too' }),
  ]));

  assert.equal(a.value, 'typing here');
  assert.equal(b.value, 'server too', 'the other field was frozen along with the focused one');
});

// ---------------------------------------------------------------------------
// morph — the entry point, and the way out of it
// ---------------------------------------------------------------------------

// The render harnesses hand the page a bag of objects where innerHTML is a
// stored string. Patching is impossible there and refusing would be useless,
// so morph falls back to the assignment it replaced and says that it did.
test('a stub DOM gets the markup it asked for, and is told it was not patched', async () => {
  const { morph } = await load();

  const stub = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };

  assert.equal(morph(stub, '<p>hello</p>'), false);
  assert.equal(stub._html, '<p>hello</p>');
});

test('a real node is patched and says so', async () => {
  const { morph } = await load();
  const doc = makeDoc();

  // The one thing the fake cannot do is parse, so stand in for <template>.
  doc.createElement = (tag) => {
    const node = el(tag, doc);
    if (tag === 'template') {
      node.content = el('#fragment', doc);
      Object.defineProperty(node, 'innerHTML', {
        set() { node.content.appendChild(tree(doc, 'p', { 'data-key': 'a' }, ['parsed'])); },
      });
    }
    return node;
  };

  const parent = tree(doc, 'div', {}, [tree(doc, 'p', { 'data-key': 'a' }, ['before'])]);
  const kept = parent.kids[0];

  assert.equal(morph(parent, '<p data-key="a">parsed</p>'), true);
  assert.equal(parent.kids[0], kept);
  assert.equal(kept.kids[0].nodeValue, 'parsed');
});
