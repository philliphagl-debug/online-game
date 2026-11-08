const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

let server;
let baseUrl;
let ipCounter = 1;

before(async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), TRUST_PROXY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start in time.")), 5000);
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Server exited early: ${code}`)));
    server.stdout.once("data", () => { clearTimeout(timer); resolve(); });
  });
});

after(() => {
  if (server && server.exitCode === null) server.kill();
});

async function request(pathname, { token, body, ip = "192.0.2.1" } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Forwarded-For": ip,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

async function createGroup(size) {
  const ip = `198.51.100.${ipCounter++}`;
  const created = await request("/api/groups", { body: { name: "Player0" }, ip });
  assert.equal(created.status, 201);
  const players = [{ name: "Player0", token: created.data.playerToken }];
  for (let index = 1; index < size; index += 1) {
    const name = `Player${index}`;
    const joined = await request("/api/groups/join", { body: { name, code: created.data.code }, ip });
    assert.equal(joined.status, 201);
    players.push({ name, token: joined.data.playerToken });
  }
  return { code: created.data.code, players, ip };
}

function action(group, player, actionName, extra = {}) {
  return request("/api/groups/action", {
    token: player.token,
    body: { code: group.code, action: actionName, ...extra },
    ip: group.ip,
  });
}

test("single-player sessions validate games, difficulty, and access", async () => {
  const ip = `198.51.100.${ipCounter++}`;
  for (const body of [
    { name: "Player", game: "quiz", difficulty: "hard" },
    { name: "Player", game: "pong", difficulty: "impossible" },
    { name: "", game: "pong", difficulty: "easy" },
  ]) {
    assert.equal((await request("/api/single", { body, ip })).status, 400);
  }
  const created = await request("/api/single", { body: { name: "Player", game: "tic-tac-toe", difficulty: "hard" }, ip });
  assert.equal(created.status, 201);
  assert.equal(created.data.mode, "single");
  assert.equal(created.data.difficulty, "hard");
  assert.equal(created.data.players.length, 2);
  assert.equal(created.data.phase, "playing");
  assert.equal((await request("/api/join", { body: { name: "Other", code: created.data.code }, ip })).status, 404);
  assert.equal((await request(`/api/state?code=${created.data.code}`, { token: "a".repeat(64), ip })).status, 404);
  assert.equal((await request("/api/action", { token: created.data.playerToken, body: { code: created.data.code, action: "leave" }, ip })).status, 200);
  assert.equal((await request(`/api/state?code=${created.data.code}`, { token: created.data.playerToken, ip })).status, 404);
});

test("all single-player games and difficulties start with functioning opponents", async () => {
  for (const game of ["tic-tac-toe", "connect-four", "memory-match", "battleship", "pong"]) {
    for (const difficulty of ["easy", "medium", "hard"]) {
      const ip = `198.51.100.${ipCounter++}`;
      const created = await request("/api/single", { body: { name: "Player", game, difficulty }, ip });
      assert.equal(created.status, 201, `${game} ${difficulty}`);
      const { code, playerToken: token } = created.data;
      const command = (actionName, extra = {}) => request("/api/action", {
        token, body: { code, action: actionName, ...extra }, ip,
      });
      const state = () => request(`/api/state?code=${code}`, { token, ip });
      if (game === "tic-tac-toe" || game === "connect-four") {
        const commandBody = game === "tic-tac-toe" ? ["move", { index: 0 }] : ["drop", { column: 0 }];
        assert.equal((await command(...commandBody)).status, 200);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const result = await state();
        assert.equal(result.data.gameState.turn, 0, `${game} ${difficulty}`);
        assert.equal(result.data.gameState.board.filter(Boolean).length, 2);
      } else if (game === "battleship") {
        for (const index of [0, 10, 20, 30, 40]) {
          assert.equal((await command("place-ship", { index, orientation: "horizontal" })).status, 200);
        }
        assert.equal((await command("ready-fleet")).data.gameState.stage, "battle");
        assert.equal((await command("fire", { index: 0 })).status, 200);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal((await state()).data.gameState.turn, 0, `${game} ${difficulty}`);
      } else if (game === "memory-match") {
        let current = created.data.gameState;
        while (current.turn === 0 && current.revealed.length < 2 && current.matched.filter(Boolean).length < 16) {
          const index = current.matched.findIndex((matched, i) => !matched && !current.revealed.includes(i));
          current = (await command("flip", { index })).data.gameState;
        }
        assert.equal(current.revealed.length, 2);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        let progressed = false;
        for (let attempt = 0; attempt < 20 && !progressed; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const result = (await state()).data.gameState;
          progressed = (result.turn === 0 && result.revealed.length === 0) || (result.turn === 1 && result.revealed.length === 1) ||
            result.matched.filter(Boolean).length > current.matched.filter(Boolean).length;
        }
        assert.ok(progressed, `Memory bot did not play on ${difficulty}`);
      } else {
        const initial = created.data.gameState.ball.x;
        let moved = false;
        let result;
        for (let attempt = 0; attempt < 12 && !moved; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          result = await state();
          moved = result.data.gameState.paddles[1] !== 0.5;
        }
        assert.notEqual(result.data.gameState.ball.x, initial);
        assert.ok(moved, `Pong bot moved on ${difficulty}`);
      }
      assert.equal((await command("leave")).status, 200);
    }
  }
});

test("a complete single-player Tic-Tac-Toe game reaches a result", async () => {
  const ip = `198.51.100.${ipCounter++}`;
  const created = await request("/api/single", { body: { name: "Player", game: "tic-tac-toe", difficulty: "hard" }, ip });
  const { code, playerToken: token } = created.data;
  let room = created.data;
  for (let attempt = 0; attempt < 30 && room.phase === "playing"; attempt += 1) {
    if (room.gameState.turn === 0) {
      const index = room.gameState.board.findIndex((mark) => !mark);
      room = (await request("/api/action", { token, body: { code, action: "move", index }, ip })).data;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200));
      room = (await request(`/api/state?code=${code}`, { token, ip })).data;
    }
  }
  assert.equal(room.phase, "finished");
  assert.ok(["O", "draw"].includes(room.gameState.winner));
  assert.ok(room.closesInMs > 0);
});

test("groups retain members across games and prevent three consecutive identical pairs", async () => {
  const group = await createGroup(3);
  const previous = [];
  for (let round = 0; round < 15; round += 1) {
    const started = await action(group, group.players[0], "select-game", { game: "tic-tac-toe" });
    assert.equal(started.status, 200);
    assert.equal(started.data.members.length, 3);
    const playing = started.data.room.players.map((player) => player.name);
    assert.equal(playing.length, 2);
    const pair = [...playing].sort().join(",");
    if (previous.length >= 2 && previous.at(-1) === previous.at(-2)) assert.notEqual(pair, previous.at(-1));
    previous.push(pair);
    const spectator = group.players.find((player) => !playing.includes(player.name));
    assert.equal((await action(group, spectator, "move", { index: 0 })).status, 403);
    assert.equal((await action(group, group.players[0], "select-game", { game: "quiz" })).status, 409);
    for (const [side, index] of [[0, 0], [1, 3], [0, 1], [1, 4], [0, 2]]) {
      const current = group.players.find((player) => player.name === playing[side]);
      const result = await action(group, current, "move", { index });
      assert.equal(result.status, 200);
      if (index === 2) assert.equal(result.data.room.phase, "finished");
    }
  }
});

test("spectators cannot see Battleship fleets or act; late joiners remain spectators", async () => {
  const group = await createGroup(3);
  const started = await action(group, group.players[0], "select-game", { game: "battleship" });
  assert.equal(started.status, 200);
  const playing = started.data.room.players.map((player) => player.name);
  const spectator = group.players.find((player) => !playing.includes(player.name));
  const state = await request(`/api/groups/state?code=${group.code}`, { token: spectator.token, ip: group.ip });
  assert.equal(state.data.room.you, -1);
  assert.equal("ownBoard" in state.data.room.gameState, false);
  assert.equal("targetBoard" in state.data.room.gameState, false);
  assert.equal("boards" in state.data.room.gameState, false);
  assert.equal((await action(group, spectator, "fire", { index: 0 })).status, 403);
  assert.equal((await action(group, spectator, "place-ship", { index: 0, orientation: "horizontal" })).status, 403);
  const late = await request("/api/groups/join", { body: { code: group.code, name: "Late" }, ip: group.ip });
  assert.equal(late.status, 201);
  assert.equal(late.data.room.you, -1);
  assert.equal(late.data.members.find((member) => member.isYou).isPlaying, false);
  assert.equal((await action(group, group.players[1], "select-game", { game: "quiz" })).status, 403);
});

test("Battleship validates fleets, hides them, and finishes after every ship is sunk", async () => {
  const group = await createGroup(3);
  const started = await action(group, group.players[0], "select-game", { game: "battleship" });
  const players = started.data.room.players.map((member) => group.players.find((player) => player.name === member.name));
  const spectator = group.players.find((player) => !players.includes(player));
  const place = (player, index, orientation = "horizontal") => action(group, player, "place-ship", { index, orientation });
  assert.equal((await action(group, players[0], "fire", { index: 0 })).status, 409);
  assert.equal((await action(group, players[0], "ready-fleet")).status, 400);
  assert.equal((await place(players[0], 9)).status, 400);
  assert.equal((await place(players[0], 90, "vertical")).status, 400);
  assert.equal((await place(players[0], 0)).status, 200);
  assert.equal((await place(players[0], 1)).status, 400);
  assert.equal((await action(group, players[0], "reset-fleet")).data.room.gameState.placedCount, 0);
  for (const player of players) {
    for (const index of [0, 10, 20, 30, 40]) assert.equal((await place(player, index)).status, 200);
  }
  const privateState = await request(`/api/groups/state?code=${group.code}`, { token: players[0].token, ip: group.ip });
  assert.equal(privateState.data.room.gameState.ownBoard.filter(Boolean).length, 17);
  assert.equal("targetBoard" in privateState.data.room.gameState, false);
  assert.equal("boards" in privateState.data.room.gameState, false);
  const watchingSetup = await request(`/api/groups/state?code=${group.code}`, { token: spectator.token, ip: group.ip });
  assert.equal("ownBoard" in watchingSetup.data.room.gameState, false);
  assert.equal((await action(group, players[0], "ready-fleet")).status, 200);
  assert.equal((await place(players[0], 50)).status, 409);
  assert.equal((await action(group, players[1], "ready-fleet")).data.room.gameState.stage, "battle");
  const battle = await request(`/api/groups/state?code=${group.code}`, { token: players[0].token, ip: group.ip });
  assert.equal("ownBoard" in battle.data.room.gameState, false);
  assert.deepEqual(battle.data.room.gameState.targetBoard, Array(100).fill(""));
  const watching = await request(`/api/groups/state?code=${group.code}`, { token: spectator.token, ip: group.ip });
  assert.equal("ownBoard" in watching.data.room.gameState, false);
  assert.deepEqual(watching.data.room.gameState.targetBoard, Array(100).fill(""));
  const targets = [0, 1, 10, 11, 12, 20, 21, 22, 30, 31, 32, 33, 40, 41, 42, 43, 44];
  for (let turn = 0; turn < targets.length; turn += 1) {
    const hit = await action(group, players[0], "fire", { index: targets[turn] });
    assert.equal(hit.status, 200);
    if (turn === 1) assert.deepEqual(hit.data.room.gameState.targetBoard.slice(0, 2), ["sunk", "sunk"]);
    if (turn < targets.length - 1) {
      assert.equal(hit.data.room.phase, "playing");
      assert.equal((await action(group, players[1], "fire", { index: 70 + turn })).status, 200);
    } else {
      assert.equal(hit.data.room.phase, "finished");
      assert.equal(hit.data.room.gameState.winner, 0);
      assert.equal(hit.data.room.gameState.targetBoard.filter((mark) => mark === "sunk").length, 17);
    }
  }
});

test("Battleship placement also works in individual rooms", async () => {
  const ip = `198.51.100.${ipCounter++}`;
  const created = await request("/api/rooms", { body: { name: "Host", game: "battleship" }, ip });
  const code = created.data.code;
  const joined = await request("/api/join", { body: { code, name: "Guest" }, ip });
  const tokens = [created.data.playerToken, joined.data.playerToken];
  const command = (side, actionName, extra = {}) => request("/api/action", {
    token: tokens[side], body: { code, action: actionName, ...extra }, ip,
  });
  assert.equal((await command(0, "start")).status, 200);
  for (const side of [0, 1]) {
    for (const index of [0, 2, 4, 6, 8]) {
      assert.equal((await command(side, "place-ship", { index, orientation: "vertical" })).status, 200);
    }
    assert.equal((await command(side, "ready-fleet")).status, 200);
  }
  assert.equal((await command(0, "fire", { index: 0 })).data.gameState.targetBoard[0], "hit");
});

test("a group can select a new game if a player leaves during Battleship placement", async () => {
  const group = await createGroup(3);
  const started = await action(group, group.players[0], "select-game", { game: "battleship" });
  const leaving = group.players.find((player) => player.name === started.data.room.players[1].name);
  assert.equal((await action(group, leaving, "leave")).status, 200);
  const host = leaving === group.players[0] ? group.players[1] : group.players[0];
  const state = await request(`/api/groups/state?code=${group.code}`, { token: host.token, ip: group.ip });
  assert.equal(state.data.room.phase, "finished");
  assert.equal(state.data.room.gameState.abandoned, true);
  assert.equal((await action(group, host, "select-game", { game: "quiz" })).status, 200);
});

test("all eight join a multiplayer game and host transfer preserves the group", async () => {
  const group = await createGroup(8);
  const started = await action(group, group.players[0], "select-game", { game: "quiz" });
  assert.equal(started.status, 200);
  assert.equal(started.data.room.players.length, 8);
  assert.equal(started.data.members.filter((member) => member.isPlaying).length, 8);
  assert.equal((await action(group, group.players[0], "leave")).status, 200);
  const state = await request(`/api/groups/state?code=${group.code}`, { token: group.players[1].token, ip: group.ip });
  assert.equal(state.status, 200);
  assert.equal(state.data.isHost, true);
  assert.equal(state.data.members.length, 7);
  assert.equal(state.data.room.phase, "playing");
  assert.equal((await action(group, group.players[0], "guess", { answer: "jupiter" })).status, 404);
});

test("leaving a two-player game ends it and host can choose another game", async () => {
  const group = await createGroup(3);
  const started = await action(group, group.players[0], "select-game", { game: "tic-tac-toe" });
  const playing = started.data.room.players.map((player) => player.name);
  const leaving = group.players.find((player) => player.name === playing[0]);
  assert.equal((await action(group, leaving, "leave")).status, 200);
  const remaining = group.players.filter((player) => player !== leaving);
  const state = await request(`/api/groups/state?code=${group.code}`, { token: remaining[0].token, ip: group.ip });
  assert.equal(state.data.room.phase, "finished");
  assert.equal(state.data.room.gameState.abandoned, true);
  const host = leaving === group.players[0] ? group.players[1] : group.players[0];
  const next = await action(group, host, "select-game", { game: "quiz" });
  assert.equal(next.status, 200);
  assert.equal(next.data.members.length, 2);
});

test("rock-paper-scissors continues when the remaining players have already chosen", async () => {
  const group = await createGroup(3);
  await action(group, group.players[0], "select-game", { game: "rock-paper-scissors" });
  await action(group, group.players[0], "choose", { choice: "rock" });
  await action(group, group.players[1], "choose", { choice: "scissors" });
  await action(group, group.players[2], "leave");
  const state = await request(`/api/groups/state?code=${group.code}`, { token: group.players[0].token, ip: group.ip });
  assert.equal(state.data.room.phase, "playing");
  assert.equal(state.data.room.gameState.answered, true);
  assert.deepEqual(state.data.room.gameState.scores, [1, 0]);
});

test("rock-paper-scissors keeps choices private until a three-second reveal", async () => {
  const group = await createGroup(2);
  await action(group, group.players[0], "select-game", { game: "rock-paper-scissors" });
  const first = await action(group, group.players[0], "choose", { choice: "rock" });
  assert.deepEqual(first.data.room.gameState.choices, []);
  const waiting = await request(`/api/groups/state?code=${group.code}`, { token: group.players[1].token, ip: group.ip });
  assert.deepEqual(waiting.data.room.gameState.choices, []);
  assert.equal(waiting.data.room.gameState.playerHasChosen, false);
  const second = await action(group, group.players[1], "choose", { choice: "paper" });
  assert.deepEqual(second.data.room.gameState.choices, ["rock", "paper"]);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const reveal = await request(`/api/groups/state?code=${group.code}`, { token: group.players[0].token, ip: group.ip });
  assert.equal(reveal.data.room.gameState.answered, true);
  assert.deepEqual(reveal.data.room.gameState.choices, ["rock", "paper"]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const next = await request(`/api/groups/state?code=${group.code}`, { token: group.players[0].token, ip: group.ip });
  assert.equal(next.data.room.gameState.round, 2);
  assert.deepEqual(next.data.room.gameState.choices, []);
});

test("an abandoned rock-paper-scissors round does not reveal a partial choice", async () => {
  const group = await createGroup(2);
  await action(group, group.players[0], "select-game", { game: "rock-paper-scissors" });
  await action(group, group.players[0], "choose", { choice: "scissors" });
  await action(group, group.players[1], "leave");
  const state = await request(`/api/groups/state?code=${group.code}`, { token: group.players[0].token, ip: group.ip });
  assert.equal(state.data.room.gameState.abandoned, true);
  assert.deepEqual(state.data.room.gameState.choices, []);
});

test("finished individual rooms close after five seconds while groups stay together", async () => {
  const group = await createGroup(2);
  const created = await request("/api/rooms", {
    body: { name: "Host", game: "tic-tac-toe", code: group.code }, ip: group.ip,
  });
  assert.equal(created.status, 201);
  const joined = await request("/api/join", { body: { name: "Guest", code: group.code }, ip: group.ip });
  assert.equal(joined.status, 201);
  const tokens = [created.data.playerToken, joined.data.playerToken];
  const roomAction = (side, actionName, extra = {}) => request("/api/action", {
    token: tokens[side], body: { code: group.code, action: actionName, ...extra }, ip: group.ip,
  });
  await roomAction(0, "start");
  await action(group, group.players[0], "select-game", { game: "tic-tac-toe" });
  let finalRoom;
  for (const [side, index] of [[0, 0], [1, 3], [0, 1], [1, 4], [0, 2]]) {
    finalRoom = await roomAction(side, "move", { index });
    await action(group, group.players[side], "move", { index });
  }
  assert.equal(finalRoom.data.phase, "finished");
  assert.ok(finalRoom.data.closesInMs > 4500 && finalRoom.data.closesInMs <= 5000);
  const finalGroup = await request(`/api/groups/state?code=${group.code}`, { token: group.players[0].token, ip: group.ip });
  assert.equal(finalGroup.data.room.phase, "finished");
  assert.equal("closesInMs" in finalGroup.data.room, false);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal((await request(`/api/state?code=${group.code}`, { token: tokens[1], ip: group.ip })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  for (const token of tokens) {
    assert.equal((await request(`/api/state?code=${group.code}`, { token, ip: group.ip })).status, 404);
  }
  const survivingGroup = await request(`/api/groups/state?code=${group.code}`, { token: group.players[1].token, ip: group.ip });
  assert.equal(survivingGroup.status, 200);
  assert.equal(survivingGroup.data.members.length, 2);
  assert.equal((await action(group, group.players[0], "select-game", { game: "quiz" })).status, 200);
});

test("a game that finishes on a timer also schedules room closure", async () => {
  const ip = `198.51.100.${ipCounter++}`;
  const created = await request("/api/rooms", { body: { name: "Host", game: "quiz" }, ip });
  const code = created.data.code;
  const token = created.data.playerToken;
  assert.equal((await request("/api/join", { body: { name: "Guest", code }, ip })).status, 201);
  const roomAction = (actionName, extra = {}) => request("/api/action", {
    token, body: { code, action: actionName, ...extra }, ip,
  });
  assert.equal((await roomAction("start")).status, 200);
  for (const answer of ["jupiter", "6", "tokyo", "pacific", "63"]) {
    assert.equal((await roomAction("guess", { answer })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const finished = await request(`/api/state?code=${code}`, { token, ip });
  assert.equal(finished.data.phase, "finished");
  assert.ok(finished.data.closesInMs > 0 && finished.data.closesInMs <= 5000);
  await new Promise((resolve) => setTimeout(resolve, finished.data.closesInMs + 200));
  assert.equal((await request(`/api/state?code=${code}`, { token, ip })).status, 404);
});

test("each game can be started and played in a group", async () => {
  const actions = {
    quiz: { action: "guess", answer: "jupiter" },
    pong: { action: "paddle", direction: 1 },
    "tic-tac-toe": { action: "move", index: 0 },
    "connect-four": { action: "drop", column: 0 },
    "word-scramble": { action: "solve", answer: "planet" },
    "memory-match": { action: "flip", index: 0 },
    hangman: { action: "letter", letter: "A" },
    "rock-paper-scissors": { action: "choose", choice: "rock" },
    "higher-lower": { action: "higher-lower", guess: "higher" },
    battleship: { action: "place-ship", index: 0, orientation: "horizontal" },
    "reaction-race": { action: "react" },
  };
  for (const [game, command] of Object.entries(actions)) {
    const group = await createGroup(2);
    const started = await action(group, group.players[0], "select-game", { game });
    assert.equal(started.status, 200, game);
    assert.equal(started.data.room.phase, "playing", game);
    const player = group.players.find((member) => member.name === started.data.room.players[0].name);
    const { action: actionName, ...extra } = command;
    const result = await action(group, player, actionName, extra);
    assert.equal(result.status, 200, game);
  }
});

test("Pong advances on the server while a group is playing", async () => {
  const group = await createGroup(2);
  const started = await action(group, group.players[0], "select-game", { game: "pong" });
  const initialX = started.data.room.gameState.ball.x;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = await request(`/api/groups/state?code=${group.code}`, { token: group.players[0].token, ip: group.ip });
  assert.notEqual(state.data.room.gameState.ball.x, initialX);
});

test("individual Pong rooms still allow joining and advance after starting", async () => {
  const ip = `198.51.100.${ipCounter++}`;
  const created = await request("/api/rooms", { body: { name: "Host", game: "pong" }, ip });
  assert.equal(created.status, 201);
  const code = created.data.code;
  const joined = await request("/api/join", { body: { code, name: "Guest" }, ip });
  assert.equal(joined.status, 201);
  const started = await request("/api/action", {
    token: created.data.playerToken,
    body: { code, action: "start" },
    ip,
  });
  assert.equal(started.status, 200);
  assert.equal(started.data.phase, "playing");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = await request(`/api/state?code=${code}`, { token: joined.data.playerToken, ip });
  assert.equal(state.status, 200);
  assert.notEqual(state.data.gameState.ball.x, started.data.gameState.ball.x);
});

test("Pong live streams require membership, advance, and close when a group member leaves", async () => {
  const group = await createGroup(2);
  const token = group.players[0].token;
  const url = `${baseUrl}/api/pong-stream?code=${group.code}&group=1`;
  const headers = { Authorization: `Bearer ${token}`, "X-Forwarded-For": group.ip };
  assert.equal((await fetch(url, { headers })).status, 409);
  await action(group, group.players[0], "select-game", { game: "pong" });
  assert.equal((await fetch(url, { headers: { ...headers, Authorization: `Bearer ${"a".repeat(64)}` } })).status, 404);
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const states = [];
  while (states.length < 3) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    states.push(...lines.map((line) => JSON.parse(line)));
  }
  assert.notEqual(states[0].ball.x, states[2].ball.x);
  assert.deepEqual(Object.keys(states[0]).sort(), ["ball", "paddles", "scores"]);
  await action(group, group.players[0], "leave");
  while (!(await reader.read()).done) {}
  controller.abort();
});

test("single-player Pong live streams are bounded and close on leaving", async () => {
  const ip = `198.51.100.${ipCounter++}`;
  const created = await request("/api/single", { body: { name: "Player", game: "pong", difficulty: "easy" }, ip });
  const { code, playerToken } = created.data;
  const url = `${baseUrl}/api/pong-stream?code=${code}`;
  const headers = { Authorization: `Bearer ${playerToken}`, "X-Forwarded-For": ip };
  const first = await fetch(url, { headers });
  const second = await fetch(url, { headers });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await fetch(url, { headers })).status, 503);
  await request("/api/action", { token: playerToken, body: { code, action: "leave" }, ip });
  for (const response of [first, second]) {
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {}
  }
});
