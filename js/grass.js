// Grass blades around the camera, generated entirely on the GPU. A fixed field of blade instances is
// wrapped around the camera (toroidally), each blade reads the terrain heightmap for its base, the paint
// map for how grassy that spot is, and the build mask so floors and roads stay clear.
import * as THREE from 'three';
import { HALF, SEA } from './config.js';
import { wind } from './trees.js';

export class Grass {
  constructor(scene, terrain, objects) {
    this.scene = scene;
    this.terrain = terrain;
    this.objects = objects;
    this.mesh = null;
    this.uniforms = {
      tHeight: { value: terrain.hTex }, tPaint: { value: terrain.wTex }, tMask: { value: objects.grassTex },
      uCenter: { value: new THREE.Vector2() }, uSize: { value: 80 }, uHalf: { value: HALF },
      uWindTime: wind.uWindTime, uWind: wind.uWind,
    };
  }

  build(count, radius) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.uniforms.uSize.value = radius * 2;
    // one blade: 3 segments tapering to a point (curved by the wind bend below)
    const seg = 3, pos = [], uv = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg, w = 0.028 * (1 - t * 0.9);
      pos.push(-w, t, 0, w, t, 0);
      uv.push(0, t, 1, t);
    }
    for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const base = new THREE.InstancedBufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    base.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    base.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    base.setIndex(idx);
    const off = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      off[i * 4] = Math.random(); off[i * 4 + 1] = Math.random();       // position in the tile 0..1
      off[i * 4 + 2] = Math.random() * Math.PI * 2;                      // yaw
      off[i * 4 + 3] = Math.random();                                    // random per blade
    }
    base.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
    base.instanceCount = count;
    base.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aOff;
          uniform sampler2D tHeight, tPaint, tMask; uniform vec2 uCenter; uniform float uSize, uHalf, uWindTime, uWind;
          varying vec3 vGrassCol; varying float vGrassT;`)
        .replace('#include <beginnormal_vertex>', `
          // wrap this blade's slot around the camera
          vec2 wpos = uCenter + (fract(aOff.xy - uCenter / uSize) - 0.5) * uSize;
          vec2 huv = (wpos + uHalf) / (2.0 * uHalf);
          float ground = texture2D(tHeight, huv).r;
          vec4 paint = texture2D(tPaint, huv);
          float mask = texture2D(tMask, huv).r;
          float dist = length(wpos - uCenter) / (uSize * 0.5);
          float density = paint.r * 1.15 + paint.g * 0.35 - paint.a * 1.2 - paint.b * 0.8;
          float keep = step(aOff.w, density) * mask * step(${(SEA + 0.35).toFixed(2)}, ground) * step(abs(wpos.x), uHalf) * step(abs(wpos.y), uHalf);
          float hgt = (0.16 + aOff.w * 0.3) * keep * smoothstep(1.0, 0.75, dist) * (0.75 + paint.r * 0.45);
          float cy = cos(aOff.z), sy = sin(aOff.z);
          vec3 objectNormal = vec3(sy, 0.6, cy);`)
        .replace('#include <begin_vertex>', `
          float t = position.y;
          vec3 transformed = vec3(position.x * cy, 0.0, -position.x * sy);
          float gust = sin(uWindTime * 1.7 + wpos.x * 0.15 + wpos.y * 0.11) * 0.5 + 0.5;
          float bend = (0.25 + gust * 0.55 * uWind + aOff.w * 0.2) * t * t;
          transformed.y = t * hgt;
          transformed.x += bend * hgt * 0.9;
          transformed.z += bend * hgt * 0.35 * sin(aOff.z * 3.0);
          transformed += vec3(wpos.x, ground - 0.03, wpos.y);
          vGrassT = t;
          vGrassCol = mix(vec3(0.045, 0.10, 0.018), vec3(0.16, 0.24, 0.05), aOff.w) * mix(0.75, 1.15, fract(aOff.x * 13.7));
          vGrassCol = mix(vGrassCol, vec3(0.22, 0.19, 0.08), paint.g * 0.5);`)
        .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0); gl_Position = projectionMatrix * mvPosition;')
        .replace('#include <worldpos_vertex>', 'vec4 worldPosition = vec4(transformed, 1.0);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol; varying float vGrassT;')
        .replace('#include <map_fragment>', 'diffuseColor.rgb = vGrassCol * mix(0.35, 1.0, vGrassT);');
    };
    m.customProgramCacheKey = () => 'grass';
    this.mesh = new THREE.Mesh(base, m);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.scene.add(this.mesh);
  }

  update(camera) {
    if (!this.mesh) return;
    this.uniforms.uCenter.value.set(camera.position.x, camera.position.z);
    this.uniforms.tHeight.value = this.terrain.hTex;
  }
}
