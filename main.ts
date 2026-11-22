// Sokoban solver for the make.fun bounty sokoban-solver-01-run-20261121.
//
// The levels are a one-square hallway with 1-4 rooms off it; a box pushed out
// of a room into the hallway can never come back, so every room is an
// independent problem and the level's push-optimal count is the sum of its
// rooms' optima. This entry solves each room on its own, in turn, the player
// walking on from where the last room left it.
//
// Each room is solved by A* over pushes. A state is the boxes' squares plus
// the player's reachable region (named by its lowest square, since the player
// walks for free inside a region). The cost is pushes; the heuristic is the
// minimum-assignment (Hungarian) sum of box-to-goal walking distances, which
// is admissible and consistent (one push moves one box one square, so the
// assignment changes by at most 1), so the first solved state popped from the
// open list is push-optimal. Two deadlocks are pruned, neither of which can
// prune a solvable state: a box on a dead square (one from which no push,
// ignoring the other boxes, reaches any goal) and a frozen 2x2 block of walls
// and boxes holding a box off its goal.
//
// If the optimal search hits its state cap on a room, the entry falls back to
// weighted A* (weight 3) and then greedy best-first search on the same room,
// so a hard room still yields a solved (if suboptimal) answer worth partial
// points instead of nothing. A level that is no set of rooms is searched whole
// the same way.
//
// Deterministic: no clock, no randomness, fixed iteration orders and fixed
// heap tie-breaks, state-count caps only, so two runs write the same bytes.
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** State caps (generated states): the optimal search, then the two fallbacks, per room. */
const ROOM_ASTAR_STATES = 120_000;
const ROOM_WEIGHTED_STATES = 60_000;
const ROOM_GREEDY_STATES = 60_000;
/** The same caps for a whole-level search (only when the level is no set of rooms). */
const WHOLE_ASTAR_STATES = 80_000;
const WHOLE_WEIGHTED_STATES = 60_000;
const WHOLE_GREEDY_STATES = 60_000;
/** The weighted fallback's weight on the heuristic. */
const WEIGHT = 3;

/** The four directions: [dx, dy, the step's letter, the push's letter]. */
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/**
 * A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal,
 * @ player, + player on a goal), each line a row.
 */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // A square on the outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Each goal's walking distance to every square (BFS over open floor, -1 unreachable). */
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

/** Every permutation of 0..n-1, in lexicographic order. */
function permutations(n: number): number[][] {
  const base = Array.from({ length: n }, (_, i) => i);
  const out: number[][] = [base.slice()];
  const c = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    if (c[i]! < i) {
      const j = i % 2 === 0 ? 0 : c[i]!;
      const t = base[j]!;
      base[j] = base[i]!;
      base[i] = t;
      out.push(base.slice());
      c[i] = c[i]! + 1;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
  return out;
}

/** The squares the player reaches from `from` with `occupied` (a box mask) in the way, marked in `seen` with `stamp`; the lowest. */
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * The push-optimal (weight 1) or approximate (weight > 1, or greedy) solution
 * of `level`, searching at most `maxStates` generated states: {pushes, moves}
 * (moves in LURD: a lower letter a step, an upper one a push), or null when the
 * search gives up (or the level has no solution).
 */
function searchPushes(level: Level, maxStates: number, weight: number, greedy: boolean): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const dists = goalDistances(level);
  const perms = n <= 8 && n === goals.length ? permutations(n) : null;
  // The heuristic: the minimum assignment of boxes to goals by walking distance
  // (exact for up to 8 boxes; else each box's nearest goal, still a lower bound).
  const heuristic = (boxes: number[]): number => {
    if (perms !== null) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = dists[p[i]!]![boxes[i]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
        if (best === 0) break;
      }
      return best;
    }
    let s = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let gi = 0; gi < dists.length; gi++) {
        const d = dists[gi]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  // A state's key: the region's lowest square and the boxes' squares, as digits
  // in base `size` (exact while size ** (boxes + 1) stays under 2 ** 53), else text.
  const numericKey = (n + 1) * Math.log2(size) < 53;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numericKey) return low + ':' + boxes.join(',');
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // The states in the order found: boxes, player square, parent, the push that made them, cost and f.
  const sBoxes: number[][] = [];
  const sPlayer: number[] = [];
  const sParent: number[] = [];
  const sFrom: number[] = [];
  const sTo: number[] = [];
  const sG: number[] = [];
  const sF: number[] = [];
  const sKey: (number | string)[] = [];
  const best = new Map<number | string, number>();
  // The open list: a heap of state indices on (f, deeper first, found first).
  const heap: number[] = [];
  const better = (a: number, b: number): boolean =>
    sF[a]! !== sF[b]! ? sF[a]! < sF[b]! : sG[a]! !== sG[b]! ? sG[a]! > sG[b]! : a < b;
  const heapPush = (s: number): void => {
    let i = heap.length;
    heap.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!better(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && better(heap[c + 1]!, heap[c]!)) c++;
        if (!better(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };
  const addState = (boxes: number[], player: number, parent: number, from: number, to: number, g: number): number => {
    const h = heuristic(boxes);
    if (h === Infinity) return -1; // a box reaches no goal: dead, never add it
    const f = greedy ? h : g + weight * h;
    const idx = sBoxes.length;
    sBoxes.push(boxes);
    sPlayer.push(player);
    sParent.push(parent);
    sFrom.push(from);
    sTo.push(to);
    sG.push(g);
    sF.push(f);
    sKey.push(-1);
    return idx;
  };
  // A solved state found while generating (only used if the cap is hit before it is popped).
  let bestSolved = -1;
  const noteSolved = (s: number): void => {
    if (bestSolved < 0 || sG[s]! < sG[bestSolved]!) bestSolved = s;
  };
  for (const b of level.boxes) occupied[b] = 1;
  const rootLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  const root = addState(level.boxes.slice(), level.player, -1, -1, -1, 0);
  if (root < 0) return null;
  sKey[root] = keyOf(level.boxes, rootLow);
  best.set(sKey[root]!, 0);
  heapPush(root);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };
  while (heap.length > 0) {
    const s = heapPop();
    if (best.get(sKey[s]!) !== sG[s]) continue; // stale: a better path to this state was found
    const boxes = sBoxes[s]!;
    if (solved(boxes)) return reconstruct(s);
    const g = sG[s]!;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, sPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const seenG = best.get(key);
        if (seenG !== undefined && seenG <= g + 1) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return bestSolved >= 0 ? reconstruct(bestSolved) : null;
        }
        best.set(key, g + 1);
        const idx = addState(next!, b, s, b, t, g + 1);
        if (idx < 0) continue; // dead: a box reaches no goal
        sKey[idx] = key;
        heapPush(idx);
        if (solved(next!)) noteSolved(idx);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  return bestSolved >= 0 ? reconstruct(bestSolved) : null;

  /** The moves for the path to state `s`: walk to each push's square, then push. */
  function reconstruct(s: number): { pushes: number; moves: string } {
    const path: number[] = [];
    for (let t = s; t > 0; t = sParent[t]!) path.push(t);
    path.reverse();
    let moves = '';
    let player = level.player;
    let boxes = level.boxes;
    for (const t of path) {
      const from = sFrom[t]!;
      const to = sTo[t]!;
      const d = to - from;
      const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
      for (const b of boxes) occupied[b] = 1;
      moves += walkTo(level, occupied, player, from - d);
      for (const b of boxes) occupied[b] = 0;
      moves += dir[3];
      player = from;
      boxes = sBoxes[t]!;
    }
    return { pushes: path.length, moves };
  }
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (the first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no goal) out of the
 * floor, and each part left that holds a box is a room, its squares, boxes and goals. Null when some part holds more or
 * fewer boxes than goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** One room's solution: optimal A* first, then weighted A*, then greedy, so a hard room still gets solved. */
function solveRoom(sub: Level): { pushes: number; moves: string } | null {
  return (
    searchPushes(sub, ROOM_ASTAR_STATES, 1, false) ??
    searchPushes(sub, ROOM_WEIGHTED_STATES, WEIGHT, false) ??
    searchPushes(sub, ROOM_GREEDY_STATES, 1, true)
  );
}

/**
 * The level solved room by room: each room's solution in turn, the other rooms' boxes standing as walls (on their goals
 * once their room is done), the player walking on from where the last room left it. Null when a room's search gives up.
 */
function solveByRooms(level: Level, rooms: Room[]): string | null {
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub);
    if (solved === null) return null;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

/** A level that is no set of rooms, searched whole the same way. */
function solveWhole(level: Level): string | null {
  const solved =
    searchPushes(level, WHOLE_ASTAR_STATES, 1, false) ??
    searchPushes(level, WHOLE_WEIGHTED_STATES, WEIGHT, false) ??
    searchPushes(level, WHOLE_GREEDY_STATES, 1, true);
  return solved === null ? null : solved.moves;
}

/** The moves for a level in XSB: '' when it cannot be solved (a valid, scoreless answer). */
function solve(text: string): string {
  try {
    const level = parseLevel(text);
    if (level.boxes.length === 0 || level.player < 0) return '';
    const rooms = roomsOf(level);
    if (rooms !== null) {
      const moves = solveByRooms(level, rooms);
      if (moves !== null) return moves;
      return '';
    }
    return solveWhole(level) ?? '';
  } catch {
    return '';
  }
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
