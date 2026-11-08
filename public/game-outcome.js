function gameOutcome(room) {
  if (room.phase !== "finished" || room.you < 0 || room.gameState.abandoned) return null;
  const state = room.gameState;
  if (room.game === "hangman") {
    return typeof state.word === "string" && [...state.word].every((letter) => state.guesses.includes(letter))
      ? "win" : "loss";
  }
  if (room.game === "reaction-race" || room.game === "battleship") {
    return state.winner === room.you ? "win" : "loss";
  }
  if (room.game === "tic-tac-toe" || room.game === "connect-four") {
    const marks = room.game === "tic-tac-toe" ? ["X", "O"] : ["R", "Y"];
    return state.winner === "draw" ? "draw" : state.winner === marks[room.you] ? "win" : "loss";
  }
  if (room.game === "higher-lower" && state.scores.reduce((sum, score) => sum + score, 0) < 10) {
    return "loss";
  }
  if (["quiz", "word-scramble", "pong", "memory-match", "rock-paper-scissors", "higher-lower"].includes(room.game)) {
    const highScore = Math.max(...state.scores);
    if (["memory-match", "rock-paper-scissors"].includes(room.game) &&
      state.scores.filter((score) => score === highScore).length > 1) {
      return state.scores[room.you] === highScore ? "draw" : "loss";
    }
    return state.scores.indexOf(highScore) === room.you ? "win" : "loss";
  }
  return null;
}

if (typeof module !== "undefined") module.exports = { gameOutcome };
