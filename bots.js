const DIFFICULTIES = ["easy", "medium", "hard"];

function randomChoice(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function useStrategy(difficulty) {
  return Math.random() < { easy: 0.15, medium: 0.65, hard: 1 }[difficulty];
}

const TIC_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7],
  [2, 5, 8], [0, 4, 8], [2, 4, 6],
];

function ticWinner(board, mark) {
  return TIC_LINES.some((line) => line.every((index) => board[index] === mark));
}

function ticScore(board, botTurn) {
  if (ticWinner(board, "O")) return 1;
  if (ticWinner(board, "X")) return -1;
  const empty = board.map((mark, index) => mark ? -1 : index).filter((index) => index >= 0);
  if (!empty.length) return 0;
  const scores = empty.map((index) => {
    board[index] = botTurn ? "O" : "X";
    const score = ticScore(board, !botTurn);
    board[index] = "";
    return score;
  });
  return botTurn ? Math.max(...scores) : Math.min(...scores);
}

function ticMove(board, difficulty) {
  const empty = board.map((mark, index) => mark ? -1 : index).filter((index) => index >= 0);
  if (!useStrategy(difficulty)) return randomChoice(empty);
  let best = -Infinity;
  let choices = [];
  for (const index of empty) {
    board[index] = "O";
    const score = ticScore(board, false);
    board[index] = "";
    if (score > best) { best = score; choices = []; }
    if (score === best) choices.push(index);
  }
  return randomChoice(choices);
}

function connectDrop(board, column, mark) {
  for (let row = 5; row >= 0; row -= 1) {
    const index = row * 7 + column;
    if (!board[index]) { board[index] = mark; return index; }
  }
  return -1;
}

function connectWon(board, index, mark) {
  const row = Math.floor(index / 7);
  const column = index % 7;
  return [[0, 1], [1, 0], [1, 1], [1, -1]].some(([dr, dc]) => {
    let count = 1;
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = column + dc * sign;
      while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r * 7 + c] === mark) {
        count += 1;
        r += dr * sign;
        c += dc * sign;
      }
    }
    return count >= 4;
  });
}

function connectMove(board, difficulty) {
  const legal = [0, 1, 2, 3, 4, 5, 6].filter((column) => !board[column]);
  if (!useStrategy(difficulty)) return randomChoice(legal);
  for (const mark of ["Y", "R"]) {
    const wins = legal.filter((column) => {
      const index = connectDrop(board, column, mark);
      const won = connectWon(board, index, mark);
      board[index] = "";
      return won;
    });
    if (wins.length) return randomChoice(wins);
  }
  if (difficulty === "hard") {
    const safe = legal.filter((column) => {
      const move = connectDrop(board, column, "Y");
      const opponentWins = legal.some((reply) => {
        const index = connectDrop(board, reply, "R");
        if (index < 0) return false;
        const won = connectWon(board, index, "R");
        board[index] = "";
        return won;
      });
      board[move] = "";
      return !opponentWins;
    });
    if (safe.length) return safe.sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3))[0];
  }
  return randomChoice(legal);
}

function rememberCards(bot, state) {
  for (const index of state.revealed) {
    if (bot.difficulty === "hard" || Math.random() < (bot.difficulty === "medium" ? 0.65 : 0.2)) {
      bot.memory[index] = state.deck[index];
    }
  }
}

function memoryMove(state, bot) {
  const available = state.deck.map((_, index) => index)
    .filter((index) => !state.matched[index] && !state.revealed.includes(index));
  if (useStrategy(bot.difficulty)) {
    if (state.revealed.length) {
      const symbol = bot.memory[state.revealed[0]];
      const match = available.find((index) => symbol && bot.memory[index] === symbol);
      if (match !== undefined) return match;
    } else {
      for (const index of available) {
        if (bot.memory[index] && available.some((other) => other !== index && bot.memory[other] === bot.memory[index])) {
          return index;
        }
      }
    }
    const unseen = available.filter((index) => !bot.memory[index]);
    if (unseen.length) return randomChoice(unseen);
  }
  return randomChoice(available);
}

function battleMove(shots, difficulty) {
  const available = Array.from({ length: 100 }, (_, index) => index).filter((index) => !shots[index]);
  if (useStrategy(difficulty)) {
    const hits = Object.keys(shots).map(Number).filter((index) => shots[index] === "hit");
    const neighbors = hits.flatMap((index) => [
      index >= 10 ? index - 10 : -1,
      index < 90 ? index + 10 : -1,
      index % 10 ? index - 1 : -1,
      index % 10 < 9 ? index + 1 : -1,
    ]).filter((index) => index >= 0 && !shots[index]);
    if (neighbors.length) return randomChoice(neighbors);
    if (difficulty === "hard") {
      const parity = available.filter((index) => (Math.floor(index / 10) + index % 10) % 2 === 0);
      if (parity.length) return randomChoice(parity);
    }
  }
  return randomChoice(available);
}

function pongDirection(state, bot) {
  const offset = { easy: 0.19, medium: 0.09, hard: 0.025 }[bot.difficulty];
  const target = state.ball.y + bot.pongOffset * offset;
  return Math.abs(target - state.paddles[1]) < 0.025 ? 0 : target < state.paddles[1] ? -1 : 1;
}

module.exports = { DIFFICULTIES, ticMove, connectMove, rememberCards, memoryMove, battleMove, pongDirection };
