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
