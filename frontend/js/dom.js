// Small DOM helpers. Student-controlled text (file names, output, error messages) only ever
// goes through text nodes here, never innerHTML.

/**
 * el("td", { class: "num", dataset: { col: "q1" } }, "2") -> <td class="num" data-col="q1">2</td>
 * Children may be strings, numbers, nodes, or null/false (skipped).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  const kids = children.flat().filter((child) => child !== null && child !== undefined && child !== false);
  node.append(...kids.map((child) => (child instanceof Node ? child : String(child))));
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function show(node, visible = true) {
  node.hidden = !visible;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPoints(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

export function plural(count, word, pluralWord = `${word}s`) {
  return `${count} ${Number(count) === 1 ? word : pluralWord}`;
}
