(() => {
  'use strict';

  // Style configuration (proportion and radius multipliers). Tunable to match a reference image.
  let STYLE = {
    scale: 0.70, // global size vs VIEW_H
    proportions: {
      head: 0.078,
      shoulderHalf: 0.160,
      hipHalf: 0.112,
      torso: 0.335,
      upperArm: 0.305,
      forearm: 0.260,
      thigh: 0.350,
      shin: 0.360
    },
    radii: {
      bicep: 0.050,
      elbow: 0.040,
      wrist: 0.032,
      thigh: 0.058,
      knee: 0.050,
      shin: 0.052
    },
    elbowOutwardFrac: 0.06,     // elbows pushed outward beyond shoulders
    headYOffset: -0.16,         // head center vs shouldersY in H units
    sleeveLen: 0.075,
    sleeveDrop: 0.028,
    footSpread: 0.030,
    footYFromHips: 0.72,
    harnessWidthFrac: 0.34,
    harnessHeightFrac: 0.067,
    ropeWidthFrac: 0.017
  };

  function deepMerge(target, source) {
    if (!source) return target;
    for (const key of Object.keys(source)) {
      const sv = source[key];
      const tv = target[key];
      if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
        target[key] = deepMerge(tv && typeof tv === 'object' ? { ...tv } : {}, sv);
      } else {
        target[key] = sv;
      }
    }
    return target;
  }

  function draw(ctx, params) {
    const VIEW_H = params.viewHeight || 640;
    const WALL_WIDTH = params.wallWidth || 250;
    const centerX = params.centerX || 0;
    const holdY = params.holdY || 0;
    const SEG_H = params.segHeight || 150;
    const leftHoldX = params.leftHoldX != null ? params.leftHoldX : (centerX - WALL_WIDTH * 0.5 + 22);
    const rightHoldX = params.rightHoldX != null ? params.rightHoldX : (centerX + WALL_WIDTH * 0.5 - 22);
    const reachSide = params.reachSide || null;
    const inputLockedUntil = params.inputLockedUntil || 0;
    const inputLockMs = params.inputLockMs || 120;
    const PAL = params.palette || {};
    const swayPhase = params.swayPhase || 0;
    const swayAmp = params.swayAmp || 0;

    // tiny utils
    const P = (x, y) => ({ x, y });
    const L = (a, b, t) => a + (b - a) * t;
    const LP = (A, B, t) => P(L(A.x, B.x, t), L(A.y, B.y, t));
    function shade(hex, k) {
      if (!hex || typeof hex !== 'string') return hex;
      let h = hex.trim();
      if (h[0] === '#') h = h.slice(1);
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      if (h.length !== 6) return hex;
      let r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
      const t = k < 0 ? 0 : 255, p = Math.abs(k);
      r = Math.round(r + (t - r) * p);
      g = Math.round(g + (t - g) * p);
      b = Math.round(b + (t - b) * p);
      return `rgb(${r},${g},${b})`;
    }
    function tapered(A, B, rA, rB, color) {
      const ang = Math.atan2(B.y - A.y, B.x - A.x);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const nAx = -sa * rA, nAy = ca * rA;
      const nBx = -sa * rB, nBy = ca * rB;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(A.x + nAx, A.y + nAy);
      ctx.lineTo(B.x + nBx, B.y + nBy);
      ctx.arc(B.x, B.y, rB, ang - Math.PI/2, ang + Math.PI/2);
      ctx.lineTo(A.x - nAx, A.y - nAy);
      ctx.arc(A.x, A.y, rA, ang + Math.PI/2, ang - Math.PI/2);
      ctx.closePath(); ctx.fill();
    }
    function rrect(x, y, w, h, r, color) {
      const rr = Math.min(r, Math.abs(w/2), Math.abs(h/2));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + rr, y, rr);
      ctx.closePath(); ctx.fill();
    }
    function ellipse(x, y, rx, ry, rot, color) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
      ctx.fillStyle = color; ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // capsule helper used for limbs (delegates to tapered())
    function drawCapsule(_ctx, ax, ay, bx, by, rA, rB, color) {
      tapered(P(ax, ay), P(bx, by), rA, rB, color);
    }
    // --- tiny helpers ---
    function drawHand(ctx2, x, y, r, skin = '#f2bf99') {
      ctx2.beginPath(); ctx2.arc(x, y, r, 0, Math.PI * 2); ctx2.fillStyle = skin; ctx2.fill();
    }
    function drawShoe(ctx2, x, y, w, h, color = '#101318') {
      ctx2.beginPath(); ctx2.ellipse(x, y, w, h, 0, 0, Math.PI * 2); ctx2.fillStyle = color; ctx2.fill();
    }
    function line(x1, y1, x2, y2, width = 4, color = '#000') {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    function hingeIK(S, T, L1, L2, dir, eps = 6) {
      const dx = T.x - S.x, dy = T.y - S.y;
      let d = Math.hypot(dx, dy);
      const ux = (dx || 1) / (d || 1), uy = (dy || 1) / (d || 1);
      const maxD = Math.max(eps, L1 + L2 - eps);
      const minD = Math.max(eps, Math.abs(L1 - L2) + eps * 0.5);
      const dd = Math.min(maxD, Math.max(minD, d));
      const a = (L1*L1 - L2*L2 + dd*dd) / (2*dd);
      const h2 = Math.max(L1*L1 - a*a, 0);
      const h = Math.sqrt(h2);
      const px = S.x + ux * a;
      const py = S.y + uy * a;
      const nx = -uy, ny = ux;
      const J = P(px + nx * dir * h, py + ny * dir * h);
      return { J };
    }
    

    // layout
    // Global character scale
    const H = VIEW_H * 0.28 * (params.scale || STYLE.scale);
    const cx = centerX + Math.sin(swayPhase) * swayAmp;
    const leftHold = P(leftHoldX, holdY);
    const rightHold = P(rightHoldX, holdY);

    // proportions
    const HEAD_R = STYLE.proportions.head * H;
    // shoulders/hips half-widths; torso length
    const SHO_H = STYLE.proportions.shoulderHalf * H;
    const HIP_H = STYLE.proportions.hipHalf * H;
    const TORSO = STYLE.proportions.torso * H;
    // limb lengths
    const UARM = STYLE.proportions.upperArm * H;   // shoulder→elbow
    const FORE = STYLE.proportions.forearm * H;    // elbow→wrist
    const THIGH = STYLE.proportions.thigh * H;     // hip→knee
    const SHIN = STYLE.proportions.shin * H;       // knee→ankle
    // limb thicknesses
    const BICEP = STYLE.radii.bicep * H;           // upper-arm radius
    const ELBOW = STYLE.radii.elbow * H;           // elbow radius
    const WRIST = STYLE.radii.wrist * H;           // wrist radius (keep close to elbow)
    const THI = STYLE.radii.thigh * H;             // thigh radius
    const KNEE = STYLE.radii.knee * H;             // knee radius
    const SHI = STYLE.radii.shin * H;              // shin radius

    // anchors
    // Place shoulders so that arms can be nearly straight to the holds
    const SLx = cx - SHO_H; const SRx = cx + SHO_H;
    const armLen = UARM + FORE;
    const dxL = Math.abs(SLx - leftHold.x);
    const dxR = Math.abs(SRx - rightHold.x);
    const dyL = Math.sqrt(Math.max(armLen * armLen - dxL * dxL, 0));
    const dyR = Math.sqrt(Math.max(armLen * armLen - dxR * dxR, 0));
    const shouldersY = holdY + Math.min(dyL, dyR) * 0.98; // slight slack
    const hipsY = shouldersY + TORSO * 0.95;
    const SL = P(SLx, shouldersY), SR = P(SRx, shouldersY);
    const HL = P(cx - HIP_H, hipsY), HR = P(cx + HIP_H, hipsY);

    // palette
    const colSkin = PAL.skin || '#F1C7A7';
    const colHair = PAL.hair || '#5b432e';
    const colShirt = PAL.shirt || '#1f6fa3';
    const colPants = PAL.pants || '#3a4a66';
    const colHarness = PAL.harness || '#f4a629';
    const colRope = PAL.rope || '#f0612a';
    const colBoots = PAL.boots || '#111';

    // derived tints
    const skinHi = shade(colSkin, +0.09);
    const skinLo = shade(colSkin, -0.12);
    const shirtLo = shade(colShirt, -0.14);
    const shirtHi = shade(colShirt, +0.12);
    const pantsLo = shade(colPants, -0.15);
    const pantsHi = shade(colPants, +0.10);
    const ropeHi = shade(colRope, +0.12);

    ctx.save();
    // Optional reference image (for model fitting). Draw behind the character.
    if (params && params.refImage) {
      const img = params.refImage;
      const iw = img.naturalWidth || img.width || 1;
      const ih = img.naturalHeight || img.height || 1;
      const refScale = params.refScale != null ? params.refScale : 1;
      const refAlpha = params.refAlpha != null ? params.refAlpha : 0.5;
      const offX = params.refOffsetX || 0;
      const offY = params.refOffsetY || 0;
      const anchorSel = params.refAnchor || 'hips';
      let ax = cx, ay = hipsY;
      if (anchorSel === 'shoulders') { ax = cx; ay = shouldersY; }
      else if (anchorSel === 'center') { ax = cx; ay = (shouldersY + hipsY) * 0.5; }
      const drawH = H * refScale;
      const drawW = (iw / ih) * drawH;
      ctx.save();
      ctx.globalAlpha = refAlpha;
      ctx.drawImage(img, ax - drawW / 2 + offX, ay - drawH / 2 + offY, drawW, drawH);
      ctx.restore();
    }

    // shadow
    ellipse(cx, hipsY + 0.18 * H, 0.10 * H, 0.03 * H, 0, 'rgba(0,0,0,0.22)');

    // torso
    const topY = shouldersY - 0.05 * H, botY = hipsY + 0.02 * H;
    // slim torso for hang; slight taper to hips
    const topW = (SR.x - SL.x) * 0.98, botW = (HR.x - HL.x) * 0.90;
    ctx.fillStyle = colShirt;
    ctx.beginPath();
    ctx.moveTo(cx - topW / 2, topY);
    ctx.quadraticCurveTo(cx, topY - 0.09 * H, cx + topW / 2, topY);
    ctx.lineTo(cx + botW / 2, botY - 0.02 * H);
    ctx.quadraticCurveTo(cx, botY + 0.06 * H, cx - botW / 2, botY - 0.02 * H);
    ctx.closePath(); ctx.fill();

    // sleeves & deltoids
    const sleeveLen = 0.075 * H, sleeveDrop = 0.028 * H;
    ctx.fillStyle = colShirt;
    ctx.beginPath();
    ctx.moveTo(SL.x - 0.02*H, shouldersY - 0.01*H);
    ctx.lineTo(SL.x - sleeveLen, shouldersY + sleeveDrop);
    ctx.lineTo(SL.x + 0.02*H, shouldersY + sleeveDrop);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(SR.x + 0.02*H, shouldersY - 0.01*H);
    ctx.lineTo(SR.x + sleeveLen, shouldersY + sleeveDrop);
    ctx.lineTo(SR.x - 0.02*H, shouldersY + sleeveDrop);
    ctx.closePath(); ctx.fill();
    ellipse(SL.x, shouldersY + 0.01*H, 0.050*H, 0.030*H, 0, shade(colShirt, +0.09));
    ellipse(SR.x, shouldersY + 0.01*H, 0.050*H, 0.030*H, 0, shade(colShirt, +0.09));

    // draw harness behind limbs
    const beltW0 = STYLE.harnessWidthFrac * H, beltH0 = STYLE.harnessHeightFrac * H;
    rrect(cx - beltW0/2, hipsY - beltH0/2, beltW0, beltH0, beltH0 * 0.45, colHarness);
    // diagonal rope across torso
    ctx.lineCap = 'round';
    ctx.strokeStyle = colRope;
    ctx.lineWidth = Math.max(2.6, STYLE.ropeWidthFrac * H);
    ctx.beginPath();
    ctx.moveTo(cx - 0.10 * H, shouldersY + 0.02 * H);
    ctx.quadraticCurveTo(cx - 0.01 * H, hipsY - 0.10 * H, cx + 0.08 * H, hipsY + 0.00 * H);
    ctx.stroke();
    // down rope
    ctx.beginPath();
    ctx.moveTo(cx, hipsY + 0.02 * H);
    ctx.quadraticCurveTo(cx + Math.sin(swayPhase) * swayAmp * 0.5, hipsY + 0.16 * H, cx, hipsY + 0.38 * H);
    ctx.stroke();

    // === LEGS — draw before arms so arms are on top ===
    const footY0 = hipsY + STYLE.footYFromHips * H;         // lower than harness
    const footSpread0 = STYLE.footSpread * H;               // feet close together
    const LF0 = P(cx - footSpread0 + Math.sin(swayPhase + 0.25) * swayAmp * 0.10, footY0);
    const RF0 = P(cx + footSpread0 + Math.sin(swayPhase - 0.20) * swayAmp * 0.10, footY0);
    const { J: KL0a } = hingeIK(HL, LF0, THIGH, SHIN, +1, 2);
    const { J: KR0a } = hingeIK(HR, RF0, THIGH, SHIN, -1, 2);
    const midL0 = LP(HL, LF0, 0.48);
    const midR0 = LP(HR, RF0, 0.48);
    const bend0 = 0.18;
    const KLa = LP(KL0a, midL0, bend0);
    const KRa = LP(KR0a, midR0, bend0);
    // legs with capsules (pants + darker calves)
    drawCapsule(ctx, HL.x, HL.y, KLa.x, KLa.y, THI, KNEE, colPants);
    drawCapsule(ctx, KLa.x, KLa.y, LF0.x, LF0.y, KNEE, SHI, pantsLo);
    drawCapsule(ctx, HR.x, HR.y, KRa.x, KRa.y, THI, KNEE, colPants);
    drawCapsule(ctx, KRa.x, KRa.y, RF0.x, RF0.y, KNEE, SHI, pantsLo);

    // head
    // head centered slightly forward, typical for a hang
    const headC = P(cx + 0.000 * H, shouldersY + STYLE.headYOffset * H);
    ellipse(headC.x, headC.y, HEAD_R, HEAD_R, 0, colSkin);
    ctx.fillStyle = colHair;
    ctx.beginPath();
    ctx.arc(headC.x - HEAD_R * 0.12, headC.y - HEAD_R * 0.14, HEAD_R * 1.02, Math.PI * 0.95, Math.PI * 2.05);
    ctx.lineTo(headC.x + HEAD_R * 0.25, headC.y + HEAD_R * 0.24);
    ctx.quadraticCurveTo(headC.x, headC.y + HEAD_R * 0.15, headC.x - HEAD_R * 0.28, headC.y + HEAD_R * 0.24);
    ctx.closePath(); ctx.fill();

    // === ARMS — dead-hang U shape (elbows at head level, hands on holds) ===
    const tReach = Math.max(0, Math.min(1, 1 - (inputLockedUntil - performance.now()) / inputLockMs));
    const lGrip = 0.995 + 0.005 * (reachSide === 'left'  ? tReach : 0);
    const rGrip = 0.995 + 0.005 * (reachSide === 'right' ? tReach : 0);
    const Lh = LP(SL, leftHold,  lGrip);
    const Rh = LP(SR, rightHold, rGrip);

    // target elbow height & lateral offset (force elbows OUTSIDE the shoulders)
    const elbowY     = headC.y;                 // same vertical level as head center
    const outward    = STYLE.elbowOutwardFrac * H; // push a bit beyond shoulder line

    // helper: pick the elbow solution closest to a preferred target, then blend toward it
    function elbowWithPreference(Shoulder, Hand, dirA, dirB, pref, blend = 0.55) {
      const E1 = hingeIK(Shoulder, Hand, UARM, FORE, dirA, 4).J;
      const E2 = hingeIK(Shoulder, Hand, UARM, FORE, dirB, 4).J;
      const d1 = (E1.x - pref.x) * (E1.x - pref.x) + (E1.y - pref.y) * (E1.y - pref.y);
      const d2 = (E2.x - pref.x) * (E2.x - pref.x) + (E2.y - pref.y) * (E2.y - pref.y);
      const E  = d1 < d2 ? E1 : E2;
      // blend toward the preferred elbow target to enforce the U shape
      return LP(E, pref, blend);
    }

    const ELpref = P(SL.x - outward, elbowY);
    const ERpref = P(SR.x + outward, elbowY);

    // choose the outside solution, then bias to our U-shape targets
    const EL = elbowWithPreference(SL, Lh, +1, -1, ELpref, 0.60);
    const ER = elbowWithPreference(SR, Rh, -1, +1, ERpref, 0.60);

    // tiny safety clamps: keep elbows from creeping above head level or drifting inside shoulders
    EL.y = Math.max(EL.y, elbowY - 0.004 * H);
    ER.y = Math.max(ER.y, elbowY - 0.004 * H);
    EL.x = Math.min(EL.x, SL.x - outward * 0.3);
    ER.x = Math.max(ER.x, SR.x + outward * 0.3);

    // draw arms using capsules (tube-like, slight taper)
    drawCapsule(ctx, SL.x, SL.y, EL.x, EL.y, BICEP, ELBOW * 0.98, colSkin);
    drawCapsule(ctx, EL.x, EL.y, Lh.x, Lh.y, ELBOW * 0.98, WRIST, colSkin);
    drawCapsule(ctx, SR.x, SR.y, ER.x, ER.y, BICEP, ELBOW * 0.98, colSkin);
    drawCapsule(ctx, ER.x, ER.y, Rh.x, Rh.y, ELBOW * 0.98, WRIST, colSkin);

    // optional: small elbow caps so the joint reads clearly
    ellipse(EL.x, EL.y, ELBOW * 0.9, ELBOW * 0.7, 0, skinHi);
    ellipse(ER.x, ER.y, ELBOW * 0.9, ELBOW * 0.7, 0, skinHi);

    // HANDS (on top of arms)
    const handR = Math.max(3, WRIST * 0.95);
    drawHand(ctx, Lh.x, Lh.y, handR, colSkin);
    drawHand(ctx, Rh.x, Rh.y, handR, colSkin);

    // SHOES last (over calves)
    drawShoe(ctx, LF0.x, LF0.y + 3, 0.065 * H, 0.030 * H, colBoots);
    drawShoe(ctx, RF0.x, RF0.y + 3, 0.065 * H, 0.030 * H, colBoots);

    // (harness was drawn earlier to sit behind limbs)

    // Optional wireframe overlay for debugging/model fitting
    if (params && params.drawWireframe) {
      ctx.save();
      ctx.globalAlpha = 0.7;
      const wire = (x1,y1,x2,y2,c='#00e5ff') => line(x1,y1,x2,y2,2,c);
      const joint = (x,y,r=4,c='#00e5ff') => { ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fillStyle=c; ctx.fill(); };
      // arms
      wire(SL.x, SL.y, EL.x, EL.y);
      wire(EL.x, EL.y, Lh.x, Lh.y);
      wire(SR.x, SR.y, ER.x, ER.y);
      wire(ER.x, ER.y, Rh.x, Rh.y);
      // torso
      wire(SL.x, SL.y, SR.x, SR.y, '#8ef');
      wire(HL.x, HL.y, HR.x, HR.y, '#8ef');
      wire(cx, shouldersY, cx, hipsY, '#8ef');
      // legs
      wire(HL.x, HL.y, KLa.x, KLa.y, '#0ff');
      wire(KLa.x, KLa.y, LF0.x, LF0.y, '#0ff');
      wire(HR.x, HR.y, KRa.x, KRa.y, '#0ff');
      wire(KRa.x, KRa.y, RF0.x, RF0.y, '#0ff');
      // joints
      [SL,SR,EL,ER,Lh,Rh,HL,HR,KLa,KRa,LF0,RF0,headC].forEach(p=>joint(p.x,p.y,3));
      ctx.restore();
    }

    ctx.restore();
  }

  if (!window.Climber) window.Climber = {};
  window.Climber.draw = draw;
  window.Climber.setStyle = function setStyle(overrides) {
    STYLE = deepMerge({ ...STYLE }, overrides || {});
    return STYLE;
  };
})();

