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

## Deploy on Render

Create a **Web Service** from the GitHub repository. Use the project root as
the root directory, choose the Node runtime, and set the build command to
`npm install` and the start command to `npm start`. Render supplies `PORT`.

Game rooms are held in memory and are cleared when the server restarts.

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

Winners see a victory badge and fireworks; both players see fireworks after a
Tic-Tac-Toe win. The animation is disabled when the device is set to reduce
motion.
