const { test } = require("node:test");
const assert = require("node:assert/strict");
const { gameOutcome } = require("../public/game-outcome");

function outcome(game, gameState, you = 0, phase = "finished") {
  return gameOutcome({ game, gameState, you, phase });
}

test("all eleven games distinguish winners and losers", () => {
  for (const game of ["tic-tac-toe", "connect-four"]) {
    const winner = game === "tic-tac-toe" ? "X" : "R";
    assert.equal(outcome(game, { winner }, 0), "win", game);
    assert.equal(outcome(game, { winner }, 1), "loss", game);
    assert.equal(outcome(game, { winner: "draw" }, 0), "draw", game);
  }
  for (const game of ["battleship", "reaction-race"]) {
    assert.equal(outcome(game, { winner: 0 }, 0), "win", game);
    assert.equal(outcome(game, { winner: 0 }, 1), "loss", game);
  }
  for (const game of ["quiz", "word-scramble", "pong", "memory-match", "rock-paper-scissors", "higher-lower"]) {
    const scores = game === "higher-lower" ? [6, 4] : [5, 2];
    assert.equal(outcome(game, { scores }, 0), "win", game);
    assert.equal(outcome(game, { scores }, 1), "loss", game);
  }
  assert.equal(outcome("hangman", { word: "CAT", guesses: ["C", "A", "T"] }), "win");
  assert.equal(outcome("hangman", { word: "CAT", guesses: ["C", "A"] }), "loss");
});

test("ties and shared losses follow each game's existing rules", () => {
  for (const game of ["memory-match", "rock-paper-scissors"]) {
    assert.equal(outcome(game, { scores: [3, 3, 1] }, 0), "draw");
    assert.equal(outcome(game, { scores: [3, 3, 1] }, 1), "draw");
    assert.equal(outcome(game, { scores: [3, 3, 1] }, 2), "loss");
  }
  for (const game of ["quiz", "word-scramble", "higher-lower"]) {
    assert.equal(outcome(game, { scores: [5, 5] }, 0), "win");
    assert.equal(outcome(game, { scores: [5, 5] }, 1), "loss");
  }
  assert.equal(outcome("higher-lower", { scores: [4, 3] }, 0), "loss");
  assert.equal(outcome("higher-lower", { scores: [4, 3] }, 1), "loss");
});

test("spectators, unfinished games, and abandoned games have no personal result", () => {
  assert.equal(outcome("tic-tac-toe", { winner: "X" }, -1), null);
  assert.equal(outcome("tic-tac-toe", { winner: "" }, 0, "playing"), null);
  assert.equal(outcome("battleship", { abandoned: true }, 0), null);
});
