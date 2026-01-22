// bfs-worker.js
// BFS search for nearest dead-end (fast, stops early)
// Expects: { cmd: 'bfs-deadend', grid, cols, rows, start, deadEnds }
// grid: nested numeric arrays with 1=walkable, 0=wall
// deadEnds: array of [x,y] coordinates marking dead-end targets

self.onmessage = (e) => {
  const { cmd, grid, cols, rows, start, deadEnds } = e.data;
  if (cmd !== 'bfs-deadend') return;

  const key = (x,y) => `${x},${y}`;
  // build quick lookup set for deadEnds for fast stop-check
  const deadSet = new Set((deadEnds || []).map(([x,y]) => key(x,y)));

  // quick guard
  if (!grid || !start) {
    self.postMessage({ cmd: 'result', path: null });
    return;
  }

  const inBounds = (x,y) => x >= 0 && y >= 0 && x < cols && y < rows;
  const neighbors = (x,y) => {
    const res = [];
    if (x > 0) res.push([x-1,y]);
    if (x < cols - 1) res.push([x+1,y]);
    if (y > 0) res.push([x,y-1]);
    if (y < rows - 1) res.push([x,y+1]);
    return res.filter(([nx,ny]) => grid[ny][nx] === 1);
  };

  const q = [];
  const visited = new Set();
  const parent = new Map();

  q.push([start.x, start.y]);
  visited.add(key(start.x, start.y));
  parent.set(key(start.x, start.y), null);

  while (q.length) {
    const [cx, cy] = q.shift();
    const k = key(cx, cy);

    if (deadSet.has(k)) {
      // reconstruct path
      const path = [];
      let cur = k;
      while (cur) {
        const [sx, sy] = cur.split(',').map(Number);
        path.push([sx, sy]);
        cur = parent.get(cur);
      }
      path.reverse();
      self.postMessage({ cmd: 'result', path });
      return;
    }

    for (const [nx, ny] of neighbors(cx, cy)) {
      const nk = key(nx, ny);
      if (!visited.has(nk)) {
        visited.add(nk);
        parent.set(nk, k);
        q.push([nx, ny]);
      }
    }
  }

  // no dead-end found
  self.postMessage({ cmd: 'result', path: null });
};
