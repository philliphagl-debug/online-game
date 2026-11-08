# Play Together

A lightweight browser-based multiplayer game hub powered by Node.js.

## Run locally

1. Install [Node.js 20 or newer](https://nodejs.org/).
2. From the project folder, run:

   ```sh
   npm start
   ```

3. Open <http://localhost:3000>.

The server uses the `PORT` environment variable when provided; otherwise it
listens on port `3000`. No additional packages are required.

## Single-player games

Select **Play against a bot** on the home page to play Tic-Tac-Toe, Connect
Four, Memory Match, Battleship, or Paddle Clash. Choose Easy, Medium, or Hard
before entering your name. Bots run on the server, so a connection is still
required; solo games are private and separate from multiplayer rooms and groups.
Paddle Clash supports keyboard and on-screen controls.

## Deploy on Render

Create a **Web Service** from the GitHub repository. Use the project root as
the root directory, choose the Node runtime, and set the build command to
`npm install` and the start command to `npm start`. Render supplies `PORT`.

Game rooms are held in memory and are cleared when the server restarts. After
an individual game ends, its result is shown for five seconds, then the room
closes and players return to the game selection.

Groups have their own codes and invitation links, separate from individual game
rooms. Up to eight members can stay together while the host selects games.
Members who join during a game watch until the next game. For two-player games,
two members are drawn; when another pairing is possible, the same pair will not
be drawn for three consecutive two-player games. When a member leaves, games
continue with the remaining players when possible; a game ends if fewer than
two active players remain. If the host leaves, the longest-standing remaining
member becomes host. Groups expire after six hours and do not survive a server
restart.

Share the invitation link from the lobby, or enter a room code manually. When
creating a room, an optional custom code can contain 4–16 letters or digits;
leave it blank to generate a random code. Custom codes are easier to guess and
are not passwords, so share them and invitation links only with people you
want to invite.

Players see a win, loss, or draw badge and a matching animation after each
finished game. Winners see fireworks; both players still see fireworks after a
Tic-Tac-Toe win. Spectators and abandoned games do not get a personal result.
Animations are disabled when the device is set to reduce motion.

Choose Classic, Ocean, Sunset, Forest, Berry, Citrus, or Dark from the color selector in the header. The
choice is saved in the current browser and does not change other players' themes.
In Rock Paper Scissors, choices stay hidden until everyone has chosen; the
result is shown for three seconds before the next round.

Battleship uses a 10×10 board and five ships of lengths 2, 3, 3, 4 and 5.
Each player places and confirms their own fleet before play starts. Ships may
touch but cannot overlap. During play only the opponent's grid is shown; hits,
misses and sunk ships appear there, while unhit ship positions stay hidden.
