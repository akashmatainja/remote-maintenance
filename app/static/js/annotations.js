// Annotation overlay drawn on a <canvas> above a <video>.
//
// Annotation shape (what travels over the WebSocket):
// {
//   id, kind: "ring" | "box" | "arrow" | "text" | "pen",
//   color, label, tracked: bool, source: <Jitsi display name of the camera it belongs to>,
//   anchor: {x, y, w, h},            // box around the object, 0..1 of the video frame
//   shape: {
//     offset: {dx, dy},              // arrow/text: label position relative to anchor centre
//     points: [[u, v], ...]          // pen: points relative to the anchor box (0..1 of anchor)
//   },
//   status: "ok" | "lost"
// }
// The server's tracker moves `anchor`. Everything else is drawn relative to it, so the whole
// mark follows the object: rings/boxes resize with it, arrow tips stay on it, labels keep
// their offset, and freehand strokes scale with it.

const FONT = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const SMOOTH = 0.35;       // how quickly drawn anchors catch up with tracker updates
const TARGET_FRAC = 0.12;  // size of the tracked box placed under an arrow tip / text pin

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const copyBox = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h });

function clampBox(b) {
  const w = clamp(b.w, 0.005, 1), h = clamp(b.h, 0.005, 1);
  return { x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h), w, h };
}

function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#1d2533" : "#ffffff";
}

export class AnnotationLayer {
  constructor({ stage, video, editable = false, onCommit, onSnapshotMoment, filter }) {
    this.stage = stage;
    this.video = video;
    this.editable = editable;
    this.onCommit = onCommit || (() => {});
    this.onSnapshotMoment = onSnapshotMoment || (() => {});
    this.filter = filter || (() => true);

    this.anns = new Map();
    this.mine = [];            // ids created here, for undo
    this.tool = "ring";
    this.color = "#f0a534";
    this.tracked = true;
    this.source = "";
    this.draft = null;         // in-progress drawing

    this.canvas = document.createElement("canvas");
    this.canvas.className = "overlay" + (editable ? " editable" : "");
    if (!editable) this.canvas.style.pointerEvents = "none";
    stage.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    new ResizeObserver(() => this._resize()).observe(this.canvas);
    this._resize();
    if (editable) this._bindPointer();
    const loop = () => { this._draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ public API
  setTool(tool) {
    this.tool = tool;
    this.canvas.classList.toggle("tool-move", tool === "move");
    this.canvas.classList.toggle("tool-erase", tool === "erase");
  }

  setAll(list) { this.anns.clear(); list.forEach((a) => this.upsert(a)); }

  upsert(ann) {
    const prev = this.anns.get(ann.id);
    const next = { ...ann, _view: prev?._view || copyBox(ann.anchor) };
    this.anns.set(ann.id, next);
  }

  remove(id) { this.anns.delete(id); this.mine = this.mine.filter((m) => m !== id); }
  clear() { this.anns.clear(); this.mine = []; }

  applyTrack(updates) {
    for (const u of updates) {
      const ann = this.anns.get(u.id);
      if (!ann || ann._dragging) continue;
      ann.status = u.status;
      if (u.anchor) ann.anchor = u.anchor;
    }
  }

  hasTracked() {
    for (const a of this.anns.values()) if (a.tracked) return true;
    return false;
  }

  undoLast() {
    const id = this.mine.pop();
    if (id && this.anns.has(id)) { this.anns.delete(id); return id; }
    return null;
  }

  static serialize(ann) {
    const { _view, _dragging, _labelRect, ...clean } = ann;
    return clean;
  }

  // ------------------------------------------------------------------ geometry
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.dpr = dpr;
  }

  /** Where the video picture actually sits inside the element (object-fit: contain). */
  contentRect() {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return { x: 0, y: 0, w: cw, h: ch, ready: false };
    const s = Math.min(cw / vw, ch / vh);
    const w = vw * s, h = vh * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, ready: true };
  }

  _toNorm(ev) {
    const b = this.canvas.getBoundingClientRect();
    const r = this.contentRect();
    return {
      x: clamp((ev.clientX - b.left - r.x) / r.w, 0, 1),
      y: clamp((ev.clientY - b.top - r.y) / r.h, 0, 1),
      cx: ev.clientX - b.left, cy: ev.clientY - b.top,
    };
  }

  _targetBox(pt) {
    const r = this.contentRect();
    const s = TARGET_FRAC * Math.min(r.w, r.h);
    const w = s / r.w, h = s / r.h;
    return clampBox({ x: pt.x - w / 2, y: pt.y - h / 2, w, h });
  }

  // ------------------------------------------------------------------ input
  _bindPointer() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || this.labelInput || !this.contentRect().ready) return;
      c.setPointerCapture(ev.pointerId);
      const p = this._toNorm(ev);
      const t = this.tool;

      if (t === "erase") {
        const hit = this._hit(p.cx, p.cy);
        if (hit) { this.anns.delete(hit.id); this.onCommit("remove", hit); }
        return;
      }
      if (t === "move") {
        const hit = this._hit(p.cx, p.cy);
        if (hit) {
          hit._dragging = true;
          this.draft = { kind: "move", ann: hit, start: p, from: copyBox(hit.anchor) };
        }
        return;
      }
      if (t === "ring" || t === "box" || t === "pen") this.onSnapshotMoment();
      this.draft = { kind: t, start: p, end: p, points: [p] };
    });

    c.addEventListener("pointermove", (ev) => {
      if (!this.draft) return;
      const p = this._toNorm(ev);
      const d = this.draft;
      if (d.kind === "move") {
        const a = d.ann;
        a.anchor = clampBox({ ...d.from, x: d.from.x + p.x - d.start.x, y: d.from.y + p.y - d.start.y });
        a._view = copyBox(a.anchor);
      } else {
        d.end = p;
        if (d.kind === "pen") d.points.push(p);
      }
    });

    const finish = (ev) => {
      const d = this.draft;
      this.draft = null;
      if (!d) return;
      const p = ev.type === "pointercancel" ? d.end : this._toNorm(ev);
      if (d.kind === "move") {
        d.ann._dragging = false;
        d.ann.status = "ok";
        this.onSnapshotMoment();  // re-attach the tracker to what is under it now
        this.onCommit("update", d.ann);
        return;
      }
      if (ev.type === "pointercancel") return;
      this._create(d, p);
    };
    c.addEventListener("pointerup", finish);
    c.addEventListener("pointercancel", finish);
  }

  _create(d, end) {
    const base = { id: uid(), kind: d.kind, color: this.color, tracked: this.tracked, source: this.source, shape: {}, status: "ok" };

    if (d.kind === "ring" || d.kind === "box") {
      const box = { x: Math.min(d.start.x, end.x), y: Math.min(d.start.y, end.y),
                    w: Math.abs(end.x - d.start.x), h: Math.abs(end.y - d.start.y) };
      if (box.w < 0.015 || box.h < 0.015) return;
      return this._add({ ...base, anchor: clampBox(box) });
    }

    if (d.kind === "pen") {
      const pts = d.points;
      if (pts.length < 3) return;
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      pts.forEach((p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
      const pad = 0.01;
      const anchor = clampBox({ x: x0 - pad, y: y0 - pad, w: Math.max(0.03, x1 - x0 + 2 * pad), h: Math.max(0.03, y1 - y0 + 2 * pad) });
      const points = pts.map((p) => [(p.x - anchor.x) / anchor.w, (p.y - anchor.y) / anchor.h]);
      return this._add({ ...base, anchor, shape: { points } });
    }

    if (d.kind === "arrow") {
      // Drag from where the label should sit to the thing it points at.
      const dist = Math.hypot(end.x - d.start.x, end.y - d.start.y);
      if (dist < 0.03) return;
      this.onSnapshotMoment();
      const anchor = this._targetBox(end);
      const cx = anchor.x + anchor.w / 2, cy = anchor.y + anchor.h / 2;
      const ann = { ...base, anchor, shape: { offset: { dx: d.start.x - cx, dy: d.start.y - cy } } };
      return this._askLabel(d.start, (label) => this._add({ ...ann, label: label || "" }));
    }

    if (d.kind === "text") {
      this.onSnapshotMoment();
      const anchor = this._targetBox(end);
      const ann = { ...base, anchor, shape: { offset: { dx: 0, dy: 0 } } };
      return this._askLabel(end, (label) => { if (label) this._add({ ...ann, label }); });
    }
  }

  _add(ann) {
    this.upsert(ann);
    this.mine.push(ann.id);
    this.onCommit("add", this.anns.get(ann.id));
  }

  _askLabel(pt, done) {
    const r = this.contentRect();
    const input = document.createElement("input");
    input.className = "label-input";
    input.placeholder = "Label, e.g. Step 3: loosen coupling bolt";
    input.maxLength = 80;
    input.style.left = `${clamp(r.x + pt.x * r.w - 110, 4, this.canvas.clientWidth - 230)}px`;
    input.style.top = `${clamp(r.y + pt.y * r.h - 18, 4, this.canvas.clientHeight - 40)}px`;
    this.stage.appendChild(input);
    this.labelInput = input;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      this.labelInput = null;
      done(value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") settle(input.value.trim());
      if (e.key === "Escape") settle(null);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => settle(input.value.trim() || null));
    setTimeout(() => input.focus(), 0);
  }

  _hit(cx, cy) {
    const r = this.contentRect();
    const list = [...this.anns.values()].filter(this.filter).reverse();
    for (const a of list) {
      const lr = a._labelRect;
      if (lr && cx >= lr.x && cx <= lr.x + lr.w && cy >= lr.y && cy <= lr.y + lr.h) return a;
      const v = a._view, pad = 10;
      const x = r.x + v.x * r.w, y = r.y + v.y * r.h;
      if (cx >= x - pad && cx <= x + v.w * r.w + pad && cy >= y - pad && cy <= y + v.h * r.h + pad) return a;
    }
    return null;
  }

  // ------------------------------------------------------------------ drawing
  _draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    const r = this.contentRect();
    if (!r.ready) return;

    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip(); // keep marks on the picture
    for (const a of this.anns.values()) {
      if (!this.filter(a)) continue;
      if (!a._dragging) this._ease(a);
      this._drawAnn(a, r);
    }
    ctx.restore();
    if (this.draft && this.draft.kind !== "move") this._drawDraft(this.draft, r);
  }

  _ease(a) {
    const v = a._view, t = a.anchor;
    if (Math.abs(v.x - t.x) > 0.25 || Math.abs(v.y - t.y) > 0.25) { a._view = copyBox(t); return; }
    v.x += (t.x - v.x) * SMOOTH; v.y += (t.y - v.y) * SMOOTH;
    v.w += (t.w - v.w) * SMOOTH; v.h += (t.h - v.h) * SMOOTH;
  }

  _stroke(pathFn, color, width, dash = []) {
    const ctx = this.ctx;
    ctx.setLineDash(dash);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = width + 3;
    pathFn(); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width;
    pathFn(); ctx.stroke();
    ctx.setLineDash([]);
  }

  _label(text, cx, cy, color, r) {
    const ctx = this.ctx;
    const fs = clamp(r.w / 55, 12, 20);
    ctx.font = `600 ${fs}px ${FONT}`;
    const padX = fs * 0.75, padY = fs * 0.45;
    const w = ctx.measureText(text).width + padX * 2, h = fs + padY * 2;
    const x = clamp(cx - w / 2, r.x + 2, r.x + r.w - w - 2), y = clamp(cy - h / 2, r.y + 2, r.y + r.h - h - 2);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(x + 2, y + 2, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = textColorFor(color);
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + padX, y + h / 2 + 1);
    return { x, y, w, h };
  }

  _drawAnn(a, r) {
    const ctx = this.ctx, v = a._view;
    const x = r.x + v.x * r.w, y = r.y + v.y * r.h, w = v.w * r.w, h = v.h * r.h;
    const cx = x + w / 2, cy = y + h / 2;
    const lw = clamp(r.w / 320, 2, 4);
    ctx.save();
    ctx.globalAlpha = a.status === "lost" ? 0.4 : 1;
    a._labelRect = null;

    if (a.kind === "ring") {
      this._stroke(() => { ctx.beginPath(); ctx.ellipse(cx, cy, w * 0.58, h * 0.58, 0, 0, Math.PI * 2); }, a.color, lw, [lw * 4, lw * 3]);
    } else if (a.kind === "box") {
      this._stroke(() => { ctx.beginPath(); ctx.rect(x, y, w, h); }, a.color, lw, [lw * 4, lw * 3]);
    } else if (a.kind === "pen") {
      const pts = a.shape.points || [];
      this._stroke(() => {
        ctx.beginPath();
        pts.forEach(([u, vv], i) => (i ? ctx.lineTo(x + u * w, y + vv * h) : ctx.moveTo(x + u * w, y + vv * h)));
      }, a.color, lw);
    } else if (a.kind === "arrow" || a.kind === "text") {
      const off = a.shape.offset || { dx: 0, dy: 0 };
      const lx = cx + off.dx * r.w, ly = cy + off.dy * r.h;
      if (a.kind === "arrow") {
        const box = a.label ? this._measureLabel(a.label, r) : { w: 0, h: 0 };
        const dx = cx - lx, dy = cy - ly;
        const t = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity);
        if (t < 1) {
          const sx = lx + dx * t, sy = ly + dy * t;
          const ang = Math.atan2(cy - sy, cx - sx), head = lw * 5;
          this._stroke(() => { ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx, cy); }, a.color, lw);
          ctx.fillStyle = a.color;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx - head * Math.cos(ang - 0.45), cy - head * Math.sin(ang - 0.45));
          ctx.lineTo(cx - head * Math.cos(ang + 0.45), cy - head * Math.sin(ang + 0.45));
          ctx.closePath(); ctx.fill();
        }
      }
      if (a.label) a._labelRect = this._label(a.label, lx, ly, a.color, r);
    }

    if (a.status === "lost" && this.editable) {
      ctx.globalAlpha = 1;
      this._label("Lost: drag to re-attach", cx, y + h + 16, "#d9534f", r);
    }
    ctx.restore();
  }

  _measureLabel(text, r) {
    const fs = clamp(r.w / 55, 12, 20);
    this.ctx.font = `600 ${fs}px ${FONT}`;
    return { w: this.ctx.measureText(text).width + fs * 1.5, h: fs * 1.9 };
  }

  _drawDraft(d, r) {
    const ctx = this.ctx, lw = clamp(r.w / 320, 2, 4);
    const P = (p) => [r.x + p.x * r.w, r.y + p.y * r.h];
    const [sx, sy] = P(d.start), [ex, ey] = P(d.end);
    ctx.save();
    ctx.globalAlpha = 0.85;
    if (d.kind === "ring") {
      this._stroke(() => { ctx.beginPath(); ctx.ellipse((sx + ex) / 2, (sy + ey) / 2, Math.abs(ex - sx) * 0.58, Math.abs(ey - sy) * 0.58, 0, 0, Math.PI * 2); }, this.color, lw, [lw * 4, lw * 3]);
    } else if (d.kind === "box") {
      this._stroke(() => { ctx.beginPath(); ctx.rect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy)); }, this.color, lw, [lw * 4, lw * 3]);
    } else if (d.kind === "pen") {
      this._stroke(() => { ctx.beginPath(); d.points.forEach((p, i) => { const [px, py] = P(p); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); }, this.color, lw);
    } else if (d.kind === "arrow") {
      this._stroke(() => { ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); }, this.color, lw);
    }
    ctx.restore();
  }
}
