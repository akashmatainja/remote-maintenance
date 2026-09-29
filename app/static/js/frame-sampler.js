// Streams small JPEG snapshots of the remote video to the server tracker.
// Runs only in the one expert browser the server elects as "tracking source", and only
// while at least one annotation follows an object. Waits for the server's frame_ack
// before sending the next frame, so a slow server never builds up a backlog.

const FRAME_REGULAR = 0x01;
const FRAME_INIT = 0x02;

export class FrameSampler {
  constructor(video, socket, { width = 480, fps = 10, quality = 0.7 } = {}) {
    this.video = video;
    this.socket = socket;
    this.width = width;
    this.interval = 1000 / fps;
    this.quality = quality;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    this.isSource = false;
    this.wanted = () => false;
    this.inFlight = false;
    this.sentAt = 0;
    socket.on("frame_ack", () => { this.inFlight = false; });
    socket.on("tracking_source", (m) => { this.isSource = m.value; });
    socket.on("state", (m) => { this.isSource = m.tracking_source; });
    this._loop();
  }

  async _grab() {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return null;
    const h = Math.round((v.videoHeight / v.videoWidth) * this.width);
    if (this.canvas.width !== this.width || this.canvas.height !== h) {
      this.canvas.width = this.width; this.canvas.height = h;
    }
    this.ctx.drawImage(v, 0, 0, this.width, h);
    const blob = await new Promise((res) => this.canvas.toBlob(res, "image/jpeg", this.quality));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  _pack(kind, jpeg) {
    const out = new Uint8Array(jpeg.length + 1);
    out[0] = kind;
    out.set(jpeg, 1);
    return out.buffer;
  }

  /** Take a snapshot now (the moment the expert starts drawing). */
  snapshot() { return this._grab(); }

  /** Send a snapshot taken earlier so the tracker starts on what the expert actually saw. */
  sendInit(jpeg) {
    if (jpeg && this.isSource) this.socket.sendBinary(this._pack(FRAME_INIT, jpeg));
  }

  async _loop() {
    const now = performance.now();
    if (this.inFlight && now - this.sentAt > 1500) this.inFlight = false; // lost ack
    if (this.isSource && this.wanted() && !this.inFlight && this.socket.ready && document.visibilityState === "visible") {
      const jpeg = await this._grab();
      if (jpeg) {
        this.inFlight = true;
        this.sentAt = performance.now();
        this.socket.sendBinary(this._pack(FRAME_REGULAR, jpeg));
      }
    }
    setTimeout(() => this._loop(), this.interval);
  }
}
