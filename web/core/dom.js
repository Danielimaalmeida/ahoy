/**
 * The element primitive.
 *
 * Everything drawn here comes out of state.json, which agents write. Text is
 * therefore always set through textContent and attributes through
 * setAttribute - there is no innerHTML anywhere in this app, so a plan or a
 * finding containing markup is displayed, never executed.
 */

/**
 * Build an element.
 *
 *   el('div', { class: 'panel' }, el('h2', { text: 'Title' }), 'body text')
 *
 * Props: `text` sets textContent, `class` takes a string or an array,
 * `dataset` sets data-*, `on<Event>` binds a listener, and anything else
 * becomes an attribute. There is deliberately no `html`.
 *
 * Null, undefined and false children are dropped, so `condition && el(...)`
 * and `list.length ? el(...) : null` both work inline.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [name, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (name === 'text') {
      node.textContent = String(value);
    } else if (name === 'class') {
      node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    } else if (name === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (name.startsWith('on') && typeof value === 'function') {
      node.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(name, '');
    } else {
      node.setAttribute(name, String(value));
    }
  }

  return append(node, children);
}

/**
 * Append children, flattening arrays and skipping the empty ones.
 *
 * The flattening is what lets a view return several sibling nodes as an array
 * instead of wrapping them in a div that exists only to hold them.
 */
function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Empty a node without touching innerHTML. */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replace a node's children in one step. */
export function render(node, ...children) {
  return append(clear(node), children);
}
