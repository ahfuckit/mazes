// maze.js

// DOM references
const canvas = document.getElementById("canvas");
const widthIn = document.getElementById("widthIn");
const heightIn = document.getElementById("heightIn");
const regenBtn = document.getElementById("regen");
const resetBtn = document.getElementById("reset");
const undoBtn = document.getElementById("undo");
const revChk = document.getElementById("rev");
const hintBtn = document.getElementById("hint");
const deadHintBtn = document.getElementById("deadHint");
const diffSel = document.getElementById("difficulty");
const scoreEl = document.getElementById("score");
const progressEl = document.getElementById("progress");
const timerEl = document.getElementById("timer");
const highEl = document.getElementById("highscore");
const coachBtn = document.getElementById("coachBtn");
const coachDialog = document.getElementById("coachDialog");
const closeCoach = document.getElementById("closeCoach");

// Canvas context with wide-gamut attempt
let ctx =
  canvas.getContext("2d", { alpha: false, colorSpace: "display-p3" }) ||
  canvas.getContext("2d", { alpha: false }) ||
  canvas.getContext("2d");

if (!ctx) {
  throw new Error("Unable to acquire 2D canvas context");
}

// Worker (module worker modern pattern) - safe creation
let astarWorker = null;
let bfsWorker = null;

if (typeof Worker !== "undefined") {
  try {
    astarWorker = new Worker(new URL("./astar-worker.js", import.meta.url), {
      type: "module",
    });
  } catch (err) {
    console.warn("A* worker could not be created; disabling hints.", err);
    astarWorker = null;
  }

  try {
    bfsWorker = new Worker(new URL("./bfs-worker.js", import.meta.url), {
      type: "module",
    });
  } catch (err) {
    console.warn("BFS worker could not be created; disabling dead-end hints.", err);
    bfsWorker = null;
  }
}

// Audio (lazy-init for user-gesture friendliness)
let audioCtx = null;

function ensureAudioCtx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playBeep(freq = 880, duration = 0.07) {
  const ac = ensureAudioCtx();
  if (!ac) return;

  try {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.value = 0.00001;
    osc.connect(gain).connect(ac.destination);
    const now = ac.currentTime;
    osc.start(now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.00001, now + duration);
    osc.stop(now + duration + 0.02);
  } catch (err) {
    console.warn("Audio play failed", err);
  }
}

// Shared state
const state = {
  cols: Math.max(7, Number(widthIn.value) || 21),
  rows: Math.max(7, Number(heightIn.value) || 21),
  cellSize: 24,
  dpr: Math.max(1, window.devicePixelRatio || 1),
  maze: null, // 2D array of MazeCell
  player: null, // Player instance
  start: null,
  end: null,
  originalPathCount: 0,
  visitedCount: 0,
  undoStack: [],
  score: 0,
  highscore: Number(localStorage.getItem("MazeHighscore") || 0),
  startTime: 0,
  pausedElapsed: 0,
  timerTick: null,
  animations: [],
  particles: [],
  dirtySet: new Set(), // legacy; still used in a few places
  hintPath: null,
  hintTimeout: null,
};

highEl.textContent = state.highscore;

// Classes
class MazeCell {
  constructor(type = "wall") {
    this.type = type; // 'wall' or 'path'
    this.filled = false;
    this.deadEnd = false;
  }
}

class Player {
  constructor(gridX, gridY, cellSize, speedCellsPerSec = 6.5) {
    this.gridX = gridX;
    this.gridY = gridY;
    this.cellSize = cellSize;
    this.speed = speedCellsPerSec;
    this.x = gridX * cellSize;
    this.y = gridY * cellSize;
    this.targetX = this.x;
    this.targetY = this.y;
  }
  setCellSize(cs) {
    this.cellSize = cs;
    this.x = this.gridX * cs;
    this.y = this.gridY * cs;
    this.targetX = this.x;
    this.targetY = this.y;
  }
  moveToGrid(nx, ny) {
    this.gridX = nx;
    this.gridY = ny;
    this.targetX = nx * this.cellSize;
    this.targetY = ny * this.cellSize;
  }
  update(dt) {
    const step = this.speed * this.cellSize * dt;
    if (Math.abs(this.targetX - this.x) > step) {
      this.x += Math.sign(this.targetX - this.x) * step;
    } else {
      this.x = this.targetX;
    }
    if (Math.abs(this.targetY - this.y) > step) {
      this.y += Math.sign(this.targetY - this.y) * step;
    } else {
      this.y = this.targetY;
    }
  }
  render(ctx2d) {
    const rOuter = this.cellSize * 0.33;
    const cx = this.x + this.cellSize / 2;
    const cy = this.y + this.cellSize / 2;

    ctx2d.fillStyle = "#fff65c";
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx2d.fill();

    ctx2d.fillStyle = "rgba(0,0,0,0.12)";
    ctx2d.beginPath();
    ctx2d.arc(
      cx - this.cellSize * 0.06,
      cy - this.cellSize * 0.06,
      this.cellSize * 0.07,
      0,
      Math.PI * 2
    );
    ctx2d.fill();
  }
}

// Particles treat x/y as pixel coordinates
class Particle {
  constructor(px, py, cellSize) {
    this.px = px;
    this.py = py;
    const angle = Math.random() * Math.PI * 2;
    const speed = (0.08 + Math.random() * 0.2) * cellSize;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed - 0.02 * cellSize;
    this.life = 600 + Math.random() * 300; // ms
    this.age = 0;
    this.color = ["#ffd26a", "#ff9b9b", "#9bf3c6", "#d0a0ff"][
      Math.floor(Math.random() * 4)
    ];
    this.size = Math.max(2, cellSize * 0.12);
  }
  update(dt) {
    this.px += this.vx * dt;
    this.py += this.vy * dt;
    this.age += dt * 1000;
    return this.age < this.life;
  }
  render(ctx2d, alpha = 1) {
    const a = Math.max(0, 1 - this.age / this.life) * alpha;
    ctx2d.globalAlpha = a;
    ctx2d.fillStyle = this.color;
    ctx2d.beginPath();
    ctx2d.arc(this.px, this.py, this.size, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.globalAlpha = 1;
  }
}

// Helpers
const cellKey = (x, y) => `${x},${y}`;
const inBounds = (x, y) =>
  x >= 0 && y >= 0 && x < state.cols && y < state.rows;

function markDirty(x, y) {
  state.dirtySet.add(cellKey(x, y));
}

function markAllDirty() {
  state.dirtySet.clear();
  if (!state.maze) return;
  for (let y = 0; y < state.maze.length; y++) {
    for (let x = 0; x < state.maze[y].length; x++) {
      markDirty(x, y);
    }
  }
}

// Generic dead-end recompute helper for an existing maze
function recomputeAllDeadEnds() {
  if (!state.maze) return;

  state.originalPathCount = 0;

  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const cell = state.maze[y][x];
      cell.deadEnd = false;
      if (cell.type === "path") {
        state.originalPathCount++;
        let count = 0;
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].forEach(([dx, dy]) => {
          const nx = x + dx;
          const ny = y + dy;
          if (inBounds(nx, ny) && state.maze[ny][nx].type === "path") count++;
        });

        const isStart =
          state.start && x === state.start.x && y === state.start.y;
        const isEnd = state.end && x === state.end.x && y === state.end.y;
        cell.deadEnd = count === 1 && !isStart && !isEnd;
      }
    }
  }
}

// Maze generation
function generateMazeIterative() {
  if (state.cols % 2 === 0) state.cols++;
  if (state.rows % 2 === 0) state.rows++;

  const maze = Array.from({ length: state.rows }, () =>
    Array.from({ length: state.cols }, () => new MazeCell("wall"))
  );

  const sx = 1;
  const sy = 1;
  maze[sy][sx].type = "path";
  const stack = [[sx, sy]];

  const preset =
    {
      easy: { shuffle: 0.25, extra: 0.02, deadBoost: 0.9 },
      normal: { shuffle: 0.45, extra: 0.04, deadBoost: 1.0 },
      hard: { shuffle: 0.65, extra: 0.06, deadBoost: 1.2 },
      cruel: { shuffle: 0.85, extra: 0.08, deadBoost: 1.4 },
    }[diffSel.value] || { shuffle: 0.45, extra: 0.04, deadBoost: 1.0 };

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    let dirs = [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    let carved = false;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (
        nx > 0 &&
        nx < state.cols - 1 &&
        ny > 0 &&
        ny < state.rows - 1 &&
        maze[ny][nx].type === "wall"
      ) {
        maze[cy + dy / 2][cx + dx / 2].type = "path";
        maze[ny][nx].type = "path";
        stack.push([nx, ny]);
        carved = true;
        break;
      }
    }
    if (!carved) stack.pop();
  }

  const extra = Math.floor(state.cols * state.rows * preset.extra);
  for (let i = 0; i < extra; i++) {
    const rx = 1 + Math.floor(Math.random() * (state.cols - 2));
    const ry = 1 + Math.floor(Math.random() * (state.rows - 2));
    if (Math.random() < preset.shuffle) maze[ry][rx].type = "path";
  }

  state.start = { x: 1, y: 1 };
  state.end = { x: state.cols - 2, y: state.rows - 2 };
  maze[state.start.y][state.start.x].type = "path";
  maze[state.end.y][state.end.x].type = "path";

  state.maze = maze;

  recomputeAllDeadEnds();

  state.player = new Player(state.start.x, state.start.y, state.cellSize, 6.5);
  state.visitedCount = 1;
  state.undoStack = [];
  state.animations = [];
  state.particles = [];
  state.hintPath = null;
  state.score = 0;

  state.startTime = Date.now();
  state.pausedElapsed = 0;
  if (state.timerTick) clearInterval(state.timerTick);
  state.timerTick = setInterval(updateTimer, 250);

  undoBtn.disabled = true;
  markAllDirty();
  updateHUD();
}

function currentPathCount() {
  let c = 0;
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const cell = state.maze[y][x];
      if (cell.type === "path" && !cell.filled) c++;
    }
  }
  return c;
}

// Canvas sizing
function resizeCanvas() {
  const pad = 64;
  const avail = Math.min(
    window.innerWidth - pad,
    window.innerHeight - pad - 80
  );
  const px = Math.max(240, Math.floor(avail));
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  canvas.width = Math.floor(px * state.dpr);
  canvas.height = Math.floor(px * state.dpr);
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

  const maxCells = Math.max(state.cols, state.rows);
  state.cellSize = Math.max(6, Math.floor(px / maxCells));
  if (state.player) state.player.setCellSize(state.cellSize);
}

// Rendering (guarded)
function drawCell(x, y) {
  const row = state.maze?.[y];
  if (!row) return;
  const cell = row[x];
  if (!cell) return;

  const cs = state.cellSize;
  const px = x * cs;
  const py = y * cs;

  if (cell.type === "wall" || cell.filled) {
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(px, py, cs, cs);
  } else {
    ctx.fillStyle = "#e8f3f0";
    ctx.fillRect(px, py, cs, cs);

    if (cell.deadEnd) {
      ctx.fillStyle = "#d07fff";
      const r = Math.max(1, cs * 0.12);
      ctx.beginPath();
      ctx.arc(px + cs / 2, py + cs / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (state.end && x === state.end.x && y === state.end.y) {
    ctx.fillStyle = "#ff8b00";
    ctx.fillRect(px, py, cs, cs);
  }
}

let lastFrameTime = performance.now();

function frame(now) {
  const dt = Math.max(0, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  if (state.player) state.player.update(dt);

  // animations
  for (let i = state.animations.length - 1; i >= 0; i--) {
    const a = state.animations[i];
    const t = Math.min(1, (now - a.start) / a.dur);
    markDirty(a.x, a.y);
    if (t >= 1) state.animations.splice(i, 1);
  }

  // particles
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    if (!p.update(dt)) {
      state.particles.splice(i, 1);
    }
  }

  // full redraw each frame
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.maze) {
    const rows = state.maze.length;
    for (let y = 0; y < rows; y++) {
      const cols = state.maze[y].length;
      for (let x = 0; x < cols; x++) {
        drawCell(x, y);
      }
    }
  }

  // fill animations overlay
  for (const a of state.animations) {
    const t = Math.min(1, (now - a.start) / a.dur);
    const px = a.x * state.cellSize;
    const py = a.y * state.cellSize;
    ctx.fillStyle = `rgba(0,0,0,${t})`;
    ctx.fillRect(px, py, state.cellSize, state.cellSize);
  }

  // hint path
  if (state.hintPath) {
    ctx.lineWidth = Math.max(2, state.cellSize * 0.12);
    ctx.strokeStyle = "rgba(0,120,255,0.9)";
    ctx.beginPath();
    for (let i = 0; i < state.hintPath.length; i++) {
      const [x, y] = state.hintPath[i];
      const cx = x * state.cellSize + state.cellSize / 2;
      const cy = y * state.cellSize + state.cellSize / 2;
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }

  // particles
  for (const p of state.particles) {
    p.render(ctx);
  }

  // player
  if (state.player) state.player.render(ctx);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Movement & game rules
function isWalkable(x, y) {
  if (!inBounds(x, y)) return false;
  const c = state.maze[y][x];
  return c.type === "path" && !c.filled;
}

function recomputeDeadendsNear(x, y) {
  const coords = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ];
  for (const [dx, dy] of coords) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny)) continue;
    const c = state.maze[ny][nx];
    if (c.type !== "path" || c.filled) {
      c.deadEnd = false;
      continue;
    }
    let cnt = 0;
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].forEach(([ddx, ddy]) => {
      const ax = nx + ddx;
      const ay = ny + ddy;
      if (
        inBounds(ax, ay) &&
        state.maze[ay][ax].type === "path" &&
        !state.maze[ay][ax].filled
      )
        cnt++;
    });

    const isStart =
      state.start && nx === state.start.x && ny === state.start.y;
    const isEnd = state.end && nx === state.end.x && ny === state.end.y;
    c.deadEnd = cnt === 1 && !isStart && !isEnd;

    markDirty(nx, ny);
  }
}

// spawn particles at cell center in pixels
function spawnParticles(cellX, cellY, count = 8) {
  const px = (cellX + 0.5) * state.cellSize;
  const py = (cellY + 0.5) * state.cellSize;
  for (let i = 0; i < count; i++) {
    const p = new Particle(px, py, state.cellSize);
    state.particles.push(p);
  }
}

function updateHUD() {
  scoreEl.textContent = state.score;
  const current = currentPathCount();
  const filled = Math.max(0, state.originalPathCount - current);
  const pct = Math.round((filled / (state.originalPathCount || 1)) * 100);
  progressEl.textContent = `${Math.min(100, Math.max(0, pct))}%`;
}

function updateTimer() {
  const elapsedMs = Date.now() - state.startTime + state.pausedElapsed;
  const s = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  timerEl.textContent = `${mm}:${ss}`;
}

// View Transition helper
const supportsViewTransition =
  typeof document.startViewTransition === "function";

function withViewTransition(fn) {
  if (supportsViewTransition) {
    document.startViewTransition(() => {
      fn();
    });
  } else {
    fn();
  }
}

function attemptMove(dx, dy) {
  const nx = state.player.gridX + dx;
  const ny = state.player.gridY + dy;
  if (!isWalkable(nx, ny)) return;

  const prevX = state.player.gridX;
  const prevY = state.player.gridY;
  const willFill = !revChk.checked;
  const snapshot = { prevX, prevY, filled: null };

  if (
    willFill &&
    state.maze[prevY][prevX].type === "path" &&
    !state.maze[prevY][prevX].filled
  ) {
    snapshot.filled = { x: prevX, y: prevY };
  }

  state.undoStack.push(snapshot);
  undoBtn.disabled = false;

  state.player.moveToGrid(nx, ny);
  state.visitedCount++;
  state.score += 1;

  const cell = state.maze[ny][nx];
  if (
    cell.deadEnd &&
    !(nx === state.start.x && ny === state.start.y) &&
    !(nx === state.end.x && ny === state.end.y)
  ) {
    const preset =
      {
        easy: 0.9,
        normal: 1.0,
        hard: 1.2,
        cruel: 1.4,
      }[diffSel.value] || 1.0;
    const bonus = Math.round(10 * preset);
    state.score += bonus;
    cell.deadEnd = false;
    spawnParticles(nx, ny, 12);
    playBeep(880, 0.08);
  }

  if (snapshot.filled) {
    const fx = snapshot.filled.x;
    const fy = snapshot.filled.y;
    state.maze[fy][fx].filled = true;
    state.animations.push({
      x: fx,
      y: fy,
      start: performance.now(),
      dur: 170,
    });
    recomputeDeadendsNear(fx, fy);
    markDirty(fx, fy);
  }

  markDirty(state.player.gridX, state.player.gridY);
  markDirty(prevX, prevY);
  updateHUD();
  checkCompletion();
}

function undo() {
  if (state.undoStack.length === 0) return;
  const last = state.undoStack.pop();
  if (last.filled) {
    state.maze[last.filled.y][last.filled.x].filled = false;
    state.animations.push({
      x: last.filled.x,
      y: last.filled.y,
      start: performance.now(),
      dur: 120,
    });
    recomputeDeadendsNear(last.filled.x, last.filled.y);
    markDirty(last.filled.x, last.filled.y);
  }
  state.player.moveToGrid(last.prevX, last.prevY);
  markAllDirty();
  updateHUD();
  if (state.undoStack.length === 0) undoBtn.disabled = true;
}

function checkCompletion() {
  if (
    state.player.gridX === state.end.x &&
    state.player.gridY === state.end.y
  ) {
    const elapsedSec = Math.floor(
      (Date.now() - state.startTime + state.pausedElapsed) / 1000
    );
    const timePenalty = elapsedSec * 1;
    const finishBonus = Math.max(0, 100 - timePenalty);
    state.score += finishBonus;

    if (state.score > state.highscore) {
      state.highscore = state.score;
      localStorage.setItem("MazeHighscore", state.highscore);
      highEl.textContent = state.highscore;
    }

    setTimeout(() => {
      alert("Maze complete — regenerating slightly larger maze");
    }, 50);

    const newW = Math.min(51, state.cols + 2);
    const newH = Math.min(51, state.rows + 2);

    withViewTransition(() => {
      // Prevent mismatch between new dims and old maze for a frame
      state.maze = null;
      state.animations = [];
      state.particles = [];
      state.hintPath = null;

      state.cols = newW;
      state.rows = newH;
      widthIn.value = newW;
      heightIn.value = newH;

      resizeCanvas();
      generateMazeIterative();
    });
  }
}

// Reset current maze layout instead of generating a new one
function resetCurrentMaze() {
  if (!state.maze) return;

  for (let y = 0; y < state.maze.length; y++) {
    for (let x = 0; x < state.maze[y].length; x++) {
      const cell = state.maze[y][x];
      cell.filled = false;
      cell.deadEnd = false;
    }
  }

  recomputeAllDeadEnds();

  state.player = new Player(state.start.x, state.start.y, state.cellSize, 6.5);
  state.visitedCount = 1;
  state.undoStack = [];
  state.animations = [];
  state.particles = [];
  state.hintPath = null;
  state.score = 0;

  state.startTime = Date.now();
  state.pausedElapsed = 0;
  if (state.timerTick) clearInterval(state.timerTick);
  state.timerTick = setInterval(updateTimer, 250);

  undoBtn.disabled = true;
  markAllDirty();
  updateHUD();
}

// Hint (A*)
if (!astarWorker) {
  if (hintBtn) hintBtn.disabled = true;
} else {
  hintBtn.addEventListener("click", () => {
    hintBtn.disabled = true;
    const out = [];
    for (let y = 0; y < state.rows; y++) {
      const row = new Array(state.cols);
      for (let x = 0; x < state.cols; x++) {
        const cell = state.maze[y][x];
        row[x] = cell.type === "path" && !cell.filled ? 1 : 0;
      }
      out.push(row);
    }
    astarWorker.postMessage({
      cmd: "astar",
      grid: out,
      cols: state.cols,
      rows: state.rows,
      start: { x: state.player.gridX, y: state.player.gridY },
      end: { x: state.end.x, y: state.end.y },
    });
  });

  astarWorker.onmessage = (e) => {
    hintBtn.disabled = false;
    const data = e.data;
    if (data && data.cmd === "result") {
      state.hintPath = data.path;
      if (state.hintTimeout) clearTimeout(state.hintTimeout);
      state.hintTimeout = setTimeout(() => {
        state.hintPath = null;
        markAllDirty();
      }, 3000);
      markAllDirty();
    }
  };
}

// Dead-end hint (BFS: nearest dead-end from current position)
if (!bfsWorker) {
  if (deadHintBtn) deadHintBtn.disabled = true;
} else if (deadHintBtn) {
  deadHintBtn.addEventListener("click", () => {
    deadHintBtn.disabled = true;

    const grid = [];
    const deadEnds = [];

    for (let y = 0; y < state.rows; y++) {
      const row = new Array(state.cols);
      for (let x = 0; x < state.cols; x++) {
        const cell = state.maze[y][x];
        const walkable = cell.type === "path" && !cell.filled;
        row[x] = walkable ? 1 : 0;

        if (
          walkable &&
          cell.deadEnd &&
          !(x === state.player.gridX && y === state.player.gridY)
        ) {
          deadEnds.push([x, y]);
        }
      }
      grid.push(row);
    }

    if (deadEnds.length === 0) {
      deadHintBtn.disabled = false;
      console.log("No reachable dead-ends from this state.");
      return;
    }

    bfsWorker.postMessage({
      cmd: "bfs-deadend",
      grid,
      cols: state.cols,
      rows: state.rows,
      start: { x: state.player.gridX, y: state.player.gridY },
      deadEnds,
    });
  });

  bfsWorker.onmessage = (e) => {
    deadHintBtn.disabled = false;
    const { cmd, path } = e.data || {};
    if (cmd !== "result") return;

    if (!path || path.length < 2) {
      state.hintPath = null;
      markAllDirty();
      console.log("Dead-end is current cell or trivial step; no hint drawn.");
      return;
    }

    state.hintPath = path;
    if (state.hintTimeout) clearTimeout(state.hintTimeout);
    state.hintTimeout = setTimeout(() => {
      state.hintPath = null;
      markAllDirty();
    }, 3000);

    markAllDirty();
  };
}

// Input handling
let holdInterval = null;

function keyToDir(k) {
  if (k === "ArrowUp" || k === "w" || k === "W") return [0, -1];
  if (k === "ArrowDown" || k === "s" || k === "S") return [0, 1];
  if (k === "ArrowLeft" || k === "a" || k === "A") return [-1, 0];
  if (k === "ArrowRight" || k === "d" || k === "D") return [1, 0];
  return null;
}

window.addEventListener("keydown", (e) => {
  const dir = keyToDir(e.key);
  if (dir) {
    e.preventDefault();
    if (holdInterval) clearInterval(holdInterval);
    attemptMove(dir[0], dir[1]);
    holdInterval = setInterval(() => attemptMove(dir[0], dir[1]), 150);
  }
  if (e.key === "u" || e.key === "U") {
    undo();
  }
});

window.addEventListener("keyup", (e) => {
  if (keyToDir(e.key)) {
    if (holdInterval) {
      clearInterval(holdInterval);
      holdInterval = null;
    }
  }
});

// Pointer continuous directional hold
let pDown = false;
let startX = 0;
let startY = 0;
let lastDir = null;

canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pDown = true;
  startX = ev.clientX;
  startY = ev.clientY;
  lastDir = null;
});

canvas.addEventListener("pointermove", (ev) => {
  if (!pDown) return;
  const dx = ev.clientX - startX;
  const dy = ev.clientY - startY;
  if (Math.hypot(dx, dy) < 8) return;
  const dir =
    Math.abs(dx) > Math.abs(dy)
      ? dx > 0
        ? "right"
        : "left"
      : dy > 0
      ? "down"
      : "up";
  if (dir !== lastDir) {
    lastDir = dir;
    if (holdInterval) clearInterval(holdInterval);
    const map = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0],
    };
    const d = map[dir];
    attemptMove(d[0], d[1]);
    holdInterval = setInterval(() => attemptMove(d[0], d[1]), 150);
  }
});

canvas.addEventListener("pointerup", (ev) => {
  pDown = false;
  lastDir = null;
  if (holdInterval) {
    clearInterval(holdInterval);
    holdInterval = null;
  }
  try {
    canvas.releasePointerCapture(ev.pointerId);
  } catch {
    // ignore
  }
});

canvas.addEventListener("pointercancel", () => {
  pDown = false;
  if (holdInterval) {
    clearInterval(holdInterval);
    holdInterval = null;
  }
});

// Buttons & dialog
regenBtn.addEventListener("click", () => {
  state.cols = Math.max(7, Number(widthIn.value) || 21);
  state.rows = Math.max(7, Number(heightIn.value) || 21);
  withViewTransition(() => {
    generateMazeIterative();
    resizeCanvas();
  });
});

resetBtn.addEventListener("click", () => {
  withViewTransition(() => {
    resetCurrentMaze();
  });
});

undoBtn.addEventListener("click", undo);

coachBtn.addEventListener("click", () => {
  coachDialog.showModal();
});

closeCoach.addEventListener("click", () => {
  coachDialog.close();
});

coachDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  coachDialog.close();
});

// click outside to close
coachDialog.addEventListener("click", (event) => {
  const rect = coachDialog.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    coachDialog.close();
  }
});

// Init
function init() {
  if (state.cols % 2 === 0) state.cols++;
  if (state.rows % 2 === 0) state.rows++;
  resizeCanvas();
  generateMazeIterative();
}

window.addEventListener("resize", () => {
  resizeCanvas();
  markAllDirty();
});

init();

// Debug hooks
window.__MAZE_STATE = state;
window.__REGEN = () => {
  regenBtn.click();
};
