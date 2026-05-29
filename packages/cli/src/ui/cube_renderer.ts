/**
 * cube_renderer.ts — pure algorithm, no Ink / React dependency.
 *
 * 1:1 port of the renderFrame() function in ai_com/cube_preview.html,
 * with the letter-layer (v2) stripped out per spec §0.
 *
 * Exports:
 *   createRenderer(opts: CubeRendererOpts): CubeRenderer
 *
 * The returned renderer holds closed-over z-buffer and char-buffer that
 * are reused across renderFrame() calls to avoid per-frame GC pressure.
 */

export interface CubeRendererOpts {
  width: number;
  height: number;
  /** Terminal cell aspect compensation (cell height / cell width). Default 0.5. */
  aspect?: number;
  /** ASCII shading gradient, darkest→brightest. Default '.,-~:;=!*#$@'. */
  gradient?: string;
  /** Ambient light coefficient. Default 0.25. */
  ambient?: number;
  /** Diffuse light coefficient. Default 0.75. */
  diffuse?: number;
  /** Light azimuth in degrees. Default 135. */
  lightAzimuth?: number;
  /** Light elevation in degrees. Default 35. */
  lightElevation?: number;
  /** Camera distance (perspective). Default 5.0. */
  K2?: number;
  /** Sampling step over each face surface (smaller = denser). Default 0.010. */
  step?: number;
}

export interface CubeRenderer {
  renderFrame(angles: { A: number; B: number; C: number }): string;
}

// --- Face descriptor --------------------------------------------------------

interface FaceDesc {
  axis: 'x' | 'y' | 'z';
  sign: 1 | -1;
}

// 6 cube faces: ±X, ±Y, ±Z.  Ordered to match the HTML source.
const FACES: readonly FaceDesc[] = [
  { axis: 'x', sign: +1 },  // +X
  { axis: 'x', sign: -1 },  // -X
  { axis: 'y', sign: +1 },  // +Y
  { axis: 'y', sign: -1 },  // -Y
  { axis: 'z', sign: +1 },  // +Z
  { axis: 'z', sign: -1 },  // -Z (initial front face)
];

const CHAR_SPACE = 32;

// --- Helpers ----------------------------------------------------------------

/** Compute the normalised light-direction vector from azimuth + elevation (degrees). */
function lightDirFromAngles(lh_deg: number, lv_deg: number): readonly [number, number, number] {
  const lh = (lh_deg * Math.PI) / 180;
  const lv = (lv_deg * Math.PI) / 180;
  return [Math.cos(lv) * Math.sin(lh), Math.sin(lv), Math.cos(lv) * Math.cos(lh)];
}

// --- Factory ----------------------------------------------------------------

export function createRenderer(opts: CubeRendererOpts): CubeRenderer {
  const W = opts.width;
  const H = opts.height;
  const aspect        = opts.aspect         ?? 0.5;
  const gradient      = opts.gradient       ?? '.,-~:;=!*#$@';
  const ambient       = opts.ambient        ?? 0.25;
  const diffuse       = opts.diffuse        ?? 0.75;
  const lightAzimuth  = opts.lightAzimuth   ?? 135;
  const lightElevation = opts.lightElevation ?? 35;
  const K2            = opts.K2             ?? 5.0;
  const step          = opts.step           ?? 0.010;

  const K1     = K2 * W * 0.30;
  const size   = W * H;
  const halfW  = W * 0.5;
  const halfH  = H * 0.5;
  const gradLen = gradient.length;

  // Light direction — constant across frames for fixed opts.
  const [ldx, ldy, ldz] = lightDirFromAngles(lightAzimuth, lightElevation);
  const lNorm = Math.sqrt(ldx * ldx + ldy * ldy + ldz * ldz) || 1;
  const lx = ldx / lNorm;
  const ly = ldy / lNorm;
  const lz = ldz / lNorm;

  // Cross-frame reusable buffers.
  // zbuf  — 1/z value per screen cell (0 = unwritten).
  // cbuf  — ASCII char code per screen cell.
  //
  // Uint16Array for cbuf keeps the door open for the v2 letter layer (FULL BLOCK U+2588),
  // which needs values > 127.  The strict-mode issue with noUncheckedIndexedAccess is
  // handled by going through DataView for write paths, letting the engine optimise reads
  // via a plain typed-array DataView wrapper — or, more simply, we just read/write through
  // explicit DataView to sidestep the `T | undefined` widening without non-null assertions
  // scattered throughout the hot path.  (DataView methods are always `number`, never
  // `number | undefined`.)
  const zbuf = new Float32Array(size);
  const cbuf = new Uint16Array(size);

  // DataView wrappers let us read/write typed-array elements without `noUncheckedIndexedAccess`
  // widening the return type to `T | undefined`.
  const zbufView = new DataView(zbuf.buffer);
  const cbufView = new DataView(cbuf.buffer);

  // Byte strides: Float32 = 4 bytes, Uint16 = 2 bytes.
  const F32 = 4;
  const U16 = 2;

  function renderFrame(angles: { A: number; B: number; C: number }): string {
    const { A, B, C } = angles;

    zbuf.fill(0);
    cbuf.fill(CHAR_SPACE);

    const cA = Math.cos(A), sA = Math.sin(A);
    const cB = Math.cos(B), sB = Math.sin(B);
    const cC = Math.cos(C), sC = Math.sin(C);

    for (const face of FACES) {
      const nlx0 = face.axis === 'x' ? face.sign : 0;
      const nly0 = face.axis === 'y' ? face.sign : 0;
      const nlz0 = face.axis === 'z' ? face.sign : 0;

      // Rotate the face normal through Rx(A) → Ry(B) → Rz(C) (inline-expanded).
      // Rx(A):
      let nx = nlx0;
      let ny = nly0 * cA - nlz0 * sA;
      let nz = nly0 * sA + nlz0 * cA;
      // Ry(B):
      const nx2 = nx * cB + nz * sB;
      const nz2 = -nx * sB + nz * cB;
      nx = nx2; nz = nz2;
      // Rz(C):
      const nx3 = nx * cC - ny * sC;
      const ny3 = nx * sC + ny * cC;
      nx = nx3; ny = ny3;

      // Back-face cull: skip faces whose rotated normal points away from camera.
      if (nz >= 0) continue;

      // Flat shading — one brightness value for every pixel on this face.
      const dot = nx * lx + ny * ly + nz * lz;
      const intensity = Math.min(1, ambient + diffuse * Math.max(0, dot));
      const charIdx = Math.max(0, Math.min(gradLen - 1, Math.floor(intensity * gradLen)));
      const shadingCode = gradient.charCodeAt(charIdx);

      // Rasterise the face surface by sampling (u, v) ∈ [-1, 1]².
      for (let u = -1; u <= 1.0001; u += step) {
        for (let v = -1; v <= 1.0001; v += step) {
          // Build the 3-D surface point for this (u, v).
          let px: number, py: number, pz: number;
          if (face.axis === 'x') { px = face.sign; py = u; pz = v; }
          else if (face.axis === 'y') { px = u; py = face.sign; pz = v; }
          else { px = u; py = v; pz = face.sign; }

          // Rotate point: Rx(A).
          const py1 = py * cA - pz * sA;
          const pz1 = py * sA + pz * cA;
          py = py1; pz = pz1;
          // Ry(B).
          const px2 = px * cB + pz * sB;
          const pz2 = -px * sB + pz * cB;
          px = px2; pz = pz2;
          // Rz(C).
          const px3 = px * cC - py * sC;
          const py3 = px * sC + py * cC;
          px = px3; py = py3;

          const z_total = K2 + pz;
          if (z_total <= 0.1) continue;
          const ooz = 1 / z_total;
          const xp = Math.round(halfW + K1 * px * ooz);
          const yp = Math.round(halfH - K1 * py * ooz * aspect);

          if (xp < 0 || xp >= W || yp < 0 || yp >= H) continue;

          const idx = yp * W + xp;
          // z-buffer epsilon: only overwrite if this sample is meaningfully closer.
          if (ooz > zbufView.getFloat32(idx * F32, true) + 0.0008) {
            zbufView.setFloat32(idx * F32, ooz, true);
            cbufView.setUint16(idx * U16, shadingCode, true);
          }
        }
      }
    }

    // Assemble output: W chars per row, H rows, each row terminated with '\n'.
    // Total length = W*H + H.
    const lines: string[] = new Array(H) as string[];
    for (let y = 0; y < H; y++) {
      const base = y * W;
      let row = '';
      for (let x = 0; x < W; x++) {
        row += String.fromCharCode(cbufView.getUint16((base + x) * U16, true));
      }
      lines[y] = row;
    }
    return lines.join('\n') + '\n';
  }

  return { renderFrame };
}
