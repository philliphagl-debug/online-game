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
  assert.equal(state.data.room.gameState.ownBoard.includes("ship"), false);
  assert.equal("boards" in state.data.room.gameState, false);
  assert.equal((await action(group, spectator, "fire", { index: 0 })).status, 403);
  const late = await request("/api/groups/join", { body: { code: group.code, name: "Late" }, ip: group.ip });
  assert.equal(late.status, 201);
  assert.equal(late.data.room.you, -1);
  assert.equal(late.data.members.find((member) => member.isYou).isPlaying, false);
  assert.equal((await action(group, group.players[1], "select-game", { game: "quiz" })).status, 403);
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
    battleship: { action: "fire", index: 0 },
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
