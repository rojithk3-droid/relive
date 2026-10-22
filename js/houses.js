// Procedural houses: turns a footprint (multiple of 4 m) + a style into ordinary building parts, so the
// result can be edited piece by piece afterwards like anything a player built by hand.

export const STYLES = {
  cottage:  { label: 'Brick cottage',    wall: 'brick',      floor: 'floorwood', base: 'stonewall', roof: 'roofclay',  roofType: 'gable', trim: 'paint' },
  modern:   { label: 'Modern villa',     wall: 'plaster',    floor: 'concfloor', base: 'concrete',  roof: 'concrete',  roofType: 'flat',  shop: true },
  cabin:    { label: 'Timber cabin',     wall: 'wood',       floor: 'wooddark',  base: 'stonewall', roof: 'roofslate', roofType: 'gable' },
  farm:     { label: 'Stone farmhouse',  wall: 'stonewall',  floor: 'parquet',   base: 'stone',     roof: 'roofred',   roofType: 'hip' },
  villa:    { label: 'Mediterranean',    wall: 'sandstone',  floor: 'marbletile',base: 'sandstone', roof: 'roofclay',  roofType: 'hip' },
  office:   { label: 'Glass office',     wall: 'concrete',   floor: 'tiles',     base: 'concrete',  roof: 'concrete',  roofType: 'flat', glass: true },
};

const SH = 3.2; // storey height: 3 m walls + 0.2 m slab

// opts: { x0, z0, x1, z1, floors, style, roof, wall?, roofMat?, front: 0..3 (0 = +z, 1 = +x, 2 = -z, 3 = -x), baseY, furnish }
export function generateHouse(o) {
  const st = STYLES[o.style] || STYLES.cottage;
  const wallM = o.wall || st.wall, roofM = o.roofMat || st.roof, floorM = st.floor;
  const roofType = o.roof || st.roofType;
  const floors = Math.max(1, Math.min(3, o.floors | 0));
  const cx = (o.x0 + o.x1) / 2, cz = (o.z0 + o.z1) / 2;
  // build facing +z in a local frame, then turn it to face the requested side
  const rot = (o.front || 0) & 3;
  const swap = rot % 2 === 1;
  const W = swap ? o.z1 - o.z0 : o.x1 - o.x0;
  const D = swap ? o.x1 - o.x0 : o.z1 - o.z0;
  const x0 = -W / 2, z0 = -D / 2, x1 = W / 2, z1 = D / 2;
  const nx = W / 4, nz = D / 4;
  const out = [];
  const put = (t, x, y, z, ry = 0, extra = {}) => out.push({ t, x, y, z, ry, ...extra });

  const by = o.baseY;
  const F0 = by + 0.6;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    put('foundation', x0 + 2 + i * 4, by, z0 + 2 + j * 4, 0, { m: st.base });
    put('floor', x0 + 2 + i * 4, by + 0.4, z0 + 2 + j * 4, 0, { m: floorM });
  }
  const stairs = floors > 1;
  for (let k = 0; k < floors; k++) {
    const y = F0 + k * SH;
    const isGround = k === 0;
    const doorSeg = Math.floor(nx / 2);
    // front (+z) and back (-z) walls
    for (const [z, front] of [[z1, true], [z0, false]]) {
      for (let i = 0; i < nx; i++) {
        let t;
        if (st.glass) t = isGround && front && i === doorSeg ? 'wall_door' : 'glass_wall';
        else if (isGround && front && i === doorSeg) t = 'wall_door';
        else if (st.shop && isGround && front) t = 'wall_shop';
        else t = front || i % 2 === 1 ? 'wall_window' : 'wall';
        put(t, x0 + 2 + i * 4, y, z, 0, { m: st.glass ? (t === 'glass_wall' ? 'metal' : wallM) : wallM });
      }
    }
    // side walls
    for (const x of [x0, x1]) {
      for (let j = 0; j < nz; j++) {
        const t = st.glass ? 'glass_wall' : j % 2 === 0 && nz > 1 ? 'wall_window' : nz === 1 ? 'wall_window' : 'wall';
        put(t, x, y, z0 + 2 + j * 4, Math.PI / 2, { m: st.glass ? 'metal' : wallM });
      }
    }
    for (const x of [x0, x1]) for (const z of [z0, z1]) put('pillar', x, y, z, 0, { m: st.glass ? 'metal' : wallM, s: [0.75, 1, 0.75] });
    // the slab above this storey (with a stairwell over the stairs)
    if (k < floors - 1) {
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        if (stairs && i === 0 && j === 0) continue;
        put('floor', x0 + 2 + i * 4, y + 3.0, z0 + 2 + j * 4, 0, { m: floorM });
      }
      put('stairs', x0 + 0.85, y, z0 + 2.2, 0, { m: st.floor === 'concfloor' || st.glass ? 'concrete' : 'wooddark', s: [1, SH / 3, 1] });
      put('railing', x0 + 4, y + SH, z0 + 2, Math.PI / 2, { m: 'metal' });
    }
    if (o.furnish !== false) put('ceiling_light', 0, y + 2.92, nz > 1 ? 2 : 0);
  }
  // door leaf, swung open inward against the wall
  put('door', x0 + 2 + Math.floor(nx / 2) * 4 - 0.55, F0, z1 - 0.58, Math.PI / 2, { m: 'wooddark' });

  // roof
  const top = F0 + (floors - 1) * SH + 3;
  if (roofType === 'flat') {
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) put('floor', x0 + 2 + i * 4, top, z0 + 2 + j * 4, 0, { m: roofM });
    for (const [z] of [[z1], [z0]]) for (let i = 0; i < nx; i++) put('wall_half', x0 + 2 + i * 4, top + 0.2, z, 0, { m: wallM === 'concrete' || st.glass ? 'concrete' : wallM, s: [1, 0.8, 1] });
    for (const x of [x0, x1]) for (let j = 0; j < nz; j++) put('wall_half', x, top + 0.2, z0 + 2 + j * 4, Math.PI / 2, { m: wallM === 'concrete' || st.glass ? 'concrete' : wallM, s: [1, 0.8, 1] });
  } else if (roofType === 'hip') {
    put('roof_hip', 0, top, 0, 0, { m: roofM, s: [W / 4, Math.min(W, D) / 4 * 0.8, D / 4] });
  } else {
    // gable: ridge along the longer side
    const along = W >= D;
    const span = along ? D : W, len = along ? W : D;
    const h = span / 4 * 0.85;
    put('roof_gable', 0, top, 0, along ? 0 : Math.PI / 2, { m: roofM, s: [len / 4, h, span / 4] });
    // triangular end walls
    if (along) { for (const x of [x0, x1]) put('gable', x, top, 0, Math.PI / 2, { m: wallM, s: [span / 4, h, 1] }); }
    else { for (const z of [z0, z1]) put('gable', 0, top, z, 0, { m: wallM, s: [span / 4, h, 1] }); }
  }

  // furniture and a path to the door
  if (o.furnish !== false) {
    const doorX = x0 + 2 + Math.floor(nx / 2) * 4;
    put('m:Sofa_01', x1 - 2.4, F0, z0 + 1.0, 0);
    put('m:CoffeeTable_01', x1 - 2.4, F0, z0 + 2.4, 0);
    put('m:potted_plant_02', doorX + 1.3, F0, z1 - 0.7, 0);
    if (floors > 1) put('m:GothicBed_01', x1 - 1.4, F0 + SH, z0 + 1.6, 0);
    else if (W >= 12) put('m:GothicBed_01', x0 + 5.6, F0, z0 + 1.6, 0);
  }
  // front steps up to the door (the floor sits 0.6 m above the ground, more than one stride)
  {
    const doorX = x0 + 2 + Math.floor(nx / 2) * 4;
    put('stairs_wide', doorX, by, z1 + 1.5, Math.PI, { m: 'stonetiles', s: [0.6, 0.5, 1] });
    if (o.furnish !== false) {
      put('path', doorX, by, z1 + 5, 0, { m: 'pavers' });
      put('bollard', doorX - 1.3, by, z1 + 3.4, 0);
      put('bollard', doorX + 1.3, by, z1 + 3.4, 0);
    }
  }

  // turn to face the requested side and move into place
  const a = rot * Math.PI / 2;
  const c = Math.cos(a), s = Math.sin(a);
  for (const r of out) {
    const lx = r.x, lz = r.z;
    r.x = cx + lx * c + lz * s;
    r.z = cz - lx * s + lz * c;
    r.ry = (r.ry || 0) + a;
  }
  return out;
}
