// astar-worker.js
// A* pathfinding worker using Manhattan heuristic

self.onmessage = (event) => {
  const { cmd, grid, cols, rows, start, end } = event.data;
  if (cmd !== "astar") return;

  const key = (x, y) => `${x},${y}`;

  const h = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  const neighbors = (x, y) => {
    const res = [];
    if (x > 0) res.push({ x: x - 1, y });
    if (x < cols - 1) res.push({ x: x + 1, y });
    if (y > 0) res.push({ x, y: y - 1 });
    if (y < rows - 1) res.push({ x, y: y + 1 });
    return res.filter((n) => grid[n.y][n.x] === 1);
  };

  class PQ {
    constructor() {
      this.a = [];
    }
    push(item) {
      this.a.push(item);
      let i = this.a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.a[i].f < this.a[p].f) {
          [this.a[i], this.a[p]] = [this.a[p], this.a[i]];
          i = p;
        } else {
          break;
        }
      }
    }
    pop() {
      if (this.a.length === 0) return null;
      const r = this.a[0];
      const last = this.a.pop();
      if (this.a.length) {
        this.a[0] = last;
        let i = 0;
        // sift down
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const l = i * 2 + 1;
          const r_ = l + 1;
          let m = i;
          if (l < this.a.length && this.a[l].f < this.a[m].f) m = l;
          if (r_ < this.a.length && this.a[r_].f < this.a[m].f) m = r_;
          if (m === i) break;
          [this.a[i], this.a[m]] = [this.a[m], this.a[i]];
          i = m;
        }
      }
      return r;
    }
    size() {
      return this.a.length;
    }
  }

  const startNode = {
    x: start.x,
    y: start.y,
    g: 0,
    f: h(start, end),
    prev: null
  };

  const open = new Map();
  const pq = new PQ();
  open.set(key(start.x, start.y), startNode);
  pq.push(startNode);

  const MAX_STEPS = cols * rows * 10;
  let steps = 0;

  while (pq.size() && steps++ < MAX_STEPS) {
    const cur = pq.pop();
    if (!cur) break;

    if (cur.x === end.x && cur.y === end.y) {
      const path = [];
      let node = cur;
      while (node) {
        path.push([node.x, node.y]);
        node = node.prev;
      }
      self.postMessage({ cmd: "result", path: path.reverse() });
      return;
    }

    for (const nb of neighbors(cur.x, cur.y)) {
      const ng = cur.g + 1;
      const k = key(nb.x, nb.y);
      const nf = ng + h(nb, end);
      const existing = open.get(k);
      if (!existing || ng < existing.g) {
        const node = { x: nb.x, y: nb.y, g: ng, f: nf, prev: cur };
        open.set(k, node);
        pq.push(node);
      }
    }
  }

  self.postMessage({ cmd: "result", path: null });
};
