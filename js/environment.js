// Sky, sun/moon light, image-based lighting, volumetric-looking cloud layer, stars, fog and the ocean.
// The whole thing is driven by one number: time of day (0 = midnight, 0.25 = sunrise, 0.5 = noon).
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { HALF, SEA } from './config.js';
import { smoothstep, lerp } from './noise.js';
import { waterNormals } from './assets.js';

export class Environment {
  constructor(renderer, scene, terrain) {
    this.renderer = renderer;
    this.scene = scene;
    this.terrain = terrain;
    this.sunDir = new THREE.Vector3(0.3, 0.8, 0.2).normalize();
    this.daylight = 1;      // 0 at night .. 1 in full day
    this.tod = 0.4;
    this.time = 0;

    // ---- sky dome (Preetham scattering)
    this.sky = new Sky();
    this.sky.scale.setScalar(9000);
    this.sky.material.uniforms.turbidity.value = 2.4;
    this.sky.material.uniforms.rayleigh.value = 1.2;
    this.sky.material.uniforms.mieCoefficient.value = 0.004;
    this.sky.material.uniforms.mieDirectionalG.value = 0.86;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // a second sky in its own scene, rendered into the PMREM environment map for reflections/ambient
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(900);
    this.envSky.material = this.sky.material;
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this.lastEnvSun = new THREE.Vector3(0, -2, 0);

    // ---- lights
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90; sc.near = 1; sc.far = 900;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.5;
    scene.add(this.sun, this.sun.target);

    this.moon = new THREE.DirectionalLight(0x9db4ff, 0);
    scene.add(this.moon, this.moon.target);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4030, 0.2);
    scene.add(this.hemi);

    scene.fog = new THREE.FogExp2(0xb8c8d8, 0.0011);

    this.buildStars();
    this.buildClouds();
    this.buildWater();
  }

  buildStars() {
    const n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = 5000;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(a) * s * r; pos[i * 3 + 1] = Math.abs(u) * r; pos[i * 3 + 2] = Math.sin(a) * s * r;
      const b = 0.4 + Math.random() * 0.6, warm = Math.random();
      col[i * 3] = b * (0.85 + warm * 0.15); col[i * 3 + 1] = b * 0.9; col[i * 3 + 2] = b * (1 - warm * 0.15);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -2;
    this.scene.add(this.stars);
  }

  // A cloud deck at ~700 m: each sky pixel intersects the deck plane and samples fractal noise there.
  buildClouds() {
    this.cloudUniforms = {
      uTime: { value: 0 }, uSun: { value: this.sunDir }, uSunCol: { value: new THREE.Color(1, 1, 1) },
      uShade: { value: new THREE.Color(0.6, 0.65, 0.72) }, uCover: { value: 0.48 }, uDay: { value: 1 },
    };
    const m = new THREE.ShaderMaterial({
      uniforms: this.cloudUniforms, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        uniform float uTime, uCover, uDay; uniform vec3 uSun, uSunCol, uShade; varying vec3 vW;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p, int oct){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { if (i >= oct) break; s += a * n(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vW - cameraPosition);
          if (d.y < 0.0) discard;
          float t = (700.0 - cameraPosition.y) / max(d.y, 0.02);
          vec2 p = (cameraPosition.xz + d.xz * t) * 0.00055 + vec2(uTime * 0.004, uTime * 0.0015);
          float base = fbm(p, 5);
          float dens = smoothstep(uCover, uCover + 0.32, base);
          if (dens < 0.003) discard;
          // light: sample the noise a little toward the sun; denser there = this side is in self-shadow
          float toward = fbm(p + uSun.xz * 0.06, 3) + 0.0625;
          float lit = clamp(1.0 - (toward - base) * 3.5, 0.25, 1.15);
          float silver = pow(max(dot(d, uSun), 0.0), 8.0) * 0.6;
          vec3 col = mix(uShade, uSunCol, lit) + uSunCol * silver;
          col *= mix(0.05, 1.0, uDay);
          float a = dens * smoothstep(0.0, 0.12, d.y) * 0.92;
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), m);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -1;
    this.scene.add(this.clouds);
  }

  buildWater() {
    const normals = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); normals.needsUpdate = true;
    this.waterUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, tNorm: { value: normals }, tHeight: { value: this.terrain.hTex },
      uSun: { value: this.sunDir }, uSunCol: { value: new THREE.Color(1, 1, 1) },
      uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) }, uZenith: { value: new THREE.Color(0.25, 0.45, 0.8) },
      uDay: { value: 1 }, uHalf: { value: HALF },
    }]);
    this.waterUniforms.tHeight.value = this.terrain.hTex;
    waterNormals().then((t) => { if (t) this.waterUniforms.tNorm.value = t; });
    const m = new THREE.ShaderMaterial({
      uniforms: this.waterUniforms, transparent: true, fog: true,
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        varying vec3 vW;
        void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime, uDay, uHalf; uniform sampler2D tNorm, tHeight;
        uniform vec3 uSun, uSunCol, uHorizon, uZenith;
        varying vec3 vW;
        vec3 wn(vec2 uv){ vec3 t = texture2D(tNorm, uv).rgb * 2.0 - 1.0; return t; }
        void main(){
          vec2 p = vW.xz;
          float dist = length(cameraPosition - vW);
          vec3 a = wn(p / 19.0 + vec2(uTime * 0.018, uTime * 0.011));
          vec3 b = wn(p / 31.0 - vec2(uTime * 0.012, -uTime * 0.016));
          vec3 c = wn(p / 113.0 + vec2(-uTime * 0.006, uTime * 0.004));
          vec2 sl = (a.xy + b.xy) * 0.5 + c.xy * 0.6;
          float strength = mix(0.55, 0.12, smoothstep(30.0, 900.0, dist));
          vec3 n = normalize(vec3(sl.x * strength, 1.0, sl.y * strength));
          vec3 v = normalize(cameraPosition - vW);
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
          vec3 r = reflect(-v, n); r.y = abs(r.y);
          vec3 sky = mix(uHorizon, uZenith, pow(r.y, 0.45));
          float spec = pow(max(dot(r, uSun), 0.0), 900.0) * 60.0 + pow(max(dot(r, uSun), 0.0), 90.0) * 0.6;
          // depth from the terrain heightmap: shallow water is clear turquoise, deep water dark blue
          vec2 huv = (p + uHalf) / (2.0 * uHalf);
          float ground = (huv.x < 0.0 || huv.y < 0.0 || huv.x > 1.0 || huv.y > 1.0) ? -26.0 : texture2D(tHeight, huv).r;
          float depth = max(0.0, ${SEA.toFixed(1)} - ground);
          vec3 shallow = vec3(0.09, 0.38, 0.36), deep = vec3(0.01, 0.06, 0.10);
          vec3 body = mix(shallow, deep, 1.0 - exp(-depth * 0.22));
          float sunUp = max(uSun.y, 0.0);
          body *= mix(0.04, 1.0, uDay) * (0.55 + 0.45 * sunUp);
          vec3 col = mix(body, sky, fres) + uSunCol * spec * uDay;
          // shoreline foam
          float fn = texture2D(tNorm, p / 7.0 + uTime * 0.03).r;
          float foam = smoothstep(0.9, 0.05, depth) * smoothstep(0.35, 0.75, fn + 0.25 * sin(uTime * 1.3 + depth * 6.0));
          col = mix(col, vec3(0.9) * mix(0.08, 1.0, uDay), foam * 0.8);
          float alpha = mix(0.5, 0.97, smoothstep(0.0, 2.5, depth));
          alpha = max(alpha, fres);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    const geo = new THREE.PlaneGeometry(14000, 14000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(geo, m);
    this.water.position.y = SEA;
    this.water.renderOrder = 1;
    this.water.frustumCulled = false;
    this.scene.add(this.water);
  }

  setShadowSize(n) {
    if (this.sun.shadow.mapSize.x === n) return;
    this.sun.shadow.mapSize.set(n, n);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
  }

  setTimeOfDay(tod) {
    this.tod = ((tod % 1) + 1) % 1;
    const a = (this.tod - 0.25) * Math.PI * 2;
    this.sunDir.set(Math.cos(a) * 0.86, Math.sin(a), 0.42).normalize();
  }

  update(dt, focus, camera) {
    this.time += dt;
    const s = this.sunDir;
    const elev = s.y;
    const W = this.weather || { cover: 0.48, gloom: 0, fog: 0, flash: 0 };
    const day = smoothstep(-0.12, 0.12, elev) * (1 - W.gloom * 0.35);
    this.daylight = day;
    const golden = smoothstep(0.35, 0.02, elev) * smoothstep(-0.12, 0.04, elev); // sunrise / sunset tint

    // sky
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(s).multiplyScalar(1000);
    u.rayleigh.value = lerp(1.6, 2.8, golden);
    u.turbidity.value = lerp(1.6, 6, golden);

    // sun light: warm and low at the ends of the day
    const sunCol = new THREE.Color().setRGB(1, lerp(0.97, 0.62, golden), lerp(0.92, 0.38, golden));
    this.sun.color.copy(sunCol);
    this.sun.intensity = smoothstep(-0.03, 0.18, elev) * 3.2 * (1 - W.gloom * 0.8);
    this.sun.visible = elev > -0.05;
    // keep the shadow frustum on the player, snapped to whole shadow texels so edges don't crawl
    const sc = this.sun.shadow.camera;
    const texel = (sc.right - sc.left) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + s.x * 400, focus.y + Math.max(s.y, 0.05) * 400, fz + s.z * 400);

    // moon: opposite side, faint blue key light so nights stay readable
    const md = s.clone().negate();
    this.moon.intensity = smoothstep(0.0, -0.2, elev) * 0.6;
    this.moon.position.set(focus.x + md.x * 400, focus.y + Math.abs(md.y) * 400 + 100, focus.z + md.z * 400);
    this.moon.target.position.copy(focus);

    this.hemi.intensity = lerp(0.22, 0.3, day) + W.gloom * 0.25 + W.flash * 3.5;
    this.hemi.color.setRGB(lerp(0.18, 0.75, day), lerp(0.22, 0.82, day), lerp(0.35, 0.95, day));
    this.hemi.groundColor.setRGB(lerp(0.03, 0.32, day), lerp(0.03, 0.28, day), lerp(0.05, 0.22, day));

    // fog + colours handed to the water: from the sky model's own look at this hour
    const horizon = new THREE.Color().setRGB(lerp(0.035, 0.68, day), lerp(0.045, 0.78, day), lerp(0.08, 0.9, day));
    horizon.lerp(new THREE.Color(0.95, 0.62, 0.42), golden * 0.55);
    const zenith = new THREE.Color().setRGB(lerp(0.01, 0.18, day), lerp(0.015, 0.38, day), lerp(0.04, 0.78, day));
    // overcast: everything slides toward a flat grey, and the fog thickens
    const grey = new THREE.Color().setScalar(lerp(0.03, 0.5, day));
    horizon.lerp(grey, W.gloom * 0.85);
    zenith.lerp(grey.clone().multiplyScalar(0.8), W.gloom * 0.9);
    if (W.flash > 0) { horizon.lerp(new THREE.Color(0.85, 0.88, 1), W.flash * 0.6); zenith.lerp(new THREE.Color(0.7, 0.75, 0.95), W.flash * 0.5); }
    this.scene.fog.color.copy(horizon);
    this.scene.fog.density = 0.0011 + W.fog * 0.011;
    this.skyGloom = W.gloom;
    this.waterUniforms.uHorizon.value.copy(horizon);
    this.waterUniforms.uZenith.value.copy(zenith);
    this.waterUniforms.uSunCol.value.copy(sunCol);
    this.waterUniforms.uDay.value = day;
    this.waterUniforms.uTime.value = this.time;
    this.water.position.x = Math.round(camera.position.x / 100) * 100;
    this.water.position.z = Math.round(camera.position.z / 100) * 100;

    this.cloudUniforms.uTime.value = this.time;
    this.cloudUniforms.uSunCol.value.copy(sunCol).multiplyScalar(lerp(0.9, 1.25, day));
    this.cloudUniforms.uShade.value.setRGB(lerp(0.15, 0.62, day), lerp(0.16, 0.66, day), lerp(0.22, 0.74, day)).lerp(new THREE.Color(0.55, 0.42, 0.45), golden * 0.5);
    this.cloudUniforms.uDay.value = Math.max(day, 0.08) + W.flash * 0.8;
    this.cloudUniforms.uCover.value = W.cover;
    this.cloudUniforms.uShade.value.multiplyScalar(1 - W.gloom * 0.45);
    this.clouds.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.starMat.opacity = smoothstep(0.05, -0.18, elev);
    this.sky.position.copy(camera.position);
    // the scattering sky can't go grey by itself; a dome of fog-coloured haze covers it when overcast
    if (!this.haze) {
      this.haze = new THREE.Mesh(new THREE.SphereGeometry(8000, 24, 12), new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, fog: false }));
      this.haze.renderOrder = -1.5; this.haze.frustumCulled = false;
      this.scene.add(this.haze);
    }
    this.haze.position.copy(camera.position);
    this.haze.material.color.copy(horizon);
    this.haze.material.opacity = Math.min(0.97, W.gloom * 1.05 + W.fog * 0.3);
    this.haze.visible = this.haze.material.opacity > 0.01;

    this.renderer.toneMappingExposure = lerp(0.6, 0.78, day);
    this.scene.environmentIntensity = lerp(0.15, 0.75, day);

    // refresh the reflection/ambient environment when the sun has moved enough to notice
    if (!this.envRT || s.distanceTo(this.lastEnvSun) > 0.03) {
      this.lastEnvSun.copy(s);
      const old = this.envRT;
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
      this.scene.environment = this.envRT.texture;
      if (old) old.dispose();
    }
  }
}
