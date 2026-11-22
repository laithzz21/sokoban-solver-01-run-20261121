# Sokoban solver — make.fun bounty entry

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/laithzz21/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/laithzz21/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

Entry for [Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121):
one program answers 5 generated Sokoban levels in a single run of at most 60
seconds, writing the player's moves that push every box onto a goal in as few
pushes as possible.

## How it works

The levels are a one-square hallway with 1–4 rooms off it; a box pushed out
of a room into the hallway can never come back, so every room is an
independent problem and the level's push-optimal count is the sum of its
rooms' optima. `main.ts` therefore splits each level into rooms (cutting the
hallway's dead squares out of the floor) and solves each room on its own, the
player walking on from where the last room left it.

Each room is solved by **A\* over pushes**:

- A state is the boxes' squares plus the player's reachable region, named by
  its lowest square (the player walks for free inside a region).
- The cost is pushes; the heuristic is the minimum-assignment (Hungarian) sum
  of box-to-goal walking distances. It is admissible and consistent — one push
  moves one box one square, so the assignment changes by at most 1 — so the
  first solved state popped from the open list is **push-optimal**.
- Two deadlocks are pruned, neither of which can prune a solvable state: a box
  on a dead square (one from which no push, ignoring the other boxes, reaches
  any goal) and a frozen 2×2 block of walls and boxes holding a box off its
  goal.

If the optimal search hits its state cap on a room, the entry falls back to
weighted A\* (weight 3) and then greedy best-first search on the same room, so
a hard room still yields a solved (if suboptimal) answer worth partial points
instead of nothing. A level that is no set of rooms is searched whole the same
way. An unsolvable level gets an empty (valid, scoreless) answer, never a
crash.

The solver is fully deterministic — no clock, no randomness, fixed iteration
orders and heap tie-breaks, state-count caps only — so two runs write the same
bytes.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `$MAKEFUN_INPUT_DIR/<id>/level.txt` (XSB) and writes
`$MAKEFUN_OUTPUT_DIR/<id>/solution.txt` (moves in LURD; an upper letter marks
a push). Node 22, no dependencies, no network.

## Test results

Scored with the kit's own checker/scorer (`program/scorer/`):

| Set | Score | Pushes vs P\* |
| --- | --- | --- |
| Practice set (kit) | **1,000,000 / 1,000,000** | 13/13, 16/16, 29/29, 47/47, 60/60 — every level push-optimal |
| 50 freshly generated sets (kit generator, random seeds) | **1,000,000 on all 50** | every instance push-optimal (250/250) |
| House baseline plain-astar 1.0.0, practice set | 200,000 (solves only i001) | — |

Runtime for a full 5-level set: mean ~0.3 s, worst observed 0.5 s (limit 60 s).
Edge cases verified with the kit's checker: a 1-box level (2 pushes), a 2-box
level (2 pushes), an already-solved level (empty answer), an unsolvable level
(empty answer, no crash).

## Files

- `main.ts` — the whole solver (entry point, run as `node main.ts`)
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE).
