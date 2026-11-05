export function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

export function showError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

// The clipboard API only exists on https and localhost, so elsewhere the text
// gets selected and the person copies it by hand.
export async function copyToClipboard(button, text, textElement) {
  const originalLabel = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Скопировано";
  } catch {
    window.getSelection().selectAllChildren(textElement);
    button.textContent = "Выделено, скопируйте";
  }
  setTimeout(() => {
    button.textContent = originalLabel;
  }, 2000);
}

export function newClientId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
