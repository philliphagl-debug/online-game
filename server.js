const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const bots = require("./bots");

const publicDirectory = path.join(__dirname, "public");
const rooms = new Map();
const groups = new Map();
const requestBuckets = new Map();
const pongStreams = new Set();
const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error("PORT must be a valid TCP port.");
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ROOMS = 500;
const FINISHED_ROOM_LIFETIME_MS = 5000;
const MAX_PONG_STREAMS = 500;
const BATTLE_SIZE = 10;
const BATTLE_FLEET = [2, 3, 3, 4, 5];
const TWO_PLAYER_GAMES = ["pong", "tic-tac-toe", "connect-four", "memory-match", "battleship"];
const GAMES = [
  "quiz", "pong", "tic-tac-toe", "connect-four", "word-scramble",
  "memory-match", "hangman", "rock-paper-scissors", "higher-lower",
  "battleship", "reaction-race",
];
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const RATE_LIMITS = {
  default: { limit: 600, windowMs: 60_000 },
  state: { limit: 300, windowMs: 60_000 },
  "group-state": { limit: 1000, windowMs: 60_000 },
  action: { limit: 180, windowMs: 60_000 },
  create: { limit: 8, windowMs: 10 * 60_000 },
  join: { limit: 25, windowMs: 10 * 60_000 },
};
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const quizQuestions = [
  { prompt: "What is the largest planet in our solar system?", answer: "jupiter" },
  { prompt: "How many sides does a hexagon have?", answer: "6" },
  { prompt: "What is the capital of Japan?", answer: "tokyo" },
  { prompt: "Which ocean is the largest?", answer: "pacific" },
  { prompt: "What is 9 × 7?", answer: "63" },
];

const scrambledWords = [
  { word: "PLANET", scramble: "TLANEP" },
  { word: "GARDEN", scramble: "DREGAN" },
  { word: "POCKET", scramble: "TEKPOC" },
  { word: "STREAM", scramble: "MTAERS" },
  { word: "BRIDGE", scramble: "GIBRED" },
];

const hangmanWords = ["ORBIT", "GUITAR", "PUZZLE", "ISLAND", "ROCKET"];
const cardSymbols = ["★", "●", "▲", "◆", "♥", "☀", "♫", "✿"];

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function differentNumber(current) {
  let next;
  do {
    next = Math.floor(Math.random() * 13) + 1;
  } while (next === current);
  return next;
}

function makeBattleshipBoards(players) {
  return Object.fromEntries(players.map((player) => [player.id, { ships: [], shots: {}, ready: false }]));
}

function finishRoom(room) {
  room.phase = "finished";
  if (rooms.get(room.code) !== room) return;
  room.closesAt = Date.now() + FINISHED_ROOM_LIFETIME_MS;
  setTimeout(() => {
    if (rooms.get(room.code) === room) rooms.delete(room.code);
  }, FINISHED_ROOM_LIFETIME_MS);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        oversized = true;
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (oversized) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!value || Array.isArray(value) || typeof value !== "object") {
          reject(Object.assign(new Error("Request body must be a JSON object."), { status: 400 }));
          return;
        }
        resolve(value);
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, 20).join("");
}

function createCode(collection = rooms) {
  let code;
  do {
    code = randomBytes(8).toString("hex").toUpperCase();
  } while (collection.has(code));
  return code;
}

function createPlayer() {
  return {
    id: randomUUID(),
    token: randomBytes(32).toString("hex"),
    name: "",
  };
}

function isValidToken(candidate, actual) {
  if (typeof candidate !== "string" || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(actual, "hex"));
}

function clientAddress(request) {
  if (TRUST_PROXY) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string") return forwarded.split(",")[0].trim().slice(0, 64);
  }
  return request.socket.remoteAddress || "unknown";
}

function enforceRateLimit(request, route) {
  const config = RATE_LIMITS[route] || RATE_LIMITS.default;
  const key = `${clientAddress(request)}:${route}`;
  const now = Date.now();
  let bucket = requestBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + config.windowMs };
    requestBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > config.limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return retryAfter;
  }
  return 0;
}

function rateLimitResponse(response, retryAfter) {
  response.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": String(retryAfter),
  });
  response.end(JSON.stringify({ error: "Too many requests. Please try again later." }));
}

function makeGameState(game) {
  if (game === "quiz" || game === "word-scramble") {
    return { questionIndex: 0, scores: {}, answered: false, message: "" };
  }
  if (game === "connect-four") {
    return { board: Array(42).fill(""), turn: 0, winner: "", message: "" };
  }
  if (game === "memory-match") {
    const symbols = shuffled([...cardSymbols, ...cardSymbols]);
    return {
      deck: symbols,
      matched: Array(16).fill(false),
      revealed: [],
      firstPick: null,
      turn: 0,
      scores: {},
      message: "",
    };
  }
  if (game === "hangman") {
    return {
      word: hangmanWords[Math.floor(Math.random() * hangmanWords.length)],
      guesses: [],
      wrong: 0,
      message: "",
    };
  }
  if (game === "rock-paper-scissors") {
    return { round: 1, choices: {}, scores: {}, answered: false, message: "" };
  }
  if (game === "higher-lower") {
    const current = Math.floor(Math.random() * 13) + 1;
    return {
      current,
      target: differentNumber(current),
      round: 0,
      turn: 0,
      scores: {},
      message: "",
    };
  }
  if (game === "battleship") {
    return { boards: {}, stage: "placement", turn: 0, winner: "", message: "" };
  }
  if (game === "reaction-race") {
    return { goAt: 0, falseStarts: [], winner: "", message: "" };
  }
  if (game === "pong") {
    return {
      paddles: [0.5, 0.5],
      ball: { x: 0.5, y: 0.5, vx: 0.008, vy: 0.004 },
      scores: [0, 0],
      directions: [0, 0],
      message: "",
    };
  }
  return { board: Array(9).fill(""), turn: 0, winner: "", message: "" };
}

function publicRoom(room, playerId) {
  const gameState = structuredClone(room.gameState);
  if (gameState.scores && !Array.isArray(gameState.scores)) {
    gameState.scores = room.players.map((player) => gameState.scores[player.id] || 0);
  }
  if (room.game === "quiz" && room.phase === "playing") {
    gameState.question = quizQuestions[gameState.questionIndex]?.prompt ?? "";
    gameState.questionNumber = gameState.questionIndex;
    delete gameState.questionIndex;
  }
  if (room.game === "word-scramble" && room.phase === "playing") {
    gameState.scramble = scrambledWords[gameState.questionIndex]?.scramble ?? "";
    gameState.round = gameState.questionIndex + 1;
    delete gameState.questionIndex;
  }
  if (room.game === "memory-match") {
    gameState.cards = gameState.deck.map((symbol, index) =>
      gameState.matched[index] || gameState.revealed.includes(index) ? symbol : "");
    delete gameState.deck;
    delete gameState.firstPick;
  }
  if (room.game === "hangman") {
    gameState.mask = [...gameState.word].map((letter) =>
      gameState.guesses.includes(letter) ? letter : "_").join(" ");
    if (room.phase !== "finished") delete gameState.word;
  }
  if (room.game === "rock-paper-scissors") {
    const playerHasChosen = Boolean(gameState.choices[playerId]);
    gameState.playerHasChosen = playerHasChosen;
    gameState.choicesMade = Object.keys(gameState.choices).length;
    if (!gameState.answered) gameState.choices = [];
    else gameState.choices = room.players.map((player) => gameState.choices[player.id]);
  }
  if (room.game === "battleship" && room.players.length === 2 && room.phase !== "lobby") {
    const side = room.players.findIndex((player) => player.id === playerId);
    gameState.ready = room.players.map((player) => gameState.boards[player.id].ready);
    if (gameState.stage === "placement" && side >= 0) {
      const board = gameState.boards[playerId];
      gameState.placedCount = board.ships.length;
      gameState.fleet = BATTLE_FLEET;
      gameState.ownBoard = Array(BATTLE_SIZE * BATTLE_SIZE).fill("");
      for (const ship of board.ships) {
        ship.cells.forEach((cell, index) => {
          const part = index === 0 ? "start" : index === ship.cells.length - 1 ? "end" : "middle";
          gameState.ownBoard[cell] = `${ship.orientation}-${part}`;
        });
      }
    } else if (gameState.stage === "battle") {
      const target = gameState.boards[room.players[side < 0 ? 1 : 1 - side].id];
      const sunk = new Set(target.ships.filter((ship) => ship.cells.every((cell) => target.shots[cell] === "hit"))
        .flatMap((ship) => ship.cells));
      gameState.targetBoard = Array.from({ length: BATTLE_SIZE * BATTLE_SIZE }, (_, index) =>
        sunk.has(index) ? "sunk" : target.shots[index] || "");
    }
    delete gameState.boards;
  }
  if (room.game === "higher-lower" && room.phase === "playing") delete gameState.target;
  if (room.game === "reaction-race") {
    gameState.ready = room.phase === "playing" && Date.now() >= gameState.goAt;
    gameState.playerFalseStarted = gameState.falseStarts.includes(playerId);
    gameState.falseStarts = gameState.falseStarts.length;
    gameState.winner = gameState.winner
      ? room.players.findIndex((player) => player.id === gameState.winner)
      : "";
    delete gameState.goAt;
  }
  if (room.game === "battleship" && gameState.winner) {
    gameState.winner = room.players.findIndex((player) => player.id === gameState.winner);
  }
  return {
    code: room.code,
    game: room.game,
    phase: room.phase,
    ...(room.bot ? { mode: "single", difficulty: room.bot.difficulty } : {}),
    ...(room.closesAt ? { closesInMs: Math.max(0, room.closesAt - Date.now()) } : {}),
    players: room.players.map((player, index) => ({
      name: player.name,
      mark: room.game === "connect-four" ? (index === 0 ? "RED" : "YELLOW") : index === 0 ? "X" : "O",
      side: index,
      isHost: player.id === room.hostId,
    })),
    you: room.players.findIndex((player) => player.id === playerId),
    gameState,
  };
}

function findRoom(request, code, collection = rooms) {
  const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
  const room = collection.get(normalizedCode);
  if (room && room.closesAt && Date.now() >= room.closesAt) {
    collection.delete(normalizedCode);
    throw Object.assign(new Error("Room not found or access denied."), { status: 404 });
  }
  if (!room) throw Object.assign(new Error("Room not found or access denied."), { status: 404 });
  const authorization = request.headers.authorization || "";
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(authorization);
  const player = match && room.players.find((item) => !item.isBot && isValidToken(match[1], item.token));
  if (!player) throw Object.assign(new Error("Room not found or access denied."), { status: 404 });
  return { room, player };
}

function publicGroup(group, playerId) {
  return {
    code: group.code,
    members: group.players.map((member) => ({
      name: member.name,
      isHost: member.id === group.hostId,
      isPlaying: Boolean(group.game && group.game.players.some((player) => player.id === member.id)),
      isYou: member.id === playerId,
    })),
    isHost: group.hostId === playerId,
    round: group.round,
    room: group.game ? publicRoom(group.game, playerId) : null,
  };
}

function chooseGroupPlayers(group, game) {
  if (!TWO_PLAYER_GAMES.includes(game) || group.players.length === 2) {
    return [...group.players];
  }
  const pairs = [];
  for (let first = 0; first < group.players.length; first += 1) {
    for (let second = first + 1; second < group.players.length; second += 1) {
      const pair = [group.players[first], group.players[second]];
      const key = pair.map((player) => player.id).sort().join(":");
      if (group.pairStreak < 2 || key !== group.lastPair) pairs.push(pair);
    }
  }
  return shuffled(shuffled(pairs)[0]);
}

function startGroupGame(group, game) {
  if (!GAMES.includes(game)) throw Object.assign(new Error("Choose a valid game."), { status: 400 });
  if (group.game && group.game.phase === "playing") {
    throw Object.assign(new Error("Wait until the current game is finished."), { status: 409 });
  }
  if (group.players.length < 2) {
    throw Object.assign(new Error("Invite at least one more player to start."), { status: 409 });
  }
  const players = chooseGroupPlayers(group, game);
  const gameRoom = {
    code: group.code, game, phase: "lobby", hostId: group.hostId,
    players, gameState: makeGameState(game),
  };
  startRoom(gameRoom);
  if (TWO_PLAYER_GAMES.includes(game)) {
    const key = players.map((player) => player.id).sort().join(":");
    group.pairStreak = key === group.lastPair ? group.pairStreak + 1 : 1;
    group.lastPair = key;
  } else {
    group.lastPair = "";
    group.pairStreak = 0;
  }
  group.game = gameRoom;
  group.round += 1;
}

function removeGroupMember(group, player) {
  group.players = group.players.filter((member) => member.id !== player.id);
  if (group.hostId === player.id && group.players.length) group.hostId = group.players[0].id;
  const room = group.game;
  if (!room || room.phase !== "playing") return;
  const index = room.players.findIndex((member) => member.id === player.id);
  if (index < 0) return;
  if (room.players.length <= 2 || TWO_PLAYER_GAMES.includes(room.game)) {
    finishRoom(room);
    room.gameState.abandoned = true;
    room.gameState.message = "A player left. This game has ended.";
    return;
  }
  const state = room.gameState;
  room.players.splice(index, 1);
  if (state.scores) delete state.scores[player.id];
  if (state.choices) delete state.choices[player.id];
  if (typeof state.turn === "number") {
    if (index < state.turn) state.turn -= 1;
    else if (index === state.turn) state.turn %= room.players.length;
  }
  if (room.game === "rock-paper-scissors") resolveChoices(room);
  if (room.game === "reaction-race") {
    const remaining = room.players.filter((member) => !state.falseStarts.includes(member.id));
    if (remaining.length === 1) {
      state.winner = remaining[0].id;
      state.message = `${remaining[0].name} wins!`;
      finishRoom(room);
    } else if (!remaining.length) {
      state.abandoned = true;
      state.message = "A player left. This game has ended.";
      finishRoom(room);
    }
  }
}

function startRoom(room) {
  if (room.phase !== "lobby") {
    throw Object.assign(new Error("This game has already started."), { status: 409 });
  }
  if (room.players.length < 2) {
    throw Object.assign(new Error("Invite at least one more player to start."), { status: 409 });
  }
  room.phase = "playing";
  room.gameState = makeGameState(room.game);
  if (["quiz", "word-scramble", "rock-paper-scissors", "memory-match", "higher-lower"].includes(room.game)) {
    room.gameState.scores = Object.fromEntries(room.players.map((player) => [player.id, 0]));
  }
  if (room.game === "battleship") room.gameState.boards = makeBattleshipBoards(room.players);
  if (room.game === "reaction-race") {
    room.gameState.goAt = Date.now() + 2000 + Math.floor(Math.random() * 2500);
  }
}

function resolveChoices(room) {
  const state = room.gameState;
  if (state.answered || !room.players.every((item) => state.choices[item.id])) return;
  state.answered = true;
  const choices = [...new Set(room.players.map((item) => state.choices[item.id]))];
  if (choices.length === 2) {
    const [first, second] = choices;
    const firstWins = (first === "rock" && second === "scissors") ||
      (first === "paper" && second === "rock") ||
      (first === "scissors" && second === "paper");
    const winningChoice = firstWins ? first : second;
    for (const current of room.players) {
      if (state.choices[current.id] === winningChoice) state.scores[current.id] += 1;
    }
  }
  state.message = "Round complete!";
  setTimeout(() => {
    if (room.phase !== "playing" || !state.answered) return;
    if (state.round >= 5) {
      finishRoom(room);
      const highScore = Math.max(...room.players.map((item) => state.scores[item.id]));
      const winners = room.players.filter((item) => state.scores[item.id] === highScore);
      state.message = winners.length > 1 ? "It's a tie!" : `${winners[0].name} wins!`;
    } else {
      state.round += 1;
      state.choices = {};
      state.answered = false;
      state.message = "";
    }
  }, 3000);
}

function applyCommand(room, player, body) {
  const state = room.gameState;
  const allowedActions = {
    quiz: ["guess"],
    pong: ["paddle"],
    "tic-tac-toe": ["move"],
    "connect-four": ["drop"],
    "word-scramble": ["solve"],
    "memory-match": ["flip"],
    hangman: ["letter"],
    "rock-paper-scissors": ["choose"],
    "higher-lower": ["higher-lower"],
    battleship: ["place-ship", "reset-fleet", "ready-fleet", "fire"],
    "reaction-race": ["react"],
  };
  if (body.action !== "start" && !allowedActions[room.game]?.includes(body.action)) {
    throw Object.assign(new Error("Action is not valid for this game."), { status: 400 });
  }
  if (body.action === "start") {
    if (player.id !== room.hostId) {
      throw Object.assign(new Error("Only the host can start the game."), { status: 403 });
    }
    startRoom(room);
    return;
  }
  if (body.action === "move") {
    if (room.phase !== "playing" || room.game !== "tic-tac-toe") return;
    if (state.winner || room.players[state.turn]?.id !== player.id) return;
    const index = body.index;
    if (!Number.isInteger(index) || index < 0 || index > 8) {
      throw Object.assign(new Error("Choose a valid board cell."), { status: 400 });
    }
    if (state.board[index]) return;
    state.board[index] = state.turn === 0 ? "X" : "O";
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6],
    ];
    if (lines.some((line) => line.every((cell) => state.board[cell] === state.board[index]))) {
      state.winner = state.board[index];
      state.message = `${player.name} wins!`;
      finishRoom(room);
    } else if (state.board.every(Boolean)) {
      state.winner = "draw";
      state.message = "It's a draw!";
      finishRoom(room);
    } else {
      state.turn = 1 - state.turn;
    }
    return;
  }
  if (body.action === "drop") {
    if (room.phase !== "playing" || room.game !== "connect-four") return;
    if (state.winner || room.players[state.turn]?.id !== player.id) return;
    const column = body.column;
    if (!Number.isInteger(column) || column < 0 || column >= 7) {
      throw Object.assign(new Error("Choose a valid column."), { status: 400 });
    }
    let row = 5;
    while (row >= 0 && state.board[row * 7 + column]) row -= 1;
    if (row < 0) return;
    const mark = state.turn === 0 ? "R" : "Y";
    state.board[row * 7 + column] = mark;
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    const countDirection = (rowStep, columnStep) => {
      let count = 0;
      let nextRow = row + rowStep;
      let nextColumn = column + columnStep;
      while (
        nextRow >= 0 && nextRow < 6 && nextColumn >= 0 && nextColumn < 7 &&
        state.board[nextRow * 7 + nextColumn] === mark
      ) {
        count += 1;
        nextRow += rowStep;
        nextColumn += columnStep;
      }
      return count;
    };
    if (directions.some(([rowStep, columnStep]) =>
      1 + countDirection(rowStep, columnStep) + countDirection(-rowStep, -columnStep) >= 4
    )) {
      state.winner = mark;
      state.message = `${player.name} wins!`;
      finishRoom(room);
    } else if (state.board.every(Boolean)) {
      state.winner = "draw";
      state.message = "It's a draw!";
      finishRoom(room);
    } else {
      state.turn = 1 - state.turn;
    }
    return;
  }
  if (body.action === "flip") {
    if (room.phase !== "playing" || room.game !== "memory-match") return;
    if (state.revealed.length >= 2 || room.players[state.turn]?.id !== player.id) return;
    const index = body.index;
    if (!Number.isInteger(index) || index < 0 || index >= state.deck.length) {
      throw Object.assign(new Error("Choose a valid card."), { status: 400 });
    }
    if (state.matched[index] || state.revealed.includes(index)) return;
    state.revealed.push(index);
    if (state.revealed.length === 1) {
      state.firstPick = index;
      return;
    }
    const first = state.firstPick;
    const second = index;
    state.firstPick = null;
    if (state.deck[first] === state.deck[second]) {
      state.matched[first] = true;
      state.matched[second] = true;
      state.scores[player.id] += 1;
      state.revealed = [];
      state.message = `${player.name} found a pair!`;
      if (state.matched.every(Boolean)) {
        finishRoom(room);
        const [left, right] = room.players.map((item) => state.scores[item.id]);
        state.message = left === right
          ? "It's a draw!"
          : `${room.players[left > right ? 0 : 1].name} wins!`;
      }
    } else {
      state.message = "No match. Next player's turn.";
      setTimeout(() => {
        if (room.phase !== "playing" || room.game !== "memory-match") return;
        state.revealed = [];
        state.turn = 1 - state.turn;
      }, 1100);
    }
    return;
  }
  if (body.action === "letter") {
    if (room.phase !== "playing" || room.game !== "hangman") return;
    const letter = typeof body.letter === "string" ? body.letter.trim().toUpperCase() : "";
    if (!/^[A-Z]$/.test(letter)) {
      throw Object.assign(new Error("Guess a single letter from A to Z."), { status: 400 });
    }
    if (state.guesses.includes(letter)) return;
    state.guesses.push(letter);
    if (!state.word.includes(letter)) state.wrong += 1;
    if ([...state.word].every((item) => state.guesses.includes(item))) {
      finishRoom(room);
      state.message = "You solved it! Nice teamwork.";
    } else if (state.wrong >= 6) {
      finishRoom(room);
      state.message = `The word was ${state.word}.`;
    }
    return;
  }
  if (body.action === "choose") {
    if (room.phase !== "playing" || room.game !== "rock-paper-scissors" || state.answered) return;
    if (!["rock", "paper", "scissors"].includes(body.choice)) {
      throw Object.assign(new Error("Choose rock, paper, or scissors."), { status: 400 });
    }
    if (state.choices[player.id]) return;
    state.choices[player.id] = body.choice;
    resolveChoices(room);
    return;
  }
  if (body.action === "higher-lower") {
    if (room.phase !== "playing" || room.game !== "higher-lower") return;
    if (!["higher", "lower"].includes(body.guess)) {
      throw Object.assign(new Error("Choose higher or lower."), { status: 400 });
    }
    if (room.players[state.turn]?.id !== player.id) return;
    const correct = body.guess === "higher" ? state.target >= state.current : state.target <= state.current;
    state.round += 1;
    if (!correct) {
      finishRoom(room);
      state.message = `Not quite! The number was ${state.target}.`;
      return;
    }
    state.scores[player.id] += 1;
    state.message = `${player.name} guessed right!`;
    state.current = state.target;
    if (state.round >= 10) {
      finishRoom(room);
      const winner = room.players.reduce((best, item) =>
        state.scores[item.id] > state.scores[best.id] ? item : best, room.players[0]);
      state.message = `${winner.name} wins with ${state.scores[winner.id]} points!`;
    } else {
      state.turn = (state.turn + 1) % room.players.length;
      state.target = differentNumber(state.current);
    }
    return;
  }
  if (["place-ship", "reset-fleet", "ready-fleet"].includes(body.action)) {
    if (room.phase !== "playing" || state.stage !== "placement") {
      throw Object.assign(new Error("Fleet placement is no longer available."), { status: 409 });
    }
    const board = state.boards[player.id];
    if (board.ready) throw Object.assign(new Error("Your fleet is already ready."), { status: 409 });
    if (body.action === "reset-fleet") {
      board.ships = [];
      return;
    }
    if (body.action === "ready-fleet") {
      if (board.ships.length !== BATTLE_FLEET.length) {
        throw Object.assign(new Error("Place all ships first."), { status: 400 });
      }
      board.ready = true;
      if (room.players.every((member) => state.boards[member.id].ready)) state.stage = "battle";
      return;
    }
    const length = BATTLE_FLEET[board.ships.length];
    if (!length || !Number.isInteger(body.index) || body.index < 0 || body.index >= BATTLE_SIZE * BATTLE_SIZE ||
      !["horizontal", "vertical"].includes(body.orientation)) {
      throw Object.assign(new Error("Choose a valid ship placement."), { status: 400 });
    }
    const row = Math.floor(body.index / BATTLE_SIZE);
    const column = body.index % BATTLE_SIZE;
    if ((body.orientation === "horizontal" ? column : row) + length > BATTLE_SIZE) {
      throw Object.assign(new Error("The ship must fit on the board."), { status: 400 });
    }
    const step = body.orientation === "horizontal" ? 1 : BATTLE_SIZE;
    const cells = Array.from({ length }, (_, index) => body.index + index * step);
    if (board.ships.some((ship) => ship.cells.some((cell) => cells.includes(cell)))) {
      throw Object.assign(new Error("Ships cannot overlap."), { status: 400 });
    }
    board.ships.push({ cells, orientation: body.orientation });
    return;
  }
  if (body.action === "fire") {
    if (room.phase !== "playing" || room.game !== "battleship") return;
    if (state.stage !== "battle") throw Object.assign(new Error("Both fleets must be ready first."), { status: 409 });
    if (state.winner || room.players[state.turn]?.id !== player.id) return;
    const index = body.index;
    if (!Number.isInteger(index) || index < 0 || index >= BATTLE_SIZE * BATTLE_SIZE) {
      throw Object.assign(new Error("Choose a valid grid cell."), { status: 400 });
    }
    const opponent = room.players[1 - state.turn];
    const target = state.boards[opponent.id];
    if (target.shots[index]) return;
    const hit = target.ships.some((ship) => ship.cells.includes(index));
    target.shots[index] = hit ? "hit" : "miss";
    if (target.ships.every((ship) => ship.cells.every((cell) => target.shots[cell] === "hit"))) {
      state.winner = player.id;
      state.message = `${player.name} sank the fleet and wins!`;
      finishRoom(room);
    } else {
      state.turn = 1 - state.turn;
      state.message = hit ? `${player.name} scored a hit!` : `${player.name} missed.`;
    }
    return;
  }
  if (body.action === "react") {
    if (room.phase !== "playing" || room.game !== "reaction-race" || state.winner) return;
    if (state.falseStarts.includes(player.id)) return;
    if (Date.now() < state.goAt) {
      state.falseStarts.push(player.id);
      state.message = `${player.name} jumped the start!`;
      const remainingPlayers = room.players.filter((item) => !state.falseStarts.includes(item.id));
      if (remainingPlayers.length === 1) {
        state.winner = remainingPlayers[0].id;
        state.message = `${remainingPlayers[0].name} wins!`;
        finishRoom(room);
      }
      return;
    }
    state.winner = player.id;
    state.message = `${player.name} reacted first!`;
    finishRoom(room);
    return;
  }
  if (body.action === "guess" || body.action === "solve") {
    const isQuiz = room.game === "quiz" && body.action === "guess";
    const isWordScramble = room.game === "word-scramble" && body.action === "solve";
    if (room.phase !== "playing" || (!isQuiz && !isWordScramble) || state.answered) return;
    if (typeof body.answer !== "string" || body.answer.length > 100) {
      throw Object.assign(new Error("Enter an answer of at most 100 characters."), { status: 400 });
    }
    const answer = body.answer.trim().toLowerCase();
    const currentAnswer = isQuiz
      ? quizQuestions[state.questionIndex]?.answer
      : scrambledWords[state.questionIndex]?.word.toLowerCase();
    if (!answer) {
      throw Object.assign(new Error("Enter an answer."), { status: 400 });
    }
    if (!currentAnswer) return;
    if (answer !== currentAnswer) {
      state.message = isQuiz ? "Not quite. Try again!" : "Not that word. Give it another go!";
      return;
    }
    state.answered = true;
    state.scores[player.id] = (state.scores[player.id] || 0) + 1;
    state.message = isQuiz ? `${player.name} got it!` : `${player.name} unscrambled it!`;
    setTimeout(() => {
      if (room.phase !== "playing" || !state.answered) return;
      state.questionIndex += 1;
      const roundCount = isQuiz ? quizQuestions.length : scrambledWords.length;
      if (state.questionIndex >= roundCount) {
        finishRoom(room);
        const winner = room.players.reduce((best, item) =>
          state.scores[item.id] > (state.scores[best?.id] ?? -1) ? item : best, null);
        state.message = winner
          ? `${winner.name} wins ${isQuiz ? "the quiz" : "the word scramble"}!`
          : "Game complete!";
      } else {
        state.answered = false;
        state.message = "";
      }
    }, 1400);
    return;
  }
  if (body.action === "paddle") {
    if (room.phase !== "playing" || room.game !== "pong") return;
    if (typeof body.direction !== "number" || ![-1, 0, 1].includes(body.direction)) {
      throw Object.assign(new Error("Paddle direction must be -1, 0, or 1."), { status: 400 });
    }
    const side = room.players.findIndex((item) => item.id === player.id);
    state.directions[side] = body.direction;
  }
}

function updatePong(room) {
  if (room.phase !== "playing" || room.game !== "pong") return;
  const state = room.gameState;
  state.paddles = state.paddles.map((position, index) =>
    Math.max(0.12, Math.min(0.88, position + state.directions[index] * 0.018)));
  const ball = state.ball;
  ball.x += ball.vx;
  ball.y += ball.vy;
  if (ball.y < 0.02 || ball.y > 0.98) ball.vy *= -1;
  if (ball.x < 0.08 && Math.abs(ball.y - state.paddles[0]) < 0.16) {
    ball.x = 0.08;
    ball.vx = Math.abs(ball.vx) * 1.03;
  } else if (ball.x > 0.92 && Math.abs(ball.y - state.paddles[1]) < 0.16) {
    ball.x = 0.92;
    ball.vx = -Math.abs(ball.vx) * 1.03;
  }
  if (ball.x < 0 || ball.x > 1) {
    const scorer = ball.x < 0 ? 1 : 0;
    state.scores[scorer] += 1;
    if (state.scores[scorer] >= 5) {
      finishRoom(room);
      state.message = `${room.players[scorer].name} wins!`;
      return;
    }
    state.ball = { x: 0.5, y: 0.5, vx: scorer === 0 ? 0.008 : -0.008, vy: Math.random() * 0.008 - 0.004 };
  }
}

function prepareBotFleet(room) {
  const player = room.players[1];
  const board = room.gameState.boards[player.id];
  for (const length of BATTLE_FLEET) {
    const placements = [];
    for (let index = 0; index < BATTLE_SIZE * BATTLE_SIZE; index += 1) {
      for (const orientation of ["horizontal", "vertical"]) {
        const row = Math.floor(index / BATTLE_SIZE);
        const column = index % BATTLE_SIZE;
        if ((orientation === "horizontal" ? column : row) + length > BATTLE_SIZE) continue;
        const step = orientation === "horizontal" ? 1 : BATTLE_SIZE;
        const cells = Array.from({ length }, (_, cell) => index + cell * step);
        if (!board.ships.some((ship) => ship.cells.some((cell) => cells.includes(cell)))) {
          placements.push({ index, orientation });
        }
      }
    }
    if (!placements.length) throw new Error("Bot could not place its fleet.");
    const placement = placements[Math.floor(Math.random() * placements.length)];
    applyCommand(room, player, { action: "place-ship", ...placement });
  }
  applyCommand(room, player, { action: "ready-fleet" });
}

function runBot(room, now) {
  if (!room.bot || room.phase !== "playing" || now < room.bot.nextAt) return;
  const bot = room.bot;
  const player = room.players[1];
  const state = room.gameState;
  const delay = { easy: 900, medium: 600, hard: 350 }[bot.difficulty];
  bot.nextAt = now + delay;
  if (room.game === "pong") {
    bot.pongOffset = Math.random() * 2 - 1;
    state.directions[1] = bots.pongDirection(state, bot);
    return;
  }
  if (room.game === "battleship" && state.stage === "placement") return;
  if (state.turn !== 1) return;
  if (room.game === "tic-tac-toe") {
    applyCommand(room, player, { action: "move", index: bots.ticMove([...state.board], bot.difficulty) });
  } else if (room.game === "connect-four") {
    applyCommand(room, player, { action: "drop", column: bots.connectMove([...state.board], bot.difficulty) });
  } else if (room.game === "memory-match" && state.revealed.length < 2) {
    applyCommand(room, player, { action: "flip", index: bots.memoryMove(state, bot) });
    bots.rememberCards(bot, state);
  } else if (room.game === "battleship") {
    const visibleBoard = publicRoom(room, player.id).gameState.targetBoard;
    applyCommand(room, player, { action: "fire", index: bots.battleMove(visibleBoard, bot.difficulty) });
  }
}

async function handleApi(request, response, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/pong-stream") {
      const collection = url.searchParams.get("group") === "1" ? groups : rooms;
      const { room: container, player } = findRoom(request, url.searchParams.get("code"), collection);
      const game = collection === groups ? container.game : container;
      if (!game || game.game !== "pong" || game.phase !== "playing") {
        return sendJson(response, 409, { error: "Paddle Clash is not playing." });
      }
      if (pongStreams.size >= MAX_PONG_STREAMS ||
        [...pongStreams].filter((stream) => stream.playerId === player.id).length >= 2) {
        return sendJson(response, 503, { error: "Too many live game connections. Please try again later." });
      }
      const stream = { playerId: player.id, response };
      pongStreams.add(stream);
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      const timer = setInterval(() => {
        if (collection.get(container.code) !== container ||
          !container.players.some((member) => member.id === player.id) ||
          (collection === groups && container.game !== game) || game.phase !== "playing") {
          response.end('{"ended":true}\n');
          return;
        }
        const { ball, paddles, scores } = game.gameState;
        if (!response.write(`${JSON.stringify({ ball, paddles, scores })}\n`)) response.destroy();
      }, 50);
      response.on("close", () => {
        clearInterval(timer);
        pongStreams.delete(stream);
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/single") {
      if (rooms.size + groups.size >= MAX_ROOMS) {
        return sendJson(response, 503, { error: "The server is full. Please try again later." });
      }
      const body = await readJson(request);
      const name = cleanName(body.name);
      if (!name) return sendJson(response, 400, { error: "Enter a player name." });
      if (!TWO_PLAYER_GAMES.includes(body.game) || !bots.DIFFICULTIES.includes(body.difficulty)) {
        return sendJson(response, 400, { error: "Choose a valid game and difficulty." });
      }
      const player = createPlayer();
      player.name = name;
      const opponent = { id: randomUUID(), name: "Bot", isBot: true };
      const room = {
        code: createCode(), game: body.game, phase: "lobby", hostId: player.id,
        players: [player, opponent], gameState: makeGameState(body.game), createdAt: Date.now(),
        bot: { difficulty: body.difficulty, nextAt: 0, memory: {}, pongOffset: 0 },
      };
      startRoom(room);
      if (room.game === "battleship") prepareBotFleet(room);
      rooms.set(room.code, room);
      return sendJson(response, 201, { ...publicRoom(room, player.id), playerToken: player.token });
    }
    if (request.method === "POST" && url.pathname === "/api/groups") {
      if (rooms.size + groups.size >= MAX_ROOMS) {
        return sendJson(response, 503, { error: "The server is full. Please try again later." });
      }
      const body = await readJson(request);
      const name = cleanName(body.name);
      if (!name) return sendJson(response, 400, { error: "Enter a player name." });
      let code;
      if (body.code !== undefined && body.code !== "") {
        if (typeof body.code !== "string" || !/^[A-Za-z0-9]{4,16}$/.test(body.code)) {
          return sendJson(response, 400, { error: "Room code must contain 4 to 16 letters or numbers." });
        }
        code = body.code.toUpperCase();
        if (groups.has(code)) return sendJson(response, 409, { error: "That room code is already in use." });
      } else {
        code = createCode(groups);
      }
      const player = createPlayer();
      player.name = name;
      const group = { code, hostId: player.id, players: [player], game: null, round: 0, lastPair: "", pairStreak: 0, createdAt: Date.now() };
      groups.set(code, group);
      return sendJson(response, 201, { ...publicGroup(group, player.id), playerToken: player.token });
    }
    if (request.method === "POST" && url.pathname === "/api/groups/join") {
      const body = await readJson(request);
      const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      const group = groups.get(code);
      const name = cleanName(body.name);
      if (!name) return sendJson(response, 400, { error: "Enter a player name." });
      if (!/^[A-Z0-9]{4,16}$/.test(code) || !group || group.players.length >= 8) {
        return sendJson(response, 404, { error: "Group not found or unavailable." });
      }
      const player = createPlayer();
      player.name = name;
      group.players.push(player);
      return sendJson(response, 201, { ...publicGroup(group, player.id), playerToken: player.token });
    }
    if (request.method === "GET" && url.pathname === "/api/groups/state") {
      const { room: group, player } = findRoom(request, url.searchParams.get("code"), groups);
      return sendJson(response, 200, publicGroup(group, player.id));
    }
    if (request.method === "POST" && url.pathname === "/api/groups/action") {
      const body = await readJson(request);
      const { room: group, player } = findRoom(request, body.code, groups);
      if (body.action === "leave") {
        removeGroupMember(group, player);
        if (!group.players.length) groups.delete(group.code);
        return sendJson(response, 200, { left: true });
      }
      if (body.action === "select-game") {
        if (player.id !== group.hostId) throw Object.assign(new Error("Only the host can select a game."), { status: 403 });
        startGroupGame(group, body.game);
      } else {
        if (!group.game || !group.game.players.some((member) => member.id === player.id)) {
          throw Object.assign(new Error("Spectators cannot perform game actions."), { status: 403 });
        }
        if (body.action === "start") throw Object.assign(new Error("Action is not valid for this game."), { status: 400 });
        applyCommand(group.game, player, body);
      }
      return sendJson(response, 200, publicGroup(group, player.id));
    }
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      if (rooms.size + groups.size >= MAX_ROOMS) {
        return sendJson(response, 503, { error: "The server is full. Please try again later." });
      }
      const body = await readJson(request);
      const name = cleanName(body.name);
      const game = body.game;
      if (!name) return sendJson(response, 400, { error: "Enter a player name." });
      if (!GAMES.includes(game)) {
        return sendJson(response, 400, { error: "Choose a valid game." });
      }
      let code;
      if (body.code !== undefined && body.code !== "") {
        if (typeof body.code !== "string" || !/^[A-Za-z0-9]{4,16}$/.test(body.code)) {
          return sendJson(response, 400, { error: "Room code must contain 4 to 16 letters or numbers." });
        }
        code = body.code.toUpperCase();
        if (rooms.has(code)) return sendJson(response, 409, { error: "That room code is already in use." });
      } else {
        code = createCode();
      }
      const player = createPlayer();
      player.name = name;
      const room = {
        code,
        game,
        phase: "lobby",
        hostId: player.id,
        players: [player],
        gameState: makeGameState(game),
        createdAt: Date.now(),
      };
      rooms.set(code, room);
      return sendJson(response, 201, { ...publicRoom(room, player.id), playerToken: player.token });
    }
    if (request.method === "POST" && url.pathname === "/api/join") {
      const body = await readJson(request);
      const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      const room = rooms.get(code);
      const name = cleanName(body.name);
      if (!name) return sendJson(response, 400, { error: "Enter a player name." });
      if (!/^[A-Z0-9]{4,16}$/.test(code) || !room || room.phase !== "lobby") {
        return sendJson(response, 404, { error: "Room not found or unavailable." });
      }
      const capacity = TWO_PLAYER_GAMES.includes(room.game) ? 2 : 8;
      if (room.players.length >= capacity) return sendJson(response, 404, { error: "Room not found or unavailable." });
      const player = createPlayer();
      player.name = name;
      room.players.push(player);
      return sendJson(response, 201, { ...publicRoom(room, player.id), playerToken: player.token });
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      const { room, player } = findRoom(request, url.searchParams.get("code"));
      return sendJson(response, 200, publicRoom(room, player.id));
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      const body = await readJson(request);
      const { room, player } = findRoom(request, body.code);
      if (room.bot && body.action === "leave") {
        rooms.delete(room.code);
        return sendJson(response, 200, { left: true });
      }
      applyCommand(room, player, body);
      if (room.bot && room.game === "memory-match") bots.rememberCards(room.bot, room.gameState);
      return sendJson(response, 200, publicRoom(room, player.id));
    }
    return sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status === 500) console.error("API request failed:", error);
    return sendJson(response, status, {
      error: status === 500 ? "The server could not complete the request." : error.message,
    });
  }
}

const server = http.createServer((request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  let url;
  try {
    url = new URL(request.url, "http://localhost");
  } catch {
    return sendJson(response, 400, { error: "Invalid request URL." });
  }
  if (url.pathname.startsWith("/api/")) {
    const route = request.method === "GET" && url.pathname === "/api/groups/state" ? "group-state" :
      request.method === "GET" && url.pathname === "/api/state" ? "state" :
      request.method === "POST" && ["/api/action", "/api/groups/action"].includes(url.pathname) ? "action" :
        request.method === "POST" && ["/api/rooms", "/api/groups", "/api/single"].includes(url.pathname) ? "create" :
          request.method === "POST" && ["/api/join", "/api/groups/join"].includes(url.pathname) ? "join" : "default";
    const retryAfter = enforceRateLimit(request, route);
    if (retryAfter) return rateLimitResponse(response, retryAfter);
    if (request.method === "POST" && !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
      return sendJson(response, 415, { error: "Content-Type must be application/json." });
    }
    handleApi(request, response, url);
    return;
  }
  const requestedFile = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (request.method !== "GET" || !Object.prototype.hasOwnProperty.call(MIME_TYPES, path.extname(requestedFile)) ||
    !["index.html", "app.js", "game-outcome.js", "styles.css"].includes(requestedFile)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const filePath = path.join(publicDirectory, requestedFile);
  const content = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath)],
    "Cache-Control": "no-store",
  });
  response.end(content);
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt >= 6 * 60 * 60 * 1000) rooms.delete(code);
  }
  for (const [code, group] of groups) {
    if (now - group.createdAt >= 6 * 60 * 60 * 1000) groups.delete(code);
  }
  for (const [key, bucket] of requestBuckets) {
    if (now >= bucket.resetAt) requestBuckets.delete(key);
  }
}, 60_000);

setInterval(() => {
  for (const room of rooms.values()) updatePong(room);
  for (const group of groups.values()) {
    if (group.game) updatePong(group.game);
  }
}, 16);

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.bot) runBot(room, now);
  }
}, 100);

server.listen(PORT, () => {
  console.log(`Play Together is ready at http://localhost:${PORT}`);
});
