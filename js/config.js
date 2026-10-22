// World-wide constants shared by every module. Changing any of these changes the world layout for every
// player, so they must match across clients (the server stores edits in metres, not grid indices).
export const HALF = 512;              // the island spans -HALF..HALF metres on x and z
export const CELL = 2;                // terrain grid spacing in metres
export const N = HALF * 2 / CELL + 1; // vertices per side (513)
export const CHUNK_CELLS = 32;        // cells per terrain chunk side (64 m)
export const CHUNKS = (N - 1) / CHUNK_CELLS;
export const SEA = 0;                 // sea level
export const PLOT = 32;               // land plots are PLOT x PLOT metres
export const SEED = 20261022;
export const DAY_MS = 40 * 60 * 1000; // one in-world day lasts 40 real minutes
export const SPAWN = { x: 0, z: 70 };
// The shared world server's WebSocket address, e.g. 'wss://relive-world.example.com/ws'. Empty means
// "the host that served this page", which is right when playing through Play ReLive.cmd. A static host
// such as GitHub Pages has no server, so the game plays solo until this points at a running one.
export const WORLD_SERVER = '';

// maxDpr caps the screen's pixel density (a 125% Windows scale would otherwise render 1.56x the pixels);
// post = run the effect composer at all (low draws straight to the screen); shadowEvery = re-render the
// shadow map every N frames; cheapTerrain = one texture fetch per ground layer, no ground normal maps
export const QUALITY = {
  low:    { maxDpr: 1,    pixelRatio: 0.8, shadow: 1024, shadowSoft: false, shadowEvery: 2, grass: 25000,  grassRadius: 20, treeNear: 70,  treeShadow: 0,  post: false, aa: '',     bloom: false, ao: false, texRes: '1k', clouds: false, cheapTerrain: true },
  medium: { maxDpr: 1,    pixelRatio: 1,   shadow: 2048, shadowSoft: false, shadowEvery: 2, grass: 70000,  grassRadius: 28, treeNear: 110, treeShadow: 40, post: true,  aa: 'fxaa', bloom: false, ao: false, texRes: '1k', clouds: true,  cheapTerrain: true },
  high:   { maxDpr: 1.25, pixelRatio: 1,   shadow: 2048, shadowSoft: true,  shadowEvery: 1, grass: 150000, grassRadius: 40, treeNear: 160, treeShadow: 70, post: true,  aa: 'smaa', bloom: true,  ao: false, texRes: '2k', clouds: true,  cheapTerrain: false },
  ultra:  { maxDpr: 2,    pixelRatio: 1,   shadow: 4096, shadowSoft: true,  shadowEvery: 1, grass: 300000, grassRadius: 55, treeNear: 240, treeShadow: 90, post: true,  aa: 'smaa', bloom: true,  ao: true,  texRes: '2k', clouds: true,  cheapTerrain: false },
};

// Pick a starting preset from the GPU's name: integrated and mobile chips get "low"; entry-level
// discrete cards "medium"; anything else "high". Dynamic resolution then fine-tunes while playing.
export function detectQuality(renderer) {
  let name = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { }
  let q = 'high';
  if (/intel|uhd|iris|hd graphics|mali|adreno|powervr|apple gpu|swiftshader|llvmpipe|microsoft basic/i.test(name)) q = 'low';
  else if (/mx ?\d{3}|gtx ?(9\d0|10[35]0)|radeon\(tm\) graphics|vega ?\d\b|rx ?5[45]0/i.test(name)) q = 'medium';
  return { q, gpu: String(name).replace(/^ANGLE \((.*)\)$/, '$1').replace(/ Direct3D.*$/, '') };
}

export function plotKey(x, z) { return Math.floor(x / PLOT) + ',' + Math.floor(z / PLOT); }
export function plotOrigin(key) { const [i, j] = key.split(',').map(Number); return { x: i * PLOT, z: j * PLOT }; }
