// The island: a seeded heightmap (2 m grid) drawn as 64 m chunks with a splat shader that blends four
// photo-scanned ground layers (grass, forest floor, rock, sand) plus automatic rock on slopes and snow on
// peaks. Players reshape and repaint it with brush ops; ops are deterministic so every client replays
// the same list and ends up with the same ground.
import * as THREE from 'three';
import { HALF, CELL, N, CHUNK_CELLS, CHUNKS, SEED, SEA, SPAWN } from './config.js';
import { makeNoise, smoothstep, lerp, clamp } from './noise.js';
import { phTexture } from './assets.js';

const noise = makeNoise(SEED);

export const LAYERS = [
  { key: 'grass',  ph: 'rocky_terrain_02',  tile: 7,  label: 'Grass' },
  { key: 'soil',   ph: 'forest_leaves_02',  tile: 5,  label: 'Forest floor' },
  { key: 'rock',   ph: 'lichen_rock',       tile: 8,  label: 'Rock' },
  { key: 'sand',   ph: 'coast_sand_01',     tile: 5,  label: 'Sand' },
];

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.h = new Float32Array(N * N);        // heights
    this.w = new Uint8Array(N * N * 4);      // paint weights (grass, soil, rock, sand)
    this.chunks = [];
    this.dirty = new Set();
    this.texDirty = false;
    this.onChange = null;                    // (minX, minZ, maxX, maxZ) after an op lands
    this.generate();
    this.buildTextures();
    this.buildMaterial();
    this.buildChunks();
  }

  // ---------------------------------------------------------------- generation
  baseHeight(x, z) {
    const r = Math.hypot(x, z * 1.08) / (HALF * 0.9);
    const coast = noise.fbm(x / 260 + 7, z / 260 - 3, 4) * 0.16;
    const land = smoothstep(1.02, 0.66, r + coast);                       // 1 inland -> 0 open sea
    let h = 4 + noise.fbm(x / 340, z / 340, 5) * 16 + noise.fbm(x / 90 + 30, z / 90, 4) * 3.5;
    // a mountain range along the north, ridged so it reads as eroded rock
    const north = smoothstep(-40, -300, z) * smoothstep(1.0, 0.55, r);
    h += north * (noise.ridged(x / 210 + 11, z / 210 + 5, 6) * 150 - 18);
    // rolling hills to the east
    h += smoothstep(80, 330, x) * smoothstep(0.95, 0.5, r) * (noise.fbm(x / 140 - 9, z / 140 + 2, 4) * 22 + 10);
    // a lake to the south-west
    const lk = Math.hypot((x + 210) / 95, (z - 170) / 70);
    h = lerp(h, -7, smoothstep(1.15, 0.55, lk + noise.fbm(x / 60, z / 60, 3) * 0.2));
    // the town meadow around spawn stays gentle so new players can build straight away
    const sp = Math.hypot(x - SPAWN.x, z - SPAWN.z) / 175;
    h = lerp(h, 5.5 + noise.fbm(x / 120, z / 120, 3) * 1.6, smoothstep(1, 0.55, sp));
    return lerp(-26 + noise.fbm(x / 200, z / 200, 3) * 6, h, land);
  }

  generate() {
    const { h, w } = this;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        h[j * N + i] = this.baseHeight(i * CELL - HALF, j * CELL - HALF);
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = i * CELL - HALF, z = j * CELL - HALF, k = j * N + i;
        const y = h[k];
        const sl = this.slopeAt(i, j);
        const forest = smoothstep(0.05, 0.35, noise.fbm(x / 160 + 40, z / 160 - 12, 4));
        let sand = smoothstep(2.6, 1.0, y + noise.simplex(x / 18, z / 18) * 0.6);
        let rock = Math.max(smoothstep(0.55, 0.9, sl), smoothstep(60, 95, y) * 0.8);
        let soil = forest * 0.85 * (1 - sand) + smoothstep(0.3, 0.6, noise.fbm(x / 40, z / 40, 3)) * 0.35;
        let grass = Math.max(0, 1 - sand - rock - soil * 0.6);
        const s = grass + soil + rock + sand || 1;
        w[k * 4] = (grass / s) * 255; w[k * 4 + 1] = (soil / s) * 255; w[k * 4 + 2] = (rock / s) * 255; w[k * 4 + 3] = (sand / s) * 255;
      }
    }
    this.forestMask = (x, z) => smoothstep(-0.08, 0.22, noise.fbm(x / 160 + 40, z / 160 - 12, 4));
  }

  slopeAt(i, j) {
    const { h } = this;
    const a = h[j * N + Math.max(0, i - 1)], b = h[j * N + Math.min(N - 1, i + 1)];
    const c = h[Math.max(0, j - 1) * N + i], d = h[Math.min(N - 1, j + 1) * N + i];
    const nx = a - b, nz = c - d, ny = 2 * CELL * 2;
    return 1 - ny / Math.hypot(nx, ny, nz);
  }

  // ---------------------------------------------------------------- queries
  heightAt(x, z) {
    const fx = clamp((x + HALF) / CELL, 0, N - 1.001), fz = clamp((z + HALF) / CELL, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const h = this.h;
    const a = h[j * N + i], b = h[j * N + i + 1], c = h[(j + 1) * N + i], d = h[(j + 1) * N + i + 1];
    // match the triangle split used by the mesh so feet sit exactly on the drawn ground
    if (tx + tz < 1) return a + (b - a) * tx + (c - a) * tz;
    return d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = CELL;
    return out.set(this.heightAt(x - e, z) - this.heightAt(x + e, z), 2 * e, this.heightAt(x, z - e) - this.heightAt(x, z + e)).normalize();
  }

  // ray march against the heightmap; returns the hit point or null
  raycast(ray, maxDist = 2000) {
    const p = new THREE.Vector3();
    let prev = 0, step = 1;
    for (let t = 0; t < maxDist; t += step) {
      p.copy(ray.direction).multiplyScalar(t).add(ray.origin);
      if (Math.abs(p.x) > HALF + 200 || Math.abs(p.z) > HALF + 200) { if (t > 50) break; }
      const ground = Math.abs(p.x) <= HALF && Math.abs(p.z) <= HALF ? this.heightAt(p.x, p.z) : -26;
      if (p.y <= ground) {
        // refine between prev and t
        let lo = prev, hi = t;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          p.copy(ray.direction).multiplyScalar(mid).add(ray.origin);
          if (p.y <= this.heightAt(p.x, p.z)) hi = mid; else lo = mid;
        }
        p.copy(ray.direction).multiplyScalar(hi).add(ray.origin);
        p.y = this.heightAt(p.x, p.z);
        return p;
      }
      prev = t;
      step = Math.max(0.5, Math.min(8, (p.y - ground) * 0.5));
    }
    return null;
  }

  layerWeight(x, z, layer) {
    const i = clamp(Math.round((x + HALF) / CELL), 0, N - 1), j = clamp(Math.round((z + HALF) / CELL), 0, N - 1);
    return this.w[(j * N + i) * 4 + layer] / 255;
  }

  // ---------------------------------------------------------------- GPU data
  // heightmap + paint as textures, read by the grass and the water shaders
  buildTextures() {
    this.hTex = new THREE.DataTexture(this.h, N, N, THREE.RedFormat, THREE.FloatType);
    this.hTex.magFilter = this.hTex.minFilter = THREE.LinearFilter;
    this.hTex.needsUpdate = true;
    this.wTex = new THREE.DataTexture(this.w, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.wTex.magFilter = this.wTex.minFilter = THREE.LinearFilter;
    this.wTex.needsUpdate = true;
  }

  buildMaterial() {
    const uniforms = {
      tD0: { value: null }, tD1: { value: null }, tD2: { value: null }, tD3: { value: null },
      tN0: { value: null }, tN1: { value: null }, tN2: { value: null }, tN3: { value: null },
      tSnow: { value: null },
      uTile: { value: new THREE.Vector4(...LAYERS.map((l) => l.tile)) },
    };
    this.uniforms = uniforms;
    const placeholder = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); placeholder.needsUpdate = true;
    const placeholderD = new THREE.DataTexture(new Uint8Array([110, 130, 80, 255]), 1, 1); placeholderD.colorSpace = THREE.SRGBColorSpace; placeholderD.needsUpdate = true;
    LAYERS.forEach((l, i) => {
      uniforms['tD' + i].value = placeholderD; uniforms['tN' + i].value = placeholder;
      phTexture(l.ph, 'diff', true).then((t) => { if (t) uniforms['tD' + i].value = t; });
      phTexture(l.ph, 'nor_gl', false).then((t) => { if (t) uniforms['tN' + i].value = t; });
    });
    uniforms.tSnow.value = placeholderD;
    phTexture('snow_02', 'diff', true).then((t) => { if (t) uniforms.tSnow.value = t; });

    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 splat;\nvarying vec4 vSplat;\nvarying vec3 vTWPos;\nvarying vec3 vTWNrm;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat;\nvTWPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvTWNrm = normal;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tD0, tD1, tD2, tD3, tN0, tN1, tN2, tN3, tSnow;
          uniform vec4 uTile;
          varying vec4 vSplat; varying vec3 vTWPos; varying vec3 vTWNrm;
          // two scales mixed to hide tiling (one fetch on the cheap path)
          #ifdef TERRAIN_CHEAP
          vec3 tdiff(sampler2D t, vec2 uv) { return texture2D(t, uv).rgb; }
          #else
          vec3 tdiff(sampler2D t, vec2 uv) { return mix(texture2D(t, uv).rgb, texture2D(t, uv * 0.193 + vec2(0.31, 0.77)).rgb, 0.4); }
          #endif
          float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }`)
        .replace('#include <map_fragment>', `
          vec2 tuv = vec2(vTWPos.x, -vTWPos.z);
          vec3 nG = normalize(vTWNrm);
          float slope = 1.0 - nG.y;
          vec4 w = vSplat;
          float autoRock = smoothstep(0.30, 0.55, slope);
          w = mix(w, vec4(0.0, 0.0, 1.0, 0.0), autoRock);
          vec3 c0 = tdiff(tD0, tuv / uTile.x), c1 = tdiff(tD1, tuv / uTile.y), c3 = tdiff(tD3, tuv / uTile.w);
          // rock: tri-planar so cliffs don't stretch
          vec3 an = pow(abs(nG), vec3(4.0)); an /= (an.x + an.y + an.z);
          #ifdef TERRAIN_CHEAP
          vec3 c2 = texture2D(tD2, (an.y > max(an.x, an.z) ? tuv : an.x > an.z ? vTWPos.zy : vTWPos.xy) / uTile.z).rgb;
          #else
          vec3 c2 = texture2D(tD2, vTWPos.zy / uTile.z).rgb * an.x + texture2D(tD2, tuv / uTile.z).rgb * an.y + texture2D(tD2, vTWPos.xy / uTile.z).rgb * an.z;
          #endif
          // height-aware blending: the brighter (taller) texel wins at a transition, which reads as pebbles poking through sand etc.
          vec4 hb = w * (vec4(lum(c0), lum(c1), lum(c2), lum(c3)) + 0.35);
          hb = pow(hb + 1e-4, vec4(5.0));
          hb /= (hb.x + hb.y + hb.z + hb.w);
          vec3 tcol = c0 * hb.x + c1 * hb.y + c2 * hb.z + c3 * hb.w;
          float macro = texture2D(tD1, tuv * 0.011).g;
          tcol *= mix(0.82, 1.12, macro);
          float snow = smoothstep(82.0, 104.0, vTWPos.y + macro * 14.0) * (1.0 - smoothstep(0.45, 0.7, slope));
          if (snow > 0.0) tcol = mix(tcol, tdiff(tSnow, tuv / 6.0) * 1.05, snow);
          // wet sand / shoreline darkening
          tcol *= mix(0.55, 1.0, smoothstep(-0.4, 1.1, vTWPos.y));
          diffuseColor.rgb *= tcol;
          #ifdef TERRAIN_CHEAP
          vec3 tn = vec3(0.0, 0.0, 1.0);
          #else
          vec3 tn = (texture2D(tN0, tuv / uTile.x).xyz * hb.x + texture2D(tN1, tuv / uTile.y).xyz * hb.y
                   + texture2D(tN2, tuv / uTile.z).xyz * hb.z + texture2D(tN3, tuv / uTile.w).xyz * hb.w) * 2.0 - 1.0;
          tn.xy *= 1.0 - snow * 0.7;
          #endif
          float tRough = 0.97 - hb.z * 0.12 - (1.0 - smoothstep(-0.4, 0.9, vTWPos.y)) * 0.45;`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
        .replace('#include <normal_fragment_maps>', `
          vec3 tT = normalize(vec3(1.0, 0.0, 0.0) - nG * nG.x);
          vec3 tB = cross(nG, tT);
          vec3 nW = normalize(tT * tn.x + tB * tn.y + nG * tn.z);
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`);
    };
    this.material = m;
  }

  setCheap(on) {
    const had = 'TERRAIN_CHEAP' in (this.material.defines || {});
    if (had === !!on) return;
    this.material.defines = on ? { TERRAIN_CHEAP: '' } : {};
    this.material.needsUpdate = true;
  }

  buildChunks() {
    const verts = CHUNK_CELLS + 1;
    // shared index buffer for every chunk
    const idx = [];
    for (let j = 0; j < CHUNK_CELLS; j++) for (let i = 0; i < CHUNK_CELLS; i++) {
      const a = j * verts + i, b = a + 1, c = a + verts, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    for (let cj = 0; cj < CHUNKS; cj++) {
      for (let ci = 0; ci < CHUNKS; ci++) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * verts * 3), 3));
        g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * verts * 3), 3));
        g.setAttribute('splat', new THREE.BufferAttribute(new Uint8Array(verts * verts * 4), 4, true));
        g.setIndex(idx);
        const mesh = new THREE.Mesh(g, this.material);
        mesh.receiveShadow = true;
        // hills shading valleys is barely visible inside the ±90 m shadow box but doubled the shadow pass
        mesh.castShadow = false;
        mesh.userData.ci = ci; mesh.userData.cj = cj;
        this.scene.add(mesh);
        this.chunks.push(mesh);
        this.fillChunk(mesh);
      }
    }
  }

  fillChunk(mesh) {
    const { ci, cj } = mesh.userData;
    const verts = CHUNK_CELLS + 1;
    const g = mesh.geometry;
    const pos = g.attributes.position.array, nrm = g.attributes.normal.array, sp = g.attributes.splat.array;
    const { h, w } = this;
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const gi = ci * CHUNK_CELLS + i, gj = cj * CHUNK_CELLS + j, k = gj * N + gi, o = j * verts + i;
        pos[o * 3] = gi * CELL - HALF; pos[o * 3 + 1] = h[k]; pos[o * 3 + 2] = gj * CELL - HALF;
        const a = h[gj * N + Math.max(0, gi - 1)], b = h[gj * N + Math.min(N - 1, gi + 1)];
        const c = h[Math.max(0, gj - 1) * N + gi], d = h[Math.min(N - 1, gj + 1) * N + gi];
        const nx = a - b, ny = 4 * CELL, nz = c - d, l = Math.hypot(nx, ny, nz);
        nrm[o * 3] = nx / l; nrm[o * 3 + 1] = ny / l; nrm[o * 3 + 2] = nz / l;
        sp[o * 4] = w[k * 4]; sp[o * 4 + 1] = w[k * 4 + 1]; sp[o * 4 + 2] = w[k * 4 + 2]; sp[o * 4 + 3] = w[k * 4 + 3];
      }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.splat.needsUpdate = true;
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }

  // ---------------------------------------------------------------- editing
  // op: { k: 'raise'|'lower'|'flatten'|'smooth'|'paint'|'level', x, z, r, s, y?, l? }
  applyOp(op) {
    const r = clamp(op.r, 1, 40), s = clamp(op.s, 0, 1);
    const { h, w } = this;
    const i0 = Math.max(0, Math.floor((op.x - r + HALF) / CELL)), i1 = Math.min(N - 1, Math.ceil((op.x + r + HALF) / CELL));
    const j0 = Math.max(0, Math.floor((op.z - r + HALF) / CELL)), j1 = Math.min(N - 1, Math.ceil((op.z + r + HALF) / CELL));
    let src = null;
    if (op.k === 'smooth') src = h.slice();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i * CELL - HALF, z = j * CELL - HALF;
        const d = Math.hypot(x - op.x, z - op.z) / r;
        if (d >= 1) continue;
        const f = op.k === 'level' ? smoothstep(1, 0.8, d) : 0.5 + 0.5 * Math.cos(d * Math.PI); // soft brush falloff
        const k = j * N + i;
        switch (op.k) {
          case 'raise': h[k] += f * s * 1.2; break;
          case 'lower': h[k] -= f * s * 1.2; break;
          case 'flatten': h[k] = lerp(h[k], op.y, f * s * 0.6); break;
          case 'level': h[k] = lerp(h[k], op.y, f); break;
          case 'smooth': {
            let sum = 0, n = 0;
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
              const ii = clamp(i + di, 0, N - 1), jj = clamp(j + dj, 0, N - 1);
              sum += src[jj * N + ii]; n++;
            }
            h[k] = lerp(h[k], sum / n, f * s);
            break;
          }
          case 'paint': {
            const l = clamp(op.l | 0, 0, 3), a = f * s * 0.5;
            let tot = 0;
            for (let c = 0; c < 4; c++) {
              const v = w[k * 4 + c] / 255;
              const nv = c === l ? v + (1 - v) * a : v * (1 - a);
              w[k * 4 + c] = Math.round(nv * 255); tot += w[k * 4 + c];
            }
            if (tot === 0) w[k * 4 + l] = 255;
            break;
          }
        }
        if (h[k] < -40) h[k] = -40; else if (h[k] > 220) h[k] = 220;
      }
    }
    // mark the touched chunks (plus a 1-cell margin, normals use neighbours)
    const c0 = Math.max(0, Math.floor((i0 - 1) / CHUNK_CELLS)), c1 = Math.min(CHUNKS - 1, Math.floor((i1 + 1) / CHUNK_CELLS));
    const d0 = Math.max(0, Math.floor((j0 - 1) / CHUNK_CELLS)), d1 = Math.min(CHUNKS - 1, Math.floor((j1 + 1) / CHUNK_CELLS));
    for (let cj = d0; cj <= d1; cj++) for (let ci = c0; ci <= c1; ci++) this.dirty.add(cj * CHUNKS + ci);
    this.texDirty = true;
    if (this.onChange) this.onChange(op.x - r, op.z - r, op.x + r, op.z + r);
  }

  // called once per frame: rebuild touched chunks and re-upload the data textures
  update() {
    if (this.dirty.size) {
      for (const id of this.dirty) this.fillChunk(this.chunks[id]);
      this.dirty.clear();
    }
    if (this.texDirty) {
      this.hTex.needsUpdate = true;
      this.wTex.needsUpdate = true;
      this.texDirty = false;
    }
  }

  // average height under a footprint, used by the house generator to level a pad
  averageHeight(x0, z0, x1, z1) {
    let sum = 0, n = 0;
    for (let z = z0; z <= z1; z += CELL) for (let x = x0; x <= x1; x += CELL) { sum += this.heightAt(x, z); n++; }
    return n ? sum / n : 0;
  }
}

export function isUnderwater(y) { return y < SEA; }
