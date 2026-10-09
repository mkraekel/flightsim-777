// Boeing 777-300ER exterior model (Team B).
//
// Primary: Flightradar24 fr24-3d-models b773.glb (FlightGear-derived, GPLv2), glTF 1.0,
// upgraded by Cesium on load. It has no landing gear, so a procedural gear set is added.
// Fallback: a procedural airliner made from Cesium geometry (fuselage, swept wings, tail,
// engines) if the download or parsing fails.
//
// Model space after Cesium's up-axis fix (upAxis: Y, forwardAxis: X):
//   X = right wing, Y = nose, Z = up  (verified visually, see docs/world.md)
// The glTF origin is not the CG; CG_MODEL is the CG position in model space (m).

import { computeBodyFrame } from './camera.js';

export const MODEL_URL = 'https://cdn.jsdelivr.net/gh/Flightradar24/fr24-3d-models@master/models/b773.glb';
export const MODEL_SOURCE = 'https://github.com/Flightradar24/fr24-3d-models';
const MODEL_LEN_NATIVE = 72.9;      // glTF nose..tail extent (m)
const MODEL_SCALE = 73.9 / MODEL_LEN_NATIVE; // stretch to the -300ER length
const CG_MODEL = [0, -3.0, -0.7];   // CG in model space (m, native scale)
// model space -> body (x fwd, y right, z down): body = [Ym, Xm, -Zm]
const M_BODY_MODEL = [0, 1, 0, 1, 0, 0, 0, 0, -1];

const C = () => window.Cesium;

/** 4x4 column-major Cesium matrix from ECEF rotation columns and translation. */
function setMatrix(m, c0, c1, c2, t) {
  m[0] = c0[0]; m[1] = c0[1]; m[2] = c0[2]; m[3] = 0;
  m[4] = c1[0]; m[5] = c1[1]; m[6] = c1[2]; m[7] = 0;
  m[8] = c2[0]; m[9] = c2[1]; m[10] = c2[2]; m[11] = 0;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

// ---------- procedural geometry (body frame: x fwd, y right, z down; origin = CG) ----------

function rotY90() { return C().Matrix3.fromRotationY(Math.PI / 2); }
function rotX90() { return C().Matrix3.fromRotationX(Math.PI / 2); }

function inst(geometry, color, translation, rot3, id) {
  const Cesium = C();
  const m = Cesium.Matrix4.fromRotationTranslation(rot3 || Cesium.Matrix3.IDENTITY,
    new Cesium.Cartesian3(translation[0], translation[1], translation[2]));
  return new Cesium.GeometryInstance({
    geometry, modelMatrix: m, id,
    attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
  });
}

function cyl(len, r1, r2, slices = 24) {
  const Cesium = C();
  return new Cesium.CylinderGeometry({ length: len, topRadius: r1, bottomRadius: r2 ?? r1, slices,
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT });
}
function box(dx, dy, dz) {
  const Cesium = C();
  return Cesium.BoxGeometry.fromDimensions({ dimensions: new Cesium.Cartesian3(dx, dy, dz),
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT });
}

function makePrimitive(instances) {
  const Cesium = C();
  return new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ flat: false, translucent: false }),
    asynchronous: false, allowPicking: false, shadows: Cesium.ShadowMode.ENABLED,
  });
}

/** Landing gear (the glb has none). Ground contact at body z = +CG height (5.0 m). */
function buildGear() {
  const Cesium = C();
  const tyre = Cesium.Color.fromCssColorString('#1c1c1c');
  const strut = Cesium.Color.fromCssColorString('#b9bcc0');
  const out = [];
  const wheelRot = rotX90(); // cylinder axis (z) -> body y (lateral)
  // main bogies: 3 axles x 2 wheels each side, wheel radius 0.66 m
  for (const s of [-1, 1]) {
    const y = 5.49 * s;
    out.push(inst(cyl(3.0, 0.22), strut, [-2.3, y, 2.85]));            // oleo
    out.push(inst(box(4.4, 0.3, 0.3), strut, [-2.6, y, 4.3]));          // bogie beam
    for (const dx of [-1.45, 0, 1.45]) for (const dy of [-0.7, 0.7]) {
      out.push(inst(cyl(0.5, 0.66), tyre, [-2.6 + dx, y + dy, 4.34], wheelRot));
    }
  }
  // nose gear: 2 wheels, radius 0.6 m
  out.push(inst(cyl(2.9, 0.16), strut, [28.6, 0, 2.9]));
  for (const dy of [-0.45, 0.45]) out.push(inst(cyl(0.4, 0.6), tyre, [28.6, dy, 4.4], wheelRot));
  return makePrimitive(out);
}

/** Very simple 777-ish airliner in body coordinates (used when the glb fails). */
function buildFallbackAirframe() {
  const Cesium = C();
  const white = Cesium.Color.fromCssColorString('#e9ecef');
  const grey = Cesium.Color.fromCssColorString('#9aa1a8');
  const dark = Cesium.Color.fromCssColorString('#4a5056');
  const blue = Cesium.Color.fromCssColorString('#1f4f8f');
  const out = [];
  const alongX = rotY90();
  // fuselage (nose at x = +33, tail at -41), radius 3.1, centre z = -0.4
  out.push(inst(cyl(62, 3.1), white, [-3.5, 0, -0.4], alongX));
  out.push(inst(cyl(6, 0.6, 3.1), white, [30.5, 0, -0.1], alongX));           // nose cone
  out.push(inst(cyl(9, 3.1, 0.7), white, [-39, 0, -1.1], alongX));            // tail cone (tapers aft)
  out.push(inst(box(3.2, 0.4, 0.3), dark, [30.6, 0, -1.8]));                  // cockpit windows strip
  // wings: swept 31.6 deg, semi-span 30 m from root
  for (const s of [-1, 1]) {
    const sweep = Cesium.Matrix3.fromRotationZ(-s * 31.6 * Math.PI / 180);
    out.push(inst(box(8.5, 30, 0.7), grey, [-3.5 - 9.0, s * 16.5, 1.2], sweep));
    out.push(inst(cyl(7.0, 1.7, 1.55), dark, [4.5, s * 9.7, 2.4], alongX));   // GE90 nacelle
    // horizontal stabilizer
    const hs = Cesium.Matrix3.fromRotationZ(-s * 35 * Math.PI / 180);
    out.push(inst(box(5.0, 10.5, 0.35), grey, [-37.5, s * 5.6, -1.6], hs));
  }
  // fin
  const fin = Cesium.Matrix3.fromRotationY(-38 * Math.PI / 180);
  out.push(inst(box(9.5, 0.5, 10.5), blue, [-37.5, 0, -7.6], fin));
  return makePrimitive(out);
}

/**
 * The glTF 1.0 -> 2.0 upgrade in Cesium binds the wrong texture/UV set for this model
 * (fuselage renders with red/green/black patches). Work-around: pull the paint atlas out
 * of the .glb ourselves and sample it through a CustomShader with TEXCOORD_0.
 */
async function applyLiveryFix(model) {
  const Cesium = C();
  const buf = await (await fetch(MODEL_URL)).arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const img = json.images?.paint1_png || Object.values(json.images || {})[0];
  const ext = img?.extensions?.KHR_binary_glTF;
  if (!ext) throw new Error('no embedded paint texture');
  const view = json.bufferViews[ext.bufferView];
  const bytes = new Uint8Array(buf, 20 + jsonLen + (view.byteOffset || 0), view.byteLength);
  const url = URL.createObjectURL(new Blob([bytes], { type: ext.mimeType || 'image/jpeg' }));
  model.customShader = new Cesium.CustomShader({
    uniforms: { u_paint: { type: Cesium.UniformType.SAMPLER_2D, value: new Cesium.TextureUniform({ url }) } },
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        vec3 paint = texture(u_paint, fsInput.attributes.texCoord_0).rgb;
        material.diffuse = paint;
        material.specular = vec3(0.25);
        material.roughness = 0.45;
      }`,
  });
}

/**
 * Create the aircraft visual. Returns { pose(sim), setVisible(b), primitives:[...] , source }.
 */
export async function createAircraftModel(viewer, { shadows = true } = {}) {
  const Cesium = C();
  const scene = viewer.scene;
  const handle = { source: 'loading', primitives: [], visible: true };
  const gear = scene.primitives.add(buildGear());
  handle.primitives.push(gear);
  const frame = {};
  const mGlb = new Cesium.Matrix4(), mBody = new Cesium.Matrix4();
  let glb = null, fallback = null;

  try {
    viewer.creditDisplay?.addStaticCredit?.(new Cesium.Credit(
      `<a href="${MODEL_SOURCE}" target="_blank" rel="noopener">777 model: Flightradar24 / FlightGear (GPLv2)</a>`, true));
  } catch (e) { /* credits are best effort */ }

  const useFallback = (why) => {
    if (fallback) return;
    console.warn('[model777] using procedural airliner:', why);
    fallback = scene.primitives.add(buildFallbackAirframe());
    handle.primitives.push(fallback);
    handle.source = 'procedural';
    if (glb) glb.show = false;
  };

  try {
    glb = await Promise.race([
      Cesium.Model.fromGltfAsync({
        url: MODEL_URL, upAxis: Cesium.Axis.Y, forwardAxis: Cesium.Axis.X,
        minimumPixelSize: 0, scale: 1,
        shadows: shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED,
        backFaceCulling: true,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('model load timeout')), 20000)),
    ]);
    scene.primitives.add(glb);
    handle.primitives.push(glb);
    handle.source = 'glb';
    glb.errorEvent?.addEventListener((err) => useFallback(err));
    applyLiveryFix(glb).catch((e) => console.warn('[model777] livery fix skipped', e));
  } catch (err) {
    useFallback(err);
  }

  handle.pose = (sim) => {
    const fr = computeBodyFrame(sim, frame);
    // ECEF directions of the body axes
    const bx = fr.bodyToEcef([1, 0, 0]), by = fr.bodyToEcef([0, 1, 0]), bz = fr.bodyToEcef([0, 0, 1]);
    const p = [fr.pos.x, fr.pos.y, fr.pos.z];
    setMatrix(mBody, bx, by, bz, p);
    // glb: columns = ECEF images of model X (=body y), Y (=body x), Z (=-body z), scaled
    const s = MODEL_SCALE;
    const cx = by.map((v) => v * s), cy = bx.map((v) => v * s), cz = bz.map((v) => -v * s);
    // translation so that the CG (model space) lands on the aircraft position
    const cg = CG_MODEL;
    const t = [0, 1, 2].map((i) => p[i] - (cx[i] * cg[0] + cy[i] * cg[1] + cz[i] * cg[2]));
    setMatrix(mGlb, cx, cy, cz, t);
    if (glb) glb.modelMatrix = mGlb;
    if (fallback) fallback.modelMatrix = mBody;
    const gearDown = (sim.surfaces?.gear ?? 1) > 0.5;
    gear.modelMatrix = mBody;
    gear.show = handle.visible && gearDown;
    if (glb) glb.show = handle.visible && !fallback;
    if (fallback) fallback.show = handle.visible;
    return fr;
  };
  handle.setVisible = (b) => { handle.visible = !!b; };
  handle.exclude = () => handle.primitives;
  return handle;
}

export { M_BODY_MODEL, CG_MODEL, MODEL_SCALE };
