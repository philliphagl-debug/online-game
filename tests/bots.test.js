const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ticMove, connectMove, rememberCards, memoryMove, battleMove, pongDirection } = require("../bots");

const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const won = (board, mark) => lines.some((line) => line.every((index) => board[index] === mark));

test("hard Tic-Tac-Toe never loses against any human moves", () => {
  function check(board, humanTurn) {
    assert.equal(won(board, "X"), false);
    if (won(board, "O") || board.every(Boolean)) return;
    const empty = board.map((mark, index) => mark ? -1 : index).filter((index) => index >= 0);
    const moves = humanTurn ? empty : [ticMove([...board], "hard")];
    for (const index of moves) {
      assert.ok(empty.includes(index));
      const next = [...board];
      next[index] = humanTurn ? "X" : "O";
      check(next, !humanTurn);
    }
  }
  check(Array(9).fill(""), true);
});

test("hard Connect Four wins immediately and blocks an immediate threat", () => {
  const board = Array(42).fill("");
  board[35] = board[36] = board[37] = "Y";
  assert.equal(connectMove([...board], "hard"), 3);
  board[35] = board[36] = board[37] = "R";
  assert.equal(connectMove([...board], "hard"), 3);
});

test("memory bot only remembers revealed cards and selects a known pair", () => {
  const bot = { difficulty: "hard", memory: {} };
  const state = { deck: ["A", "B", "A", "B"], revealed: [0, 2], matched: [false, false, false, false] };
  rememberCards(bot, state);
  assert.deepEqual(bot.memory, { 0: "A", 2: "A" });
  state.revealed = [];
  assert.equal(memoryMove(state, bot), 0);
  state.revealed = [0];
  assert.equal(memoryMove(state, bot), 2);
});

test("Battleship bot hunts visible hits, never shoots used cells, and ignores sunk ships", () => {
  const shots = Array(100).fill("");
  shots[0] = "hit";
  shots[1] = "miss";
  assert.equal(battleMove(shots, "hard"), 10);
  shots[0] = "sunk";
  const choice = battleMove(shots, "hard");
  assert.equal(shots[choice], "");
  assert.equal((Math.floor(choice / 10) + choice % 10) % 2, 0);
});

test("Pong bot reacts towards the ball and difficulty affects its aim", () => {
  const state = { ball: { y: 0.6 }, paddles: [0.5, 0.5] };
  assert.equal(pongDirection(state, { difficulty: "hard", pongOffset: 0 }), 1);
  assert.equal(pongDirection(state, { difficulty: "easy", pongOffset: -1 }), -1);
});
