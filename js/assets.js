// Asset loading: CC0 photo-scanned PBR textures and 3D models from Poly Haven, rigged avatars from the
// three.js repo. Everything loads lazily and is cached; materials exist immediately with a flat colour
// and gain their maps when the downloads land, so the world never waits on the network.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const PH_TEX = (id, res, kind) => `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${res}/${id}/${id}_${kind}_${res}.jpg`;
const PH_MODEL = (id) => `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/${id}/${id}_1k.gltf`;
const THREE_MODEL = (name) => `https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/models/gltf/${name}`;

let texRes = '1k';
let maxAniso = 8;
export function setTextureQuality(res, aniso) { texRes = res; maxAniso = aniso; }

const texCache = new Map();
const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');

export function loadTexture(url, srgb) {
  if (texCache.has(url)) return texCache.get(url);
  const p = new Promise((res) => {
    texLoader.load(url, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = maxAniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      res(t);
    }, undefined, () => res(null));
  });
  texCache.set(url, p);
  return p;
}
// a few Poly Haven sets name their colour map "diffuse" instead of "diff": known ones go straight there,
// anything else falls back after a miss
const DIFFUSE_NAMED = new Set(['forest_leaves_02']);
export const phTexture = (id, kind, srgb, res = texRes) => {
  const k = kind === 'diff' && DIFFUSE_NAMED.has(id) ? 'diffuse' : kind;
  return loadTexture(PH_TEX(id, res, k), srgb).then((t) => (t || k !== 'diff' ? t : loadTexture(PH_TEX(id, res, 'diffuse'), srgb)));
};

// ------------------------------------------------------------------ building materials
// tile = metres covered by one texture repeat; col = colour shown until the photo texture arrives
export const MATERIALS = {
  plaster:    { ph: 'painted_plaster_wall',  tile: 3.5, col: '#d9d4c8', label: 'White plaster' },
  plaster2:   { ph: 'beige_wall_001',        tile: 3,   col: '#cdbfa6', label: 'Beige render' },
  greyrender: { ph: 'grey_plaster',          tile: 3.5, col: '#9b9a96', label: 'Grey render' },
  brick:      { ph: 'red_brick_03',          tile: 2.2, col: '#8a4a38', label: 'Red brick' },
  plasterbrick:{ ph: 'rough_plasterbrick_05', tile: 3,  col: '#b9ad9c', label: 'Old brick' },
  sandstone:  { ph: 'white_sandstone_bricks', tile: 3,  col: '#cfc2a8', label: 'Sandstone' },
  stone:      { ph: 'castle_wall_slates',    tile: 3,   col: '#7b766c', label: 'Slate stone' },
  stonewall:  { ph: 'stone_wall',            tile: 3,   col: '#857d70', label: 'Field stone' },
  wood:       { ph: 'wood_planks',           tile: 2.5, col: '#8b6a48', label: 'Wood planks' },
  wooddark:   { ph: 'dark_wooden_planks',    tile: 2.5, col: '#4d3a2a', label: 'Dark planks' },
  weathered:  { ph: 'weathered_planks',      tile: 2.5, col: '#8e8578', label: 'Weathered wood' },
  bluewood:   { ph: 'blue_painted_planks',   tile: 2.5, col: '#5d7a92', label: 'Painted planks' },
  floorwood:  { ph: 'wood_floor',            tile: 2.5, col: '#9a7350', label: 'Wood floor' },
  parquet:    { ph: 'herringbone_parquet',   tile: 2,   col: '#a07a52', label: 'Parquet' },
  laminate:   { ph: 'laminate_floor_02',     tile: 2.5, col: '#b49470', label: 'Laminate' },
  concrete:   { ph: 'concrete_wall_008',     tile: 4,   col: '#a3a19c', label: 'Concrete' },
  concfloor:  { ph: 'concrete_floor_02',     tile: 4,   col: '#8f8d88', label: 'Polished concrete' },
  marble:     { ph: 'marble_01',             tile: 3,   col: '#e4e1dc', label: 'Marble' },
  marbletile: { ph: 'marble_tiles',          tile: 2,   col: '#dcd8d0', label: 'Marble tiles' },
  tiles:      { ph: 'floor_tiles_06',        tile: 2,   col: '#b8b2a8', label: 'Floor tiles' },
  terrazzo:   { ph: 'terrazzo_tiles',        tile: 2,   col: '#c9c2b6', label: 'Terrazzo' },
  granite:    { ph: 'granite_tile',          tile: 2,   col: '#6e6a66', label: 'Granite' },
  roofclay:   { ph: 'clay_roof_tiles_02',    tile: 2.5, col: '#9a4c34', label: 'Clay roof' },
  roofslate:  { ph: 'roof_slates_02',        tile: 2.5, col: '#4b4f55', label: 'Slate roof' },
  roofred:    { ph: 'red_slate_roof_tiles_01', tile: 2.5, col: '#7e3b2e', label: 'Red slate roof' },
  roofgrey:   { ph: 'grey_roof_tiles',       tile: 2.5, col: '#5d6064', label: 'Grey roof tiles' },
  corrugated: { ph: 'corrugated_iron_02',    tile: 2.5, col: '#8b8f92', label: 'Corrugated iron' },
  metal:      { ph: 'metal_plate',           tile: 2,   col: '#8d9094', label: 'Steel plate', metal: true },
  rust:       { ph: 'rusty_metal_02',        tile: 2.5, col: '#7a5340', label: 'Rusty metal', metal: true },
  asphalt:    { ph: 'asphalt_02',            tile: 7,   col: '#3d3d3f', label: 'Asphalt' },
  pavers:     { ph: 'interlocking_concrete_pavers', tile: 2.5, col: '#8c8780', label: 'Pavers' },
  cobble:     { ph: 'cobblestone_floor_08',  tile: 3,   col: '#6f6a63', label: 'Cobblestone' },
  patterned:  { ph: 'patterned_cobblestone', tile: 3,   col: '#7d776d', label: 'Patterned cobble' },
  stonetiles: { ph: 'stone_tiles_02',        tile: 3,   col: '#8a8479', label: 'Stone tiles' },
  gravel:     { ph: 'gravel_road',           tile: 4,   col: '#8b8478', label: 'Gravel' },
  soil:       { ph: 'brown_mud_leaves_01',   tile: 2,   col: '#4a3a2a', label: 'Soil' },
  glass:      { glass: true,                 col: '#a9c6d6', label: 'Glass' },
  water:      { water: true,                 col: '#2f8fa0', label: 'Water' },
  paint:      { flat: true, rough: 0.6,      col: '#ffffff', label: 'Painted (colour)' },
  // garden colours (crops are built from simple shapes in these)
  leaf:       { flat: true, rough: 0.75, col: '#3d7428', label: 'Leaf' },
  leaf2:      { flat: true, rough: 0.75, col: '#6c9e34', label: 'Light leaf' },
  stem:       { flat: true, rough: 0.8,  col: '#557a2c', label: 'Stem' },
  tomato:     { flat: true, rough: 0.3,  col: '#c9261b', label: 'Tomato' },
  petal:      { flat: true, rough: 0.6,  col: '#f2c21b', label: 'Petal' },
  seeds:      { flat: true, rough: 0.9,  col: '#3e2610', label: 'Seeds' },
  pumpkin:    { flat: true, rough: 0.55, col: '#dc7418', label: 'Pumpkin' },
  corn:       { flat: true, rough: 0.6,  col: '#e6c446', label: 'Corn' },
  pink:       { flat: true, rough: 0.6,  col: '#e8679a', label: 'Pink petals' },
  lilac:      { flat: true, rough: 0.6,  col: '#9a6ad6', label: 'Lilac petals' },
  snowwhite:  { flat: true, rough: 0.6,  col: '#f4f2ea', label: 'White petals' },
  signwood:   { flat: true, rough: 0.8,  col: '#6b4a2e', label: 'Sign wood' },
  emissive:   { flat: true, emissive: true,  col: '#fff2d0', label: 'Light panel' },
};

// Box mapping in the object's own (scaled) space: textures keep real-world size whatever the part's
// dimensions, and travel with the object when it moves. All the stock map chunks are re-pointed at the
// computed UV; three.js derives the normal-map tangent frame from screen-space derivatives.
function boxMapped(mat, tile) {
  mat.userData.tile = tile;
  mat.customProgramCacheKey = () => 'boxmap';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTile = { value: tile };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBoxPos;\nvarying vec3 vBoxNrm;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 bxs = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #else
          vec3 bxs = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
        #endif
        vBoxPos = position * bxs; vBoxNrm = normal;`);
    const re = (chunk) => THREE.ShaderChunk[chunk].replace(/v(Map|NormalMap|RoughnessMap|MetalnessMap|AoMap)Uv/g, 'boxUv');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBoxPos;\nvarying vec3 vBoxNrm;\nuniform float uTile;')
      .replace('void main() {', `void main() {
        vec3 bxn = abs(vBoxNrm);
        vec2 boxUv = (bxn.y > max(bxn.x, bxn.z) ? vBoxPos.xz : (bxn.x > bxn.z ? vBoxPos.zy : vBoxPos.xy)) / uTile;`)
      .replace('#include <map_fragment>', re('map_fragment'))
      .replace('#include <normal_fragment_maps>', re('normal_fragment_maps'))
      .replace('#include <roughnessmap_fragment>', re('roughnessmap_fragment'))
      .replace('#include <metalnessmap_fragment>', re('metalnessmap_fragment'))
      .replace('#include <aomap_fragment>', re('aomap_fragment'));
  };
}

const matCache = new Map();
// One shared material per key: every instanced part with that finish uses it.
export function buildMaterial(key) {
  if (matCache.has(key)) return matCache.get(key);
  const def = MATERIALS[key] || MATERIALS.plaster;
  let m;
  if (def.glass) {
    m = new THREE.MeshPhysicalMaterial({ color: def.col, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.28, envMapIntensity: 1.6, specularIntensity: 1, depthWrite: false, side: THREE.DoubleSide });
  } else if (def.water) {
    m = new THREE.MeshPhysicalMaterial({ color: def.col, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.72, envMapIntensity: 1.4, depthWrite: false });
  } else if (def.flat) {
    m = new THREE.MeshStandardMaterial({ color: def.emissive ? '#ffffff' : def.col, roughness: def.rough ?? 0.6, metalness: 0 });
    if (def.emissive) { m.emissive = new THREE.Color(def.col); m.emissiveIntensity = 2.2; }
  } else {
    m = new THREE.MeshStandardMaterial({ color: def.col, roughness: 0.9, metalness: def.metal ? 0.6 : 0 });
    boxMapped(m, def.tile);
    phTexture(def.ph, 'diff', true).then((t) => { if (t) { m.map = t; m.color.set('#ffffff'); m.needsUpdate = true; } });
    phTexture(def.ph, 'nor_gl', false).then((t) => { if (t) { m.normalMap = t; m.needsUpdate = true; } });
    phTexture(def.ph, 'arm', false).then((t) => {
      if (t) { m.roughnessMap = t; m.aoMap = t; m.aoMapIntensity = 0.7; m.roughness = 1; if (def.metal) { m.metalnessMap = t; m.metalness = 1; } m.needsUpdate = true; }
    });
  }
  m.name = key;
  matCache.set(key, m);
  return m;
}

// ------------------------------------------------------------------ Poly Haven models
// Poly Haven's .gltf files point at "textures/x.jpg" beside them, but the CDN keeps model textures under
// Models/jpg/<res>/<id>/ instead, so rewrite those requests on the way out.
const phManager = new THREE.LoadingManager();
phManager.setURLModifier((url) => url.replace(/\/Models\/gltf\/(\w+)\/([^/]+)\/textures\//, '/Models/jpg/$1/$2/'));
const gltfLoader = new GLTFLoader(phManager);
gltfLoader.setCrossOrigin('anonymous');
const modelCache = new Map();

// Resolves to { parts: [{geometry, material}], size: Vector3 } with geometry baked into the model's
// own frame, centred on x/z and resting on y=0, ready to be drawn as InstancedMesh parts.
export function loadModel(id) {
  if (modelCache.has(id)) return modelCache.get(id);
  const p = new Promise((resolve) => {
    gltfLoader.load(PH_MODEL(id), (g) => {
      const root = g.scene;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const centre = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
      const shift = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
      const parts = [];
      root.traverse((o) => {
        if (!o.isMesh) return;
        const geo = o.geometry.clone();
        geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(shift, o.matrixWorld));
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mt of mats) {
          if (mt.map) mt.map.anisotropy = maxAniso;
          if (mt.transparent && mt.alphaTest === 0 && mt.map) { mt.alphaTest = 0.4; mt.transparent = false; }
        }
        parts.push({ geometry: geo, material: Array.isArray(o.material) ? o.material[0] : o.material });
      });
      resolve({ parts, size: box.getSize(new THREE.Vector3()) });
    }, undefined, (e) => { console.warn('model failed', id, e); resolve(null); });
  });
  modelCache.set(id, p);
  return p;
}

// ------------------------------------------------------------------ avatars
const avatarCache = new Map();
export const BODIES = {
  // yaw turns each model so it faces -z, the direction an avatar with heading 0 walks
  soldier: { file: 'Soldier.glb', label: 'Explorer', clips: { idle: 'Idle', walk: 'Walk', run: 'Run' }, yaw: 0 },
  xbot:    { file: 'Xbot.glb',    label: 'Mannequin', clips: { idle: 'idle', walk: 'walk', run: 'run' }, yaw: Math.PI },
};
export function loadBody(kind) {
  const def = BODIES[kind] || BODIES.soldier;
  if (avatarCache.has(def.file)) return avatarCache.get(def.file);
  const p = new Promise((resolve) => {
    gltfLoader.load(THREE_MODEL(def.file), (g) => {
      g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
      resolve({ scene: g.scene, animations: g.animations, def });
    }, undefined, () => resolve(null));
  });
  avatarCache.set(def.file, p);
  return p;
}

// ------------------------------------------------------------------ animals (three.js example models, morph-target animated)
const animalCache = new Map();
export function loadAnimal(file) {
  if (animalCache.has(file)) return animalCache.get(file);
  const p = new Promise((resolve) => {
    gltfLoader.load(THREE_MODEL(file), (g) => {
      g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      resolve(g);
    }, undefined, () => resolve(null));
  });
  animalCache.set(file, p);
  return p;
}

// a text sign drawn on a canvas (town signs, notice board)
export function textTexture(lines, opts = {}) {
  const W = opts.w || 512, H = opts.h || 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = opts.bg || '#5a3b22'; g.fillRect(0, 0, W, H);
  if (opts.grain !== false) for (let i = 0; i < 160; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`; g.fillRect(0, Math.random() * H, W, 1 + Math.random() * 2); }
  if (opts.border !== false) { g.strokeStyle = opts.borderColor || 'rgba(30,18,8,0.8)'; g.lineWidth = 10; g.strokeRect(5, 5, W - 10, H - 10); }
  g.fillStyle = opts.fg || '#f4e8cf';
  g.textAlign = opts.align || 'center'; g.textBaseline = 'middle';
  const size = opts.size || 64;
  lines.forEach((l, i) => {
    const s = typeof l === 'string' ? { t: l } : l;
    g.font = `${s.bold === false ? 500 : 700} ${s.size || size}px Inter, Georgia, serif`;
    const y = H / 2 + (i - (lines.length - 1) / 2) * (opts.lh || size * 1.15);
    g.fillText(s.t, opts.align === 'left' ? 30 : W / 2, y);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ procedural textures
// alpha leaf clusters for the tree cards
const procCache = new Map();
export function leafTexture(kind) {
  if (procCache.has('leaf:' + kind)) return procCache.get('leaf:' + kind);
  const W = 256, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let s = 1234 + kind.length * 977;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const pal = {
    oak:   [[95, 120], [40, 62], [14, 30]],
    birch: [[70, 95], [45, 70], [22, 40]],
    maple: [[8, 36], [70, 88], [30, 48]],
    bush:  [[85, 115], [35, 55], [12, 26]],
  }[kind] || [[90, 120], [40, 60], [15, 30]];
  if (kind === 'pine') {
    // needle sprays: a twig with many short dark needles
    for (let b = 0; b < 7; b++) {
      const x0 = W * (0.15 + rnd() * 0.7), y0 = H * (0.1 + rnd() * 0.8), ang = rnd() * Math.PI * 2, len = 70 + rnd() * 50;
      g.strokeStyle = 'rgba(70,50,35,1)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len); g.stroke();
      for (let i = 0; i < 90; i++) {
        const t = rnd(), px = x0 + Math.cos(ang) * len * t, py = y0 + Math.sin(ang) * len * t;
        const na = ang + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.7);
        g.strokeStyle = `hsl(${120 + rnd() * 25},${28 + rnd() * 20}%,${12 + rnd() * 14}%)`;
        g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(na) * 14, py + Math.sin(na) * 14); g.stroke();
      }
    }
  } else if (kind === 'palm') {
    // a single frond: a curved rib with drooping leaflets
    g.strokeStyle = '#6b6a2c'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(W * 0.5, H); g.quadraticCurveTo(W * 0.52, H * 0.5, W * 0.5, 0); g.stroke();
    for (let i = 0; i < 52; i++) {
      const y = H - (i / 52) * H, len = 118 * Math.sin((i / 52) * Math.PI) + 8;
      for (const sd of [-1, 1]) {
        g.strokeStyle = `hsl(${74 + rnd() * 22},${42 + rnd() * 18}%,${20 + rnd() * 14}%)`;
        g.lineWidth = 3 + rnd() * 2;
        g.beginPath(); g.moveTo(W / 2, y); g.quadraticCurveTo(W / 2 + sd * len * 0.6, y - 6, W / 2 + sd * len, y + 26); g.stroke();
      }
    }
  } else {
    // broadleaf cluster: overlapping leaf ellipses, darker toward the centre for self-shadowing
    for (let k = 0; k < 22; k++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * W * 0.34;
      const cx = W / 2 + Math.cos(a) * r, cy = H / 2 + Math.sin(a) * r;
      const cr = 18 + rnd() * 22;
      for (let i = 0; i < 26; i++) {
        const la = rnd() * Math.PI * 2, lr = Math.sqrt(rnd()) * cr;
        const x = cx + Math.cos(la) * lr, y = cy + Math.sin(la) * lr;
        const edge = lr / cr;
        const hue = pal[0][0] + rnd() * (pal[0][1] - pal[0][0]);
        const sat = pal[1][0] + rnd() * (pal[1][1] - pal[1][0]);
        const lit = pal[2][0] + edge * (pal[2][1] - pal[2][0]) + rnd() * 6;
        g.fillStyle = `hsl(${hue},${sat}%,${lit}%)`;
        g.save(); g.translate(x, y); g.rotate(rnd() * Math.PI);
        g.beginPath(); g.ellipse(0, 0, 5 + rnd() * 4, 2.6 + rnd() * 2, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 0.7; g.beginPath(); g.moveTo(-5, 0); g.lineTo(5, 0); g.stroke();
        g.restore();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  procCache.set('leaf:' + kind, t);
  return t;
}

export function waterNormals() {
  return loadTexture('https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/waternormals.jpg', false);
}
