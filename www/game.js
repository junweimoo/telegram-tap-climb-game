(() => {
  'use strict';

  // ------------------------------
  // Constants (tweakable)
  // ------------------------------
  const MAX_SEG = 8;           // number of vertical segments visible
  const SEG_HEIGHT = 150;        // logical px per segment (pre-DPR scaling)
  const WALL_WIDTH = 250;       // wall slab width (wider climbing area)
  const OBSTACLE_W = 56;        // overhang width on each side
  const HOLD_R = 10;            // hold radius
  const HOLD_MARGIN = 22;       // base inset of holds from the side
  const HOLD_JITTER_FRAC = 0.15; // ±15% horizontal jitter for holds
  // Rock wall edge meander parameters
  const WALL_CENTER_SHIFT_AMP = 12; // px
  const WALL_WIDTH_DELTA_AMP = 6;   // px

  const BASE_DECAY = 0.01;      // time per second to decay from 1 to 0
  const TIME_GAIN = 0.08;       // time refill on correct move (portion of full bar)
  const INPUT_LOCK_MS = 120;    // small lock to show reach animation
  const SCROLL_DURATION_S = 0.25; // time to complete one row scroll
  // Birds (ambient)
  const MIN_BIRD_INTERVAL = 6;     // seconds between flocks
  const MAX_BIRD_INTERVAL = 14;
  const BIRD_MIN_SPEED = 40;       // px/s
  const BIRD_MAX_SPEED = 90;       // px/s

  // Difficulty ramp
  const MIN_OBS_PROB = 0.55;    // baseline chance a segment has an obstacle (reduce 'none' segments)
  const MAX_OBS_PROB = 0.92;    // cap probability of an obstacle spawning
  const RAMP_SCORE_FOR_MAX = 80; // score at which probability hits cap (ramp faster)

  // State machine states
  const READY = 'READY';
  const PLAY = 'PLAY';
  const OVER = 'OVER';
  // Move climber/active row up the screen by ~20%
  const ACTIVE_ROW_BOTTOM_FRAC = 2 / 3 - 0.20; // active segment bottom higher (was 2/3)

  // Visual palette (lumberjack / natural)
  const PAL = {
    skyTop: '#e8f3ff',
    skyBottom: '#cde9ff',
    mountainDistant: '#eef5fb',
    mountainFar: '#d9e6f2',
    mountainMid: '#c3d6e4',
    mountainNear: '#b7cad8',
    pineFar: '#7aa58b',
    pineNear: '#44735c',
    pineDark: '#2f5a48',
    bushGreen: '#5d8c6b',
    // rock wall palette (replace wood)
    trunkA: '#8f97a3',
    trunkB: '#767d89',
    trunkShadow: '#5a616d',
    knot: '#3f454f',
    branch: '#6f7784',      // ledge base
    branchTip: '#9da5b1',   // ledge highlight
    hold: '#aab3bd',        // rock hold base
    shirt: '#0f5e8b',
    pants: '#3b4149',
    boots: '#0f172a',
    skin: '#f2c195',
    hair: '#5a3b2e',
    harness: '#f59e0b',
    rope: '#f97316'
  };

  // ------------------------------
  // DOM
  // ------------------------------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('scoreEl');
  const timeFill = document.getElementById('timeFill');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restartBtn');
  const finalWrap = document.getElementById('finalWrap');
  const finalMsg = document.getElementById('finalMsg');
  const finalScore = document.getElementById('finalScore');
  const bestScoreEl = document.getElementById('bestScore');
  const leftBtn = document.getElementById('leftBtn');
  const rightBtn = document.getElementById('rightBtn');

  // Cached resources (avoid per-frame allocations)
  let skyGradient = null;
  let wallGradient = null;
  const WALL_STEPS = 28;
  /** @type {number[]} */
  let wallYs = [];

  // ------------------------------
  // Canvas scaling
  // ------------------------------
  const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  // Dynamic logical viewport that matches the device screen (fits mobile dimensions)
  let VIEW_W = 360;
  let VIEW_H = 640;

  let screenW = 360, screenH = 640; // CSS pixels of the window

  function resizeCanvas() {
    const { innerWidth, innerHeight } = window;
    screenW = innerWidth;
    screenH = innerHeight;
    canvas.width = Math.floor(screenW * DPR);
    canvas.height = Math.floor(screenH * DPR);
    canvas.style.width = screenW + 'px';
    canvas.style.height = screenH + 'px';
    VIEW_W = screenW;
    VIEW_H = screenH;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    adjustSegmentsForViewport();
    // Rebuild cached gradients and wall Y-steps on resize
    buildCachesForViewport();
  }

  function applyViewTransform() {
    // For full-screen fit, we only need DPR scaling, no letterboxing
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  // defer calling resizeCanvas until state is initialized (below)
  window.addEventListener('resize', resizeCanvas);

  function buildCachesForViewport() {
    // Sky gradient (top→bottom) depends only on VIEW_H
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, PAL.skyTop);
    g.addColorStop(1, PAL.skyBottom);
    skyGradient = g;

    // Wall fill gradient depends only on VIEW_H
    const wg = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    wg.addColorStop(0, PAL.trunkA);
    wg.addColorStop(1, PAL.trunkB);
    wallGradient = wg;

    // Precompute evenly spaced Y samples for wall edges
    wallYs = new Array(WALL_STEPS + 1);
    for (let i = 0; i <= WALL_STEPS; i++) wallYs[i] = (i / WALL_STEPS) * VIEW_H;
  }

  // ------------------------------
  // Game state
  // ------------------------------
  /** @typedef {{ obstacle: 'left'|'right'|'none', jxL: number, jxR: number }} Segment */
  /** @type {Segment[]} */
  let segments = [];
  let maxSegDynamic = MAX_SEG;
  let score = 0;
  let bestScore = 0;
  try {
    const rawBest = localStorage.getItem('climbtap_best');
    bestScore = Number(rawBest || 0) || 0;
  } catch (_) {
    bestScore = 0;
  }
  let time = 1; // 0..1
  let state = READY;
  let lastTime = performance.now();
  let inputLockedUntil = 0;
  let reachSide = null; // 'left' | 'right' | null
  let scrollAnim = 0; // 0..1 progress of upward scroll after success
  let gameOverQueuedReason = '';
  let swayPhase = 0; // continuous time for sway
  let swayAmp = 0;   // px amplitude for sway
  // birds state (flocks)
  /** @type {{x:number,y:number,speed:number,count:number,scale:number,alpha:number,dir:1|-1}[]} */
  let flocks = [];
  let nextBirdAt = performance.now() + 2000;

  // Debug/reference overlay for fitting the climber model to an image
  let dbgWireframe = false;
  let refOverlayOn = false;
  /** @type {HTMLImageElement|null} */
  let refImage = null;
  let refScale = 1;
  let refOffsetX = 0;
  let refOffsetY = 0;
  let refAlpha = 0.5;
  let refAnchor = 'hips'; // 'hips' | 'shoulders' | 'center'

  // Load optional reference image from query string ?ref=<url> and ?debug=1
  (function initDebugRef() {
    try {
      const qs = new URLSearchParams(location.search);
      const refUrl = qs.get('ref');
      const debug = qs.get('debug');
      if (debug === '1' || debug === 'true') {
        dbgWireframe = true;
        refOverlayOn = !!refUrl;
      }
      if (refUrl) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { refImage = img; };
        img.onerror = () => { /* ignore */ };
        img.src = refUrl;
      }
      const anchor = qs.get('refAnchor');
      if (anchor === 'shoulders' || anchor === 'center' || anchor === 'hips') refAnchor = anchor;
      const s = Number(qs.get('refScale')); if (!Number.isNaN(s) && s > 0) refScale = s;
      const ax = Number(qs.get('refAlpha')); if (!Number.isNaN(ax)) refAlpha = Math.max(0, Math.min(1, ax));
    } catch (_) {}
  })();

  // Wall layout helpers
  function wallX() { return VIEW_W * 0.5 - WALL_WIDTH * 0.5; }
  function wallYForRow(rowIdx, offsetY = 0) {
    // Anchor active row bottom at VIEW_H * ACTIVE_ROW_BOTTOM_FRAC
    return VIEW_H * ACTIVE_ROW_BOTTOM_FRAC - (rowIdx + 1) * SEG_HEIGHT + offsetY;
  }

  function adjustSegmentsForViewport() {
    const needed = Math.max(6, Math.ceil(VIEW_H / SEG_HEIGHT));
    maxSegDynamic = needed;
    if (segments.length < needed) {
      const toAdd = needed - segments.length;
      for (let i = 0; i < toAdd; i++) segments.push(spawnSegment());
    } else if (segments.length > needed) {
      segments = segments.slice(segments.length - needed);
    }
  }

  // Now that state helpers are defined, size the canvas initially
  resizeCanvas();

  // ------------------------------
  // Utility
  // ------------------------------
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function vibrate(ms) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (_) {} }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function obstacleProbForScore(s) {
    const t = clamp01(s / RAMP_SCORE_FOR_MAX);
    return MIN_OBS_PROB + (MAX_OBS_PROB - MIN_OBS_PROB) * t;
  }

  function randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function spawnSegment(prev) {
    const prob = obstacleProbForScore(score);
    let obstacle = 'none';
    if (Math.random() < prob) {
      // avoid 3 of same side in a row to keep it fair-ish
      const last2 = segments.slice(-2).map(s => s.obstacle);
      const avoid = (last2[0] === last2[1]) ? last2[0] : null;
      const sides = avoid ? (avoid === 'left' ? ['right'] : ['left']) : ['left', 'right'];
      obstacle = randChoice(sides);
    }
    // store per-side inward jitter factors in [0,1]
    const jxL = Math.random();
    const jxR = Math.random();
    return { obstacle, jxL, jxR };
  }

  function resetGame() {
    score = 0;
    time = 1;
    segments = [];
    const need = Math.max(6, Math.ceil(VIEW_H / SEG_HEIGHT));
    for (let i = 0; i < need; i++) segments.push(spawnSegment());
    state = READY;
    reachSide = null;
    scrollAnim = 0;
    gameOverQueuedReason = '';
    updateHUD();
  }

  // ------------------------------
  // Input handling
  // ------------------------------
  function canInput() {
    return state === PLAY && performance.now() >= inputLockedUntil;
  }

  function handleMove(side) {
    if (!canInput()) return;
    inputLockedUntil = performance.now() + INPUT_LOCK_MS;
    reachSide = side; // for reach animation

    const bottom = segments[0];
    if (bottom.obstacle === side) {
      queueGameOver(`Overhang on ${side} — blocked!`);
      return;
    }

    // valid move
    score += 1;
    time = clamp01(time + TIME_GAIN);
    vibrate(20);
    // Add a little swing impulse
    swayAmp = Math.min(8, swayAmp + 3);

    // shift segments upward
    segments.shift();
    segments.push(spawnSegment(segments[segments.length - 1]));
    // trigger short upward scroll; if already scrolling, continue smoothly from current t
    scrollAnim = Math.min(1, scrollAnim + 0.5);
    updateHUD();
  }

  function handleStart() {
    if (state === READY || state === OVER) {
      state = PLAY;
      overlay.classList.remove('show');
      overlay.hidden = true;
      finalWrap.hidden = true;
      startBtn.hidden = true;
      restartBtn.hidden = true;
      time = 1; score = 0; updateHUD();
    }
  }

  function queueGameOver(reason) {
    gameOverQueuedReason = reason;
    state = OVER;
    endGame();
  }

  function endGame() {
    bestScore = Math.max(bestScore, score);
    try { localStorage.setItem('climbtap_best', String(bestScore)); } catch (_) {}
    finalScore.textContent = String(score);
    bestScoreEl.textContent = String(bestScore);
    finalMsg.textContent = gameOverQueuedReason || 'Game Over';
    finalWrap.hidden = false;
    overlay.hidden = false;
    overlay.classList.add('show');
    startBtn.hidden = true;
    restartBtn.hidden = false;
  }

  // ------------------------------
  // HUD Update
  // ------------------------------
  function updateHUD() {
    scoreEl.textContent = String(score);
    const danger = time <= 0.25;
    timeFill.style.setProperty('--fill', String(time));
    if (danger) timeFill.classList.add('danger'); else timeFill.classList.remove('danger');
  }

  // ------------------------------
  // Rendering helpers
  // ------------------------------
  function drawBackground() {
    // Sky gradient (cached)
    ctx.fillStyle = skyGradient || (function(){
      const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      g.addColorStop(0, PAL.skyTop); g.addColorStop(1, PAL.skyBottom); skyGradient = g; return g;
    })();
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Mountains
    function drawMountain(color, yFrac, jaggle, highlight) {
      ctx.fillStyle = color;
      const baseY = VIEW_H * yFrac;
      ctx.beginPath();
      ctx.moveTo(0, baseY);
      const steps = 8;
      const stepW = VIEW_W / steps;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = t * VIEW_W;
        const y = VIEW_H * (yFrac + Math.sin(t * Math.PI * 2 + jaggle) * 0.02);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(VIEW_W, VIEW_H);
      ctx.lineTo(0, VIEW_H);
      ctx.closePath();
      ctx.fill();

      // snow highlights on peaks
      ctx.fillStyle = highlight;
      for (let i = 0; i < 5; i++) {
        const px = (i + 0.2) / 5 * VIEW_W;
        const py = VIEW_H * (yFrac - 0.06) + Math.sin(i * 1.7 + jaggle) * 8;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - 18, py + 12);
        ctx.lineTo(px + 18, py + 12);
        ctx.closePath();
        ctx.globalAlpha = 0.25;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    drawMountain(PAL.mountainDistant, 0.48, 0.2, '#ffffff');
    drawMountain(PAL.mountainFar, 0.56, 0.5, '#ffffff');
    drawMountain(PAL.mountainMid, 0.62, 0.9, '#ffffff');
    drawMountain(PAL.mountainNear, 0.68, 1.3, '#ffffff');

    // Pine silhouettes
    function pine(x, baseY, scale, color) {
      ctx.fillStyle = color;
      const h = 60 * scale;
      const w = 22 * scale;
      ctx.beginPath();
      ctx.moveTo(x, baseY - h);
      ctx.lineTo(x - w, baseY);
      ctx.lineTo(x + w, baseY);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - w * 0.15, baseY, w * 0.3, h * 0.25);
    }
    const baseY = VIEW_H * 0.82;
    for (let i = -1; i <= 6; i++) pine((i * 80 + 40) % VIEW_W, baseY, 0.9, PAL.pineFar);
    for (let i = -2; i <= 6; i++) pine(((i * 90 + 10) % VIEW_W), baseY + 24, 1.2, PAL.pineNear);

    // Moving clouds (parallax, random drift)
    const t = performance.now() * 0.000015; // even slower clouds
    function cloud(cx, cy, s, a, wobble) {
      const dy = Math.sin(t * (0.6 + wobble)) * 3 * s;
      ctx.globalAlpha = a;
      ctx.fillStyle = 'white';
      ctx.beginPath();
      ctx.arc(cx, cy + dy, 14 * s, 0, Math.PI * 2);
      ctx.arc(cx + 16 * s, cy + 2 * s + dy, 18 * s, 0, Math.PI * 2);
      ctx.arc(cx - 18 * s, cy + 4 * s + dy, 16 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    const cY = VIEW_H * 0.18;
    for (let i = 0; i < 7; i++) {
      const speed = 4 + i * 4; // slow, layered
      const cx = (t * speed * VIEW_W + i * 260) % (VIEW_W + 360) - 180;
      cloud(cx, cY + (i % 2) * 22, 0.9 + i * 0.14, 0.08 + 0.05 * i, 0.3 + i * 0.1);
    }

    // animated bird flocks
    function drawBirdChevron(x, y, scale, alpha) {
      ctx.strokeStyle = `rgba(0,0,0,${alpha})`;
      ctx.lineWidth = 1.2 * scale;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 6 * scale, y - 3 * scale);
      ctx.moveTo(x, y);
      ctx.lineTo(x - 6 * scale, y - 3 * scale);
      ctx.stroke();
    }
    // advance and render active flocks
    for (let i = flocks.length - 1; i >= 0; i--) {
      const b = flocks[i];
      b.x += b.dir * b.speed * (1/60); // advance roughly per frame
      for (let k = 0; k < b.count; k++) {
        const bx = b.x + k * 12 * b.scale * b.dir;
        const by = b.y + Math.sin((b.x + k*10) * 0.02) * 2;
        drawBirdChevron(bx, by, b.scale, b.alpha);
      }
      if ((b.dir < 0 && b.x < -200) || (b.dir > 0 && b.x > VIEW_W + 200)) flocks.splice(i, 1);
    }

    // varied foreground trees (taller pines and a round tree)
    function tallPine(x, baseY, scale) {
      ctx.fillStyle = '#355e4b';
      const h = 90 * scale, w = 28 * scale;
      ctx.beginPath();
      ctx.moveTo(x, baseY - h);
      ctx.lineTo(x - w, baseY);
      ctx.lineTo(x + w, baseY);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - w * 0.12, baseY, w * 0.24, h * 0.3);
    }
    function roundTree(x, baseY, scale) {
      ctx.fillStyle = '#2d6a4f';
      ctx.beginPath(); ctx.arc(x, baseY - 22 * scale, 22 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#614a2a';
      ctx.fillRect(x - 4 * scale, baseY - 6 * scale, 8 * scale, 16 * scale);
    }
    function bush(x, baseY, scale) {
      ctx.fillStyle = PAL.bushGreen;
      ctx.beginPath();
      ctx.arc(x - 10 * scale, baseY - 6 * scale, 10 * scale, 0, Math.PI * 2);
      ctx.arc(x + 8 * scale, baseY - 8 * scale, 12 * scale, 0, Math.PI * 2);
      ctx.arc(x + 22 * scale, baseY - 4 * scale, 10 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    const fgY = VIEW_H * 0.92;
    // random-ish rows of trees
    for (let i = 0; i < 6; i++) {
      const px = (i * 0.14 + 0.06) * VIEW_W;
      const sway = Math.sin(i * 1.7) * 6;
      tallPine(px, fgY + (i % 2) * 6, 0.9 + (i % 3) * 0.2);
      bush(px + 30 + sway, fgY + 10, 0.8);
    }
    roundTree(VIEW_W * 0.88, fgY + 8, 1.25);
  }

  function drawWall(yOffset) {
    const x0 = wallX();
    // Irregular slab edges derived from a function of world Y, offset by camera scroll
    // Use scrollAnim to push the pattern down so wall appears to move up.
    // Static wall: no vertical pattern offset
    const patternOffsetY = 0;
    function centerShift(y) {
      // Disable horizontal meander; keep edges vertical
      return 0;
    }
    function widthDelta(y) {
      // Constant width: disable width meander
      return 0;
    }

    // Build the left and right edges as polylines
    const steps = WALL_STEPS;
    const ys = wallYs;
    const leftPts = [], rightPts = [];
    for (const y of ys) {
      const c = centerShift(y);
      const leftX = x0 + c;
      const rightX = leftX + WALL_WIDTH;
      leftPts.push({ x: leftX, y });
      rightPts.push({ x: rightX, y });
    }

    // Fill rock with gradient
    ctx.fillStyle = wallGradient || (function(){
      const wg = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      wg.addColorStop(0, PAL.trunkA); wg.addColorStop(1, PAL.trunkB); wallGradient = wg; return wg;
    })();
    ctx.beginPath();
    ctx.moveTo(leftPts[0].x, 0);
    for (let i = 1; i < leftPts.length; i++) ctx.lineTo(leftPts[i].x, leftPts[i].y);
    for (let i = rightPts.length - 1; i >= 0; i--) ctx.lineTo(rightPts[i].x, rightPts[i].y);
    ctx.closePath();
    ctx.fill();

    // Subtle static speckle/crack texture using deterministic RNG (no flicker)
    let seed = 12345 + Math.floor(patternOffsetY * 17);
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const speckles = 220;
    for (let i = 0; i < speckles; i++) {
      const ty = rnd() * VIEW_H;
      const t = ty / VIEW_H;
      // interpolate x across the meandering slab at this y
      const idx = Math.min(steps, Math.max(0, Math.round(t * steps)));
      const lx = leftPts[idx].x, rx = rightPts[idx].x;
      const px = lx + rnd() * (rx - lx);
      const r = 1 + rnd() * 2.4;
      ctx.fillStyle = `rgba(0,0,0,${0.05 + rnd()*0.06})`;
      ctx.beginPath(); ctx.ellipse(px, ty, r, r * (0.5 + rnd()*0.3), rnd()*Math.PI, 0, Math.PI * 2); ctx.fill();
    }

    // Light vertical stains
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const ty = (k * 0.22 + 0.18) * VIEW_H;
      const idx = Math.round((Math.max(0, Math.min(VIEW_H, ty)) / VIEW_H) * steps);
      const lx = leftPts[idx].x, rx = rightPts[idx].x;
      const sx = lx + (k === 1 ? 0.36 : 0.62) * (rx - lx);
      ctx.moveTo(sx, ty - 80);
      ctx.lineTo(sx, ty + 240);
    }
    ctx.stroke();
  }

  function drawSegment(seg, row, offsetY) {
    const x = wallX();
    const y = wallYForRow(row, offsetY);

    // faint horizontal rail
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 8, y + SEG_HEIGHT);
    ctx.lineTo(x + WALL_WIDTH - 8, y + SEG_HEIGHT);
    ctx.stroke();

    // branch-like overhang (now rock ledge)
    if (seg.obstacle !== 'none') {
      const by = y + SEG_HEIGHT - 20;
      ctx.fillStyle = PAL.branch;
      if (seg.obstacle === 'left') {
        // rock ledge with angled tip
        ctx.fillRect(x, by + 6, OBSTACLE_W, 8);
        ctx.beginPath();
        ctx.moveTo(x + OBSTACLE_W, by + 6);
        ctx.lineTo(x + OBSTACLE_W + 10, by + 1);
        ctx.lineTo(x + OBSTACLE_W + 3, by + 6);
        ctx.closePath();
        ctx.fillStyle = PAL.branchTip; ctx.fill();
      } else {
        ctx.fillRect(x + WALL_WIDTH - OBSTACLE_W, by + 6, OBSTACLE_W, 8);
        ctx.beginPath();
        ctx.moveTo(x + WALL_WIDTH - OBSTACLE_W, by + 6);
        ctx.lineTo(x + WALL_WIDTH - OBSTACLE_W - 10, by + 1);
        ctx.lineTo(x + WALL_WIDTH - OBSTACLE_W - 3, by + 6);
        ctx.closePath();
        ctx.fillStyle = PAL.branchTip; ctx.fill();
      }
    }

    // holds (rock nubbins), only on side without obstacle
    const ly = y + SEG_HEIGHT - 18;
    function rockHold(cx, cy, inwardFrac) {
      // place the hold anywhere between the wall edge and HOLD_MARGIN inward by ±15% of wall width
      // inwardFrac is 0..1; we remap to [-1,1] then scale by HOLD_JITTER_FRAC
      const side = (cx < x + WALL_WIDTH * 0.5) ? -1 : 1; // left or right
      const sign = side < 0 ? 1 : -1; // inward direction
      const offset = (inwardFrac - 0.5) * 2 * HOLD_JITTER_FRAC * WALL_WIDTH;
      const px = cx + sign * Math.abs(offset);
      // irregular rock blob
      ctx.fillStyle = PAL.hold;
      ctx.beginPath();
      ctx.moveTo(px, cy - HOLD_R * 0.8);
      ctx.quadraticCurveTo(px + HOLD_R * 0.9, cy - HOLD_R * 0.5, px + HOLD_R * 0.7, cy + HOLD_R * 0.1);
      ctx.quadraticCurveTo(px + HOLD_R * 0.1, cy + HOLD_R * 0.9, px - HOLD_R * 0.6, cy + HOLD_R * 0.2);
      ctx.quadraticCurveTo(px - HOLD_R * 0.9, cy - HOLD_R * 0.6, px, cy - HOLD_R * 0.8);
      ctx.closePath(); ctx.fill();
      // highlight
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.ellipse(px + HOLD_R*0.2, cy - HOLD_R*0.3, HOLD_R*0.35, HOLD_R*0.22, -0.6, 0, Math.PI*2); ctx.fill();
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(px - HOLD_R*0.2, cy + HOLD_R*0.25, HOLD_R*0.45, HOLD_R*0.18, 0.5, 0, Math.PI*2); ctx.fill();
      return px;
    }
    if (seg.obstacle !== 'left') rockHold(x + HOLD_MARGIN, ly, seg.jxL);
    if (seg.obstacle !== 'right') rockHold(x + WALL_WIDTH - HOLD_MARGIN, ly, seg.jxR);
  }

  // (moved limb/IK helpers to `climber.js` via delegation above)

  function drawClimber(offsetY) {
    // Delegate to Climber module
    const x = wallX();
    const params = {
      viewHeight: VIEW_H,
      wallWidth: WALL_WIDTH,
      centerX: x + WALL_WIDTH * 0.5,
      holdY: wallYForRow(0, offsetY) + SEG_HEIGHT - 18,
      segHeight: SEG_HEIGHT,
      // match the same placement used when drawing holds
      leftHoldX: (function(){
        const inwardFrac = segments[0]?.jxL || 0.5;
        const offset = (inwardFrac - 0.5) * 2 * HOLD_JITTER_FRAC * WALL_WIDTH;
        return x + HOLD_MARGIN + Math.abs(offset);
      })(),
      rightHoldX: (function(){
        const inwardFrac = segments[0]?.jxR || 0.5;
        const offset = (inwardFrac - 0.5) * 2 * HOLD_JITTER_FRAC * WALL_WIDTH;
        return x + WALL_WIDTH - HOLD_MARGIN - Math.abs(offset);
      })(),
      reachSide,
      inputLockedUntil,
      inputLockMs: INPUT_LOCK_MS,
      palette: PAL,
      swayPhase,
      swayAmp,
      // debug overlay parameters
      drawWireframe: dbgWireframe,
      refImage: refOverlayOn ? refImage : null,
      refScale,
      refOffsetX,
      refOffsetY,
      refAlpha,
      refAnchor
    };
    if (window.Climber && typeof window.Climber.draw === 'function') {
      window.Climber.draw(ctx, params);
    }
  }
  


  // ------------------------------
  // Game loop
  // ------------------------------
  function update(dt) {
    if (state === PLAY) {
      time -= BASE_DECAY * dt;
      if (time <= 0) {
        time = 0; updateHUD();
        queueGameOver('Pumped out!');
      } else {
        updateHUD();
      }
    }

    // scroll animation decay
    if (scrollAnim > 0) {
      const k = 1 / SCROLL_DURATION_S;
      scrollAnim = Math.max(0, scrollAnim - dt * k);
    }
    // sway dynamics
    swayPhase += dt * 2.2;
    swayAmp = Math.max(0, swayAmp - dt * 1.2);
    // birds spawn/update
    const now = performance.now();
    if (now >= nextBirdAt && state !== OVER) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const y = VIEW_H * (0.16 + Math.random() * 0.20);
      const speed = BIRD_MIN_SPEED + Math.random() * (BIRD_MAX_SPEED - BIRD_MIN_SPEED);
      const count = 3 + Math.floor(Math.random() * 5);
      const scale = 0.8 + Math.random() * 0.7;
      const alpha = 0.18 + Math.random() * 0.18;
      const x = dir < 0 ? VIEW_W + 200 : -200;
      flocks.push({ x, y, speed, count, scale, alpha, dir });
      const wait = (MIN_BIRD_INTERVAL + Math.random() * (MAX_BIRD_INTERVAL - MIN_BIRD_INTERVAL)) * 1000;
      nextBirdAt = now + wait;
    }
    // HUD already updated above when in PLAY state
  }

  function render() {
    // Clear entire canvas ignoring current transform
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Re-apply view transform after clearing
    applyViewTransform();
    // Smooth camera scroll with easing from up-offset back to settled position
    const t = scrollAnim;
    const eased = t * t * (3 - 2 * t); // smoothstep easing (ease-in-out)
    // Bias easing for a quicker start and slower settle to avoid perceived downward motion
    const easedBias = eased * 0.7 + (1 - Math.cos(Math.PI * t)) * 0.3; // blend with cosine ease-in
    const yOffset = -SEG_HEIGHT * easedBias; // start up, ease back to 0
    
    drawBackground();
    drawWall(yOffset);
    for (let i = 0; i < segments.length; i++) {
      drawSegment(segments[i], i, yOffset);
    }
    drawClimber(yOffset);
  }

  function loop(t) {
    const now = t || performance.now();
    const dt = Math.min(0.05, (now - lastTime) / 1000); // cap to avoid huge jumps
    lastTime = now;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ------------------------------
  // Inputs
  // ------------------------------
  function bindButton(btn, side) {
    let down = false;
    const press = (e) => { e.preventDefault(); down = true; handleMove(side); };
    const release = (e) => { e.preventDefault(); down = false; };
    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('touchend', release, { passive: false });
    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);
    btn.addEventListener('mouseleave', release);
  }
  bindButton(leftBtn, 'left');
  bindButton(rightBtn, 'right');

  const onStart = (e) => { if (state !== PLAY) { e.preventDefault(); handleStart(); } };
  const onRestart = (e) => { e.preventDefault(); resetGame(); handleStart(); };
  startBtn.addEventListener('click', onStart);
  startBtn.addEventListener('touchstart', onStart, { passive: false });
  restartBtn.addEventListener('click', onRestart);
  restartBtn.addEventListener('touchstart', onRestart, { passive: false });
  // Also allow tapping anywhere on the overlay to start (handy on mobile)
  overlay.addEventListener('click', onStart);
  overlay.addEventListener('touchstart', onStart, { passive: false });

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      if (state !== PLAY) { e.preventDefault(); resetGame(); handleStart(); }
      return;
    }
    if (k === 'a' || k === 'A' || k === 'ArrowLeft') { e.preventDefault(); handleMove('left'); }
    if (k === 'd' || k === 'D' || k === 'ArrowRight') { e.preventDefault(); handleMove('right'); }
    // debug toggles for fitting
    if (k === 'w' || k === 'W') { dbgWireframe = !dbgWireframe; }
    if (k === 'r' || k === 'R') { refOverlayOn = !refOverlayOn; }
    if (k === '[') { refScale = Math.max(0.05, refScale - 0.05); }
    if (k === ']') { refScale = Math.min(4, refScale + 0.05); }
    if (k === 'i' || k === 'I') { refOffsetY -= 5; }
    if (k === 'k' || k === 'K') { refOffsetY += 5; }
    if (k === 'j' || k === 'J') { refOffsetX -= 5; }
    if (k === 'l' || k === 'L') { refOffsetX += 5; }
    if (k === 'o' || k === 'O') { refAlpha = Math.max(0, refAlpha - 0.05); }
    if (k === 'p' || k === 'P') { refAlpha = Math.min(1, refAlpha + 0.05); }
  });

  // ------------------------------
  // Initialize
  // ------------------------------
  resetGame();
  // at start we show overlay in READY
  overlay.classList.add('show');
  startBtn.hidden = false;
  restartBtn.hidden = true;
  bestScoreEl.textContent = String(bestScore);

  // ------------------------------
  // Future Mini App submission stub
  // ------------------------------
  function submitScore(score, contestId) {
    // no-op for now
    // later: POST { initData, contestId, score } to backend
    // eslint-disable-next-line no-console
    console.log('submitScore()', { score, contestId });
  }
  window.ClimbTap = { submitScore };
})();


