// 3D layer for tool annotations, drawn between the video and the 2D annotation canvas.
//
//   kind "image": a PNG on a double-sided card. Turning it shows real perspective, and the
//                 back shows the mirror image, like holding a printed card.
//   kind "model": a .glb 3D model (e.g. a real wrench), lit, so turning it shows every side.
//
// Placement comes from the annotation's anchor box (0..1 of the video frame), orientation
// from ann.shape.rot3 = {x, y, z} in degrees. One unit in the scene equals one CSS pixel at
// depth 0, so a box of w x h pixels on screen is exactly w x h units here.
import * as THREE from "three";
import { GLTFLoader } from "../vendor/three/addons/loaders/GLTFLoader.js";

const FOV = 30;
const DEG = Math.PI / 180;

const texCache = new Map();
const modelCache = new Map();
const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();

function loadTexture(src) {
  if (!texCache.has(src)) {
    texCache.set(src, texLoader.loadAsync(src).then((t) => { t.colorSpace = THREE.SRGBColorSpace; return t; }));
  }
  return texCache.get(src);
}

/** Loads a .glb and normalises it: centred on the origin, fitting a 1x1x1 cube. */
function loadModel(src) {
  if (!modelCache.has(src)) {
    modelCache.set(src, gltfLoader.loadAsync(src).then((gltf) => {
      const root = gltf.scene;
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      root.position.sub(center);
      const holder = new THREE.Group();
      holder.add(root);
      holder.scale.setScalar(1 / Math.max(size.x, size.y, size.z, 1e-6));
      return holder;
    }));
  }
  return modelCache.get(src);
}

export function rot3Of(ann) {
  const r = ann.shape?.rot3;
  return r ? { x: r.x || 0, y: r.y || 0, z: r.z || 0 } : { x: 0, y: 0, z: ann.shape?.rot || 0 };
}

export class Scene3D {
  /** Throws if WebGL is unavailable; the caller then falls back to flat 2D drawing. */
  constructor(stage, before) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "overlay3d";
    stage.insertBefore(this.canvas, before);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 50000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4250, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(400, 700, 1000);
    this.scene.add(sun);
    this.objects = new Map(); // ann id -> {group, key}
    this.size = { w: 0, h: 0, dpr: 0 };
    this.wasEmpty = true;
  }

  _make(ann) {
    const group = new THREE.Group();
    const entry = { group, key: `${ann.kind}:${ann.shape.src}`, opacity: 1 };
    if (ann.kind === "model") {
      loadModel(ann.shape.src).then((proto) => {
        const m = proto.clone(true);
        m.traverse((o) => {
          if (o.isMesh) {
            o.material = o.material.clone();
            o.material.transparent = true;
          }
        });
        group.add(m);
      }).catch((e) => console.warn("3D model failed to load", ann.shape.src, e));
    } else {
      loadTexture(ann.shape.src).then((tex) => {
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, alphaTest: 0.02 });
        group.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat));
      }).catch((e) => console.warn("Tool image failed to load", ann.shape.src, e));
    }
    this.scene.add(group);
    this.objects.set(ann.id, entry);
    return entry;
  }

  _dispose(id) {
    const e = this.objects.get(id);
    if (!e) return;
    this.scene.remove(e.group);
    e.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    this.objects.delete(id);
  }

  /**
   * @param anns  annotations of kind image/model, each with _view (smoothed anchor)
   * @param r     video content rect inside the stage, CSS px
   * @param w,h   stage size, CSS px
   */
  render(anns, r, w, h) {
    if (!anns.length && this.wasEmpty) return;
    const dpr = window.devicePixelRatio || 1;
    if (w !== this.size.w || h !== this.size.h || dpr !== this.size.dpr) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.position.set(0, 0, h / 2 / Math.tan((FOV / 2) * DEG));
      this.camera.updateProjectionMatrix();
      this.size = { w, h, dpr };
    }

    const seen = new Set();
    for (const a of anns) {
      seen.add(a.id);
      let e = this.objects.get(a.id);
      if (e && e.key !== `${a.kind}:${a.shape.src}`) { this._dispose(a.id); e = null; }
      e ||= this._make(a);
      const v = a._view;
      const bw = v.w * r.w, bh = v.h * r.h;
      e.group.position.set(r.x + (v.x + v.w / 2) * r.w - w / 2, h / 2 - (r.y + (v.y + v.h / 2) * r.h), 0);
      if (a.kind === "model") e.group.scale.setScalar(Math.min(bw, bh));
      else e.group.scale.set(bw, bh, Math.min(bw, bh));
      const rot = rot3Of(a);
      // Screen y points down, scene y points up: flip x/z so drags feel natural.
      e.group.rotation.set(-rot.x * DEG, rot.y * DEG, -rot.z * DEG, "XYZ");
      const opacity = a.status === "lost" ? 0.4 : 1;
      if (opacity !== e.opacity) {
        e.group.traverse((o) => { if (o.isMesh) o.material.opacity = opacity; });
        e.opacity = opacity;
      }
    }
    for (const id of [...this.objects.keys()]) if (!seen.has(id)) this._dispose(id);

    // Keep tools on the picture, like the 2D marks.
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(r.x, h - r.y - r.h, r.w, r.h);
    this.renderer.render(this.scene, this.camera);
    this.wasEmpty = anns.length === 0;
  }
}

/** Small preview image (data URL) of a .glb for the tool tray. */
export async function modelThumbnail(src, size = 120) {
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  try {
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4250, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, 3, 4);
    scene.add(sun);
    const model = (await loadModel(src)).clone(true);
    model.rotation.set(0.35, -0.6, 0);
    scene.add(model);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    cam.position.set(0, 0, 2.6);
    renderer.render(scene, cam);
    return canvas.toDataURL("image/png");
  } finally {
    renderer.dispose();
    renderer.forceContextLoss?.();
  }
}
