# Chess Engine API

A self-hosted Stockfish API Send a position (FEN) and get back the
best move, the evaluation, the chance of winning and the line Stockfish expects.
Use HTTP POST for a single answer, or a WebSocket to watch the search get deeper.

It runs Stockfish 19 built from the
[official GitHub repo](https://github.com/official-stockfish/Stockfish) on an
EC2 instance, the same one as the [chess server](../chess-frontend), behind
nginx with a free Let's Encrypt certificate. Stockfish is GPL v3 licensed, see
[Stockfish license](#stockfish-license).

Built with Node.js, [Express](https://expressjs.com/),
[ws](https://github.com/websockets/ws),
[chess.js](https://github.com/jhlywa/chess.js) and Stockfish.

## How it works

```
browser ──HTTPS / WSS──> nginx (TLS, rate limit) ──┐
                                                   ├──> Node :3001 ──stdin/stdout (UCI)──> Stockfish × vCPUs
chess server (same instance) ──http://127.0.0.1────┘
```

The chess server skips nginx: it's on the same instance, so it calls the Node
app on `127.0.0.1` directly (see [Using it from chess-frontend](#using-it-from-chess-frontend)).

Stockfish has no network API of its own. It's a command-line program you talk to
over stdin/stdout using the [UCI protocol](https://backscattering.de/chess/uci/).
The Node server is the bridge between that and HTTP.

1. **Validate.** The FEN is checked and rebuilt by chess.js, so only a real FEN
   is ever written to Stockfish. Depth, time and variants are kept within the
   limits, and `searchmoves` is filtered down to valid moves like `e2e4`.
2. **Queue.** The server starts one single-threaded Stockfish per vCPU. A
   request takes an idle one, or waits in line. If more than 50 requests are
   waiting, new ones get `Server busy`.
3. **Search.** The server sends Stockfish `ucinewgame`, the strength options
   (`UCI_LimitStrength`, `UCI_Elo`, `Skill Level`, set on every search so one
   request's strength never carries over to the next), then
   `setoption name MultiPV value <variants>`, `position fen <fen>`, and
   `go depth <depth> movetime <ms> [searchmoves ...]`. Stockfish stops at the
   depth or the time limit, whichever comes first.
4. **Format.** Each `info ... pv ...` line Stockfish prints becomes a `move`
   message (streamed over WebSocket). The move on Stockfish's final
   `bestmove` line becomes the `bestmove` response. With a skill level or Elo
   that can be a weaker move than the top analysis line, and then it has no
   score (`eval`, `centipawns` and `winChance` are `null`). Scores are flipped to White's point of view, the way
   chess-api.com reports them. `winChance` uses Lichess's formula, and `san`,
   `flags`, `piece` and the rest come from chess.js.
5. **Recover.** If a Stockfish process dies, the request it was working on gets
   an error and the process is restarted. If it dies within 2 seconds of
   starting (usually a build for the wrong CPU), the whole server exits so
   systemd can restart it.

## API

### `POST /v1`

```bash
curl -s https://engine.aws-prac-route53.com/v1 \
  -H 'Content-Type: application/json' \
  -d '{"fen": "8/1P1R4/n1r2B2/3Pp3/1k4P1/6K1/Bppr1P2/2q5 w - - 0 1", "depth": 12}'
```

| Field | Default | Max | Description |
| --- | --- | --- | --- |
| `fen` | required | | Position to analyse. |
| `depth` | 12 | 20 | How many moves deep Stockfish searches. |
| `maxThinkingTime` | 1000 | 5000 | Time limit in ms. The search stops at `depth` or this, whichever comes first. |
| `variants` | 1 | 5 | Number of lines to return. With more than 1, the response is an array, best line first. |
| `searchmoves` | `''` | | Only consider these moves, e.g. `"d2d4 e2e4"`. |
| `skillLevel` | 20 | 20 | Stockfish's `Skill Level`, 0-20. Below 20 it sometimes plays a weaker move on purpose. |
| `elo` | | 3190 | Play at about this Elo (min 1320). Turns on `UCI_LimitStrength` + `UCI_Elo` and overrides `skillLevel`. Stockfish's ratings are anchored to the CCRL engine rating list, not human ratings. |
| `taskId` | | | Copied onto every WebSocket message so you can match replies to requests. |

Response (`captured` appears only when the move takes a piece):

```json
{
  "type": "bestmove",
  "text": "Move b7 → b8 (b8=Q+): [-11.62]. Black is winning. Depth 12.",
  "eval": -11.62,
  "centipawns": "-1162",
  "mate": null,
  "winChance": 1.3672836783305158,
  "depth": 12,
  "move": "b7b8q",
  "lan": "b7b8q",
  "san": "b8=Q+",
  "from": "b7",
  "to": "b8",
  "turn": "w",
  "color": "w",
  "piece": "p",
  "promotion": "q",
  "flags": "np",
  "isCapture": false,
  "isCastling": false,
  "isPromotion": true,
  "continuationArr": ["b7b8q", "c6b6", "b8b6", "a6c5"],
  "fen": "8/1P1R4/n1r2B2/3Pp3/1k4P1/6K1/Bppr1P2/2q5 w - - 0 1"
}
```

- `eval` is in pawns. Positive means White is better.
- `mate` is the number of moves to a forced mate. Positive means White mates.
  When there is a forced mate, `eval` is `100` or `-100`.
- `winChance` runs from 0 to 100. 50 means even, above 50 favours White.
- `flags` uses chess.js's letters: `n` normal, `b` two-square pawn push,
  `e` en passant, `c` capture, `p` promotion, `k` / `q` castling.

Errors come back as `{ "type": "info", "text": "..." }`, for example
`Missing fen.`, `Invalid FEN: ...`, `No legal moves (game over).` or
`Server busy, try again shortly.`

### WebSocket `/v1`

Send the same JSON body. You get a `move` message each time the search gets
deeper, then one `bestmove` (one per line when `variants` > 1). A connection can
send as many requests as it likes.

```js
const ws = new WebSocket('wss://engine.aws-prac-route53.com/v1');
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.type === 'bestmove') console.log(msg.san, msg.eval);
};
ws.onopen = () => ws.send(JSON.stringify({ fen: '...', depth: 16, taskId: 'game-42' }));
```

### `GET /health`

`{ "ok": true, "engines": 2, "idle": 2, "waiting": 0 }`

### Differences from chess-api.com

- `input` (reading a move list out of text or HTML) isn't supported. Send a FEN.
- The defaults are `maxThinkingTime: 1000` and a max depth of 20. chess-api.com
  uses 50 with a cap of 100, and caps depth at 18. To change the limits, edit
  the constants at the top of `server.js`.
- `fromNumeric` / `toNumeric` aren't included.

## Run locally

Requires Node 18+ and a Stockfish build. Build it from source, the same tag as
the server:

```bash
git clone --depth 1 --branch sf_19 https://github.com/official-stockfish/Stockfish.git
cd Stockfish/src
make -j build ARCH=apple-silicon   # Intel Mac: x86-64-avx2
```

Then, in this folder:

```bash
npm install
STOCKFISH_PATH=/path/to/Stockfish/src/stockfish npm start
```

```bash
curl -s localhost:3001/v1 -H 'Content-Type: application/json' \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```

## Deploy to EC2

These steps set up a new x86 instance from the `Basic-Nginx-26` AMI (Ubuntu
with nginx) for `engine.aws-prac-route53.com`. The chess server runs on the
same instance, so once the engine works, continue with
[chess-frontend's Deploy](../chess-frontend/README.md#deploy). Run its
Terraform before step 1: it creates the instance's IAM role and the `chess` and
`engine` DNS records.

### 1. Launch the instance

- **AMI:** `Basic-Nginx-26` (x86_64). A plain Ubuntu Server LTS (x86) AMI works
  too: step 3 installs anything it's missing.
- **Type:** `t3.medium` (2 vCPUs, 4 GB), shared with the chess server.
  Stockfish uses 100% of a vCPU while it thinks, which uses up a `t3`'s CPU
  credits, so under steady traffic use `c7i.large`, which runs at full speed
  all the time.
- **Storage:** 16 GB `gp3`. The AMI's 8 GB `gp2` gets tight with Stockfish's
  build and both apps' `node_modules`, and `gp3` costs less per GB.
- **Purchasing option (optional):** Spot, with **Request type: Persistent** and
  **Interruption behavior: Stop**. When AWS needs the capacity back, the
  instance stops with its disk intact and starts again when capacity returns. A
  one-time spot request terminates the instance and deletes its disk instead.
  While a spot instance is stopped, the whole site (chess and engine) is down,
  so use on-demand if it has to stay up.
- **IAM instance profile:** `chess-server` (from chess-frontend's Terraform).
  The chess server uses it for DynamoDB. The engine needs no AWS permissions.
- **Security group:** port 22 from your IP only, ports 80 and 443 from
  anywhere. Don't open 3001 or 8080: nginx is the only way in. The engine also
  only listens on `127.0.0.1`.

### 2. Move the Elastic IP

`engine` and `chess` both point at the Elastic IP `52.11.177.148`
(chess-frontend's Terraform manages both records), so moving it moves the
whole site.

1. If the old instance came from a **persistent** spot request, cancel the
   request first: **EC2 → Spot Requests**, select it, **Actions → Cancel
   request**. Terminating only the instance makes the request launch a new one.
2. **EC2 → Elastic IPs**, select `52.11.177.148`, **Actions → Associate
   Elastic IP address**, pick the new instance, and tick **Allow this Elastic
   IP address to be reassociated**.
3. Terminate the old instance.
4. The new instance has a new SSH host key at the same address. Remove the old
   key on your Mac, or ssh refuses to connect:
   `ssh-keygen -R 52.11.177.148`

Setting up for the first time instead: allocate an Elastic IP, associate it,
and set `server_ip` in chess-frontend's `terraform/aws-enviroment/locals.tf`.
Check with `dig +short engine.aws-prac-route53.com`. certbot checks it in
step 6, so it has to resolve first.

### 3. Install packages

```bash
ssh -i ~/path/to/key.pem ubuntu@<elastic-ip>

sudo apt update
sudo apt install -y build-essential git nginx certbot python3-certbot-nginx
```

Node comes from [nvm](https://github.com/nvm-sh/nvm). Skip this if the AMI
already has it (`node24 -v` prints a version):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
sudo ln -sf "$(nvm which 24)" /usr/local/bin/node24
node24 -v
```

systemd doesn't load nvm, so both services start Node through the
`/usr/local/bin/node24` link. After `nvm install`-ing a newer 24.x, run the
`ln` line again.

### 4. Build Stockfish

The tag is pinned (`sf_19`), so the engine doesn't change under you. To move to
a newer [release](https://github.com/official-stockfish/Stockfish/releases),
change `sf_19` here and in [Stockfish license](#stockfish-license), then
re-measure chess-frontend's AI levels: Stockfish recalibrates `UCI_Elo`
between versions.

```bash
cd ~
git clone --depth 1 --branch sf_19 https://github.com/official-stockfish/Stockfish.git
cd Stockfish/src
make -j"$(nproc)" profile-build ARCH=x86-64-avx2
sudo cp stockfish /usr/local/bin/stockfish
printf 'uci\nquit\n' | stockfish | head -n 1   # "Stockfish 19 by the Stockfish developers (see AUTHORS file)"
```

| Instance family | `ARCH` |
| --- | --- |
| Intel / AMD: `t3`, `c6i`, `c7i`, `c7a` | `x86-64-avx2` |
| Graviton: `t4g`, `c6g`, `c7g`, `c8g` | `armv8-dotprod` |

Use a named `ARCH`, not `native`. A `native` build can use instructions that
only this exact CPU has, and an AMI made from this instance can launch on an
older one, where Stockfish crashes on start (the server logs "Was it built for
this CPU (ARCH)?"). `make help` lists every `ARCH`. The build downloads
Stockfish's neural network automatically. `profile-build` takes several
minutes but makes a faster engine than plain `build`.

### 5. Deploy the app

From your Mac, in this folder:

```bash
ssh -i ~/path/to/key.pem ubuntu@<elastic-ip> 'sudo mkdir -p /opt/chess-engine-api && sudo chown ubuntu: /opt/chess-engine-api'
rsync -av --exclude node_modules --exclude .git -e "ssh -i ~/path/to/key.pem" ./ ubuntu@<elastic-ip>:/opt/chess-engine-api/
```

On the instance:

```bash
cd /opt/chess-engine-api
npm ci --omit=dev
sudo cp deploy/chess-engine-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chess-engine-api
curl -s localhost:3001/health
```

`/health` should show `"engines": 2` on a `t3.medium`. The service runs with
`Nice=10`, so the chess server gets the CPU first when both are busy.
`ALLOWED_ORIGINS` only matters to browsers calling the public API.

### 6. nginx and HTTPS (public API)

The chess server calls the engine at `http://127.0.0.1:3001`, so it doesn't
need this step. It's for the public API at `https://engine.aws-prac-route53.com`,
which the examples in [API](#api) use. Skip it to keep the engine private.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/chess-engine-api
sudo ln -s /etc/nginx/sites-available/chess-engine-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d engine.aws-prac-route53.com
```

certbot adds the HTTPS server block and the HTTP → HTTPS redirect, and sets up a
timer that renews the certificate automatically. Browsers block calls from an
HTTPS page to a plain `http://` or `ws://` API, so a public API needs it.

The nginx config allows 5 requests per second per IP (bursts of 10) and passes
WebSocket upgrades through. Only public callers share that limit; games don't
go through nginx.

### 7. Check it

On the instance:

```bash
curl -s localhost:3001/health
curl -s localhost:3001/v1 -H 'Content-Type: application/json' \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```

With step 6 done, the same from anywhere:

```bash
curl -s https://engine.aws-prac-route53.com/health
```

Next, set up the chess server on this instance:
[chess-frontend → Deploy](../chess-frontend/README.md#deploy).

### Updating and logs

```bash
# from your Mac
rsync -av --exclude node_modules --exclude .git -e "ssh -i ~/path/to/key.pem" ./ ubuntu@<elastic-ip>:/opt/chess-engine-api/

# on the instance
cd /opt/chess-engine-api && npm ci --omit=dev && sudo systemctl restart chess-engine-api
journalctl -u chess-engine-api -f
```

- **Changed `deploy/chess-engine-api.service`?** Copy it again and run
  `sudo systemctl daemon-reload` before the restart.
- **Service won't start, port in use?** `sudo lsof -i :3001` shows what has it.

## Using it from chess-frontend

The chess server calls it, not the browser:
[`server/utils/ai.js`](../chess-frontend/server/utils/ai.js) sends each AI
move's FEN with the game's level (`elo` or `skillLevel`, plus `depth` and
`maxThinkingTime`) and saves the move it gets back.

Both run on the same instance, so the chess server's `.env` sets
`ENGINE_URL=http://127.0.0.1:3001/v1`. The request never leaves the instance,
skips nginx and its rate limit, and needs no certificate. Without `ENGINE_URL`
the chess server uses the public `https://engine.aws-prac-route53.com/v1`,
which is what a chess server running on your Mac does.

Stockfish picks a skill-level move at depth `1 + skill level`, so the chess
server stops the search there (`depth`) instead of letting it use all of
`maxThinkingTime`. Only the full-strength level searches to depth 20.

## Configuration

Set these as `Environment=` lines in the systemd unit.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3001` | Port the app listens on. The chess server's `ENGINE_URL` uses it. |
| `HOST` | `127.0.0.1` | Address the app listens on. Keep it local so only nginx and the chess server on the same instance can reach it. |
| `STOCKFISH_PATH` | `/usr/local/bin/stockfish` | The Stockfish binary. |
| `ENGINES` | number of vCPUs | How many Stockfish processes to run. |
| `HASH_MB` | `64` | Hash table size for each Stockfish process. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated sites allowed to call the API (CORS and WebSocket). |

## Files

```
server.js                        HTTP + WebSocket server, Stockfish process pool
format.js                        Stockfish output -> chess-api.com response
deploy/chess-engine-api.service  systemd unit
deploy/nginx.conf                nginx site (proxy, WebSockets, rate limit)
```

## Stockfish license

[Stockfish](https://stockfishchess.org/) is free software by
[the Stockfish developers](https://github.com/official-stockfish/Stockfish/blob/sf_19/AUTHORS),
distributed under the
[GNU General Public License version 3](https://github.com/official-stockfish/Stockfish/blob/sf_19/Copying.txt)
(GPL v3). Whenever Stockfish is distributed, the license and the full source
code (or a link to it) for that exact binary have to go with it, and any
changes to its source have to be released under GPL v3 too.

- **Source:** the engine is built, unmodified, from the official
  [`sf_19` tag](https://github.com/official-stockfish/Stockfish/tree/sf_19)
  (see [Build Stockfish](#4-build-stockfish)). Its license is `Copying.txt` in
  that source.
- **This repo doesn't include Stockfish.** No Stockfish code or binary is
  committed here. `server.js` starts the Stockfish program installed at
  `STOCKFISH_PATH` and talks to it over stdin/stdout with UCI, the same way a
  chess GUI does.
- **The API doesn't distribute Stockfish.** The binary stays on the EC2
  instance, and callers only get its moves back. GPL v3 doesn't count letting
  people use a program over a network, without giving them a copy, as
  distributing it.
- **If you do distribute it** (a binary download, or a Docker image or AMI
  with Stockfish in it, which includes sharing or making public an AMI of the
  EC2 instance), include `Copying.txt` and the source, or a link to the
  exact tag it was built from. If you change Stockfish's source, publish those
  changes under GPL v3.
