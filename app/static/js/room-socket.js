// Room WebSocket: annotations, tracking frames, PTZ, presence. Reconnects automatically.
export class RoomSocket {
  constructor({ room, role, name }) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = new URLSearchParams({ role, name });
    this.url = `${proto}://${location.host}/ws/${encodeURIComponent(room)}?${q}`;
    this.handlers = {};
    this.rtt = null;
    this.closedByUser = false;
    this.retry = 0;
    this._connect();
    this._pinger = setInterval(() => this.send({ type: "ping", t: performance.now() }), 3000);
  }

  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  _emit(type, msg) { (this.handlers[type] || []).forEach((fn) => fn(msg)); }

  _connect() {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => { this.retry = 0; this._emit("open"); };
    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data);
      if (msg.type === "pong") { this.rtt = performance.now() - msg.t; }
      this._emit(msg.type, msg);
    };
    this.ws.onclose = () => {
      this._emit("close");
      if (this.closedByUser) return;
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this._connect(), delay);
    };
  }

  get ready() { return this.ws && this.ws.readyState === WebSocket.OPEN; }
  send(obj) { if (this.ready) this.ws.send(JSON.stringify(obj)); }
  sendBinary(buf) { if (this.ready) this.ws.send(buf); }
  close() { this.closedByUser = true; clearInterval(this._pinger); this.ws?.close(); }
}
