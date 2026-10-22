// In-app dialogs and messages, used instead of the browser's alert/confirm/prompt boxes.

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function open(dialog, focusSel) {
  document.body.appendChild(dialog);
  dialog.showModal();
  dialog.querySelector(focusSel)?.focus();
  return dialog;
}

/** Ask a yes/no question. Resolves true when confirmed. */
export function confirmDialog({ title, body = "", confirmText = "OK", cancelText = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const d = el(`<dialog class="app-dialog" aria-labelledby="dlg-title">
      <h2 id="dlg-title">${esc(title)}</h2>
      ${body ? `<p>${esc(body)}</p>` : ""}
      <div class="dlg-actions">
        <button type="button" class="dlg-btn" data-v="0">${esc(cancelText)}</button>
        <button type="button" class="dlg-btn ${danger ? "dlg-danger" : "dlg-primary"}" data-v="1">${esc(confirmText)}</button>
      </div></dialog>`);
    let result = false;
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-v]");
      if (b) { result = b.dataset.v === "1"; d.close(); }
      else if (e.target === d) d.close();          // click on the backdrop = cancel
    });
    d.addEventListener("close", () => { d.remove(); resolve(result); });
    open(d, danger ? "[data-v='0']" : "[data-v='1']");
  });
}

/** Show a link the user can copy by hand (when clipboard access is not allowed). */
export function linkDialog({ title, body = "", link }) {
  const d = el(`<dialog class="app-dialog" aria-labelledby="dlg-title">
    <h2 id="dlg-title">${esc(title)}</h2>
    ${body ? `<p>${esc(body)}</p>` : ""}
    <input class="dlg-link" readonly value="${esc(link)}" aria-label="Link">
    <div class="dlg-actions">
      <button type="button" class="dlg-btn" data-close>Close</button>
      <button type="button" class="dlg-btn dlg-primary" data-copy>Copy</button>
    </div></dialog>`);
  const input = d.querySelector("input");
  d.querySelector("[data-close]").onclick = () => d.close();
  d.querySelector("[data-copy]").onclick = async (e) => {
    input.select();
    let ok = false;
    try { await navigator.clipboard.writeText(link); ok = true; } catch { ok = document.execCommand?.("copy"); }
    e.currentTarget.textContent = ok ? "Copied" : "Press Ctrl+C";
  };
  d.addEventListener("close", () => d.remove());
  open(d, "input").querySelector("input").select();
}

/** Short message at the bottom of the screen. kind: "info" | "error" | "success" */
let toastTimer;
export function toast(text, kind = "info") {
  let t = document.getElementById("toast");
  if (!t) { t = el(`<div class="toast" id="toast" role="status" aria-live="polite"></div>`); document.body.appendChild(t); }
  t.textContent = text;
  t.dataset.kind = kind;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), kind === "error" ? 6000 : 3500);
}
