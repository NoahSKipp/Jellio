// Shared DOM element builder, previously copy pasted byte for byte at the
// top of every screen and component file in this bundle.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
