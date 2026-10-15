# Chess Engine API

A self-hosted Stockfish API Send a position (FEN) and get back the
best move, the evaluation, the chance of winning and the line Stockfish expects.
Use HTTP POST for a single answer, or a WebSocket to watch the search get deeper.

It runs Stockfish built from the
[official GitHub repo](https://github.com/official-stockfish/Stockfish) on an
EC2 instance, behind nginx with a free Let's Encrypt certificate.

Built with Node.js, [Express](https://expressjs.com/),
[ws](https://github.com/websockets/ws),
[chess.js](https://github.com/jhlywa/chess.js) and Stockfish.

## How it works

```
browser ──HTTPS / WSS──> nginx (TLS, rate limit) ──> Node :3000 ──stdin/stdout (UCI)──> Stockfish × vCPUs
```

Stockfish has no network API of its own. It's a command-line program you talk to
over stdin/stdout using the [UCI protocol](https://backscattering.de/chess/uci/).
The Node server is the bridge between that and HTTP.

1. **Validate.** The FEN is checked and rebuilt by chess.js, so only a real FEN
   is ever written to Stockfish. Depth, time and variants are kept within the
   limits, and `searchmoves` is filtered down to valid moves like `e2e4`.
2. **Queue.** The server starts one single-threaded Stockfish per vCPU. A
   request takes an idle one, or waits in line. If more than 50 requests are
   waiting, new ones get `Server busy`.
3. **Search.** The server sends Stockfish `ucinewgame`,
   `setoption name MultiPV value <variants>`, `position fen <fen>`, then
   `go depth <depth> movetime <ms> [searchmoves ...]`. Stockfish stops at the
   depth or the time limit, whichever comes first.
4. **Format.** Each `info ... pv ...` line Stockfish prints becomes a `move`
   message (streamed over WebSocket). The final `bestmove` becomes the
   `bestmove` response. Scores are flipped to White's point of view, the way
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

Requires Node 18+.

```bash
brew install stockfish
npm install
STOCKFISH_PATH="$(which stockfish)" npm start
```

```bash
curl -s localhost:3000/v1 -H 'Content-Type: application/json' \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```

## Deploy to EC2

These steps use Ubuntu 24.04 on a Graviton (Arm) instance, the domain
`engine.aws-prac-route53.com`, and the frontend at
`https://chess.aws-prac-route53.com`. Change those if yours differ.

### 1. Launch the instance

- **AMI:** Ubuntu Server 24.04 LTS, **64-bit (Arm)**.
- **Type:** `t4g.small` is enough for a portfolio. Stockfish uses 100% of a CPU
  while it thinks, which burns a `t4g`'s CPU credits, so under steady traffic
  use `c7g.large`, which runs at full speed all the time.
- **Security group:** port 22 from your IP only, ports 80 and 443 from anywhere.
  Don't open 3000. The app only listens on `127.0.0.1`, and nginx forwards to it.
- **Elastic IP:** allocate one and attach it so the address doesn't change when
  the instance restarts.

### 2. Point the domain at it

In Route 53, open the `aws-prac-route53.com` hosted zone and add an **A**
record: `engine` → the Elastic IP. certbot checks this in step 6, so it has to
resolve first. Check with `dig +short engine.aws-prac-route53.com`.

### 3. Install packages

```bash
ssh -i ~/path/to/key.pem ubuntu@<elastic-ip>

sudo apt update
sudo apt install build-essential
sudo apt install make
# Depends on build type.
sudo snap install zig --classic --edge
# (If Error) sudo lsof -i :PORT_NUMBER
sudo apt install -y qemu-user

# Node 22 from NodeSource (Ubuntu's own nodejs package is older)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

### 4. Build Stockfish

Pick the latest release tag from the
[releases page](https://github.com/official-stockfish/Stockfish/releases)
(e.g. `sf_17.1`), so the engine doesn't change under you.

```bash
git clone https://github.com/official-stockfish/Stockfish.git
cd Stockfish/src
make -j profile-build ARCH=x86-64
sudo cp stockfish /usr/local/bin/stockfish
printf 'uci\nquit\n' | stockfish | head -n 1   # "Stockfish 17.1 by the Stockfish developers..."
```

| Instance family | `ARCH` |
| --- | --- |
| Graviton: `t4g`, `c6g`, `c7g`, `c8g` | `armv8-dotprod` |
| Intel / AMD: `t3`, `c6i`, `c7i`, `c7a` | `x86-64-avx2` |

`make help` lists every `ARCH`. The build downloads Stockfish's neural-network
file automatically. `profile-build` takes several minutes on a small instance
but makes a faster engine than plain `build`.

### 5. Deploy the app

From your Mac, in this folder:

```bash
ssh -i ~/path/to/key.pem ubuntu@<elastic-ip> 'sudo mkdir -p /opt/chess-engine-api && sudo chown ubuntu: /opt/chess-engine-api'
rsync -av --exclude node_modules -e "ssh -i ~/path/to/key.pem" ./ ubuntu@<elastic-ip>:/opt/chess-engine-api/
```

On the instance, check `ALLOWED_ORIGINS` in
`deploy/chess-engine-api.service` (your frontend's URL, comma-separated if more
than one), then:

```bash
cd /opt/chess-engine-api
npm ci --omit=dev
sudo cp deploy/chess-engine-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chess-engine-api
curl -s localhost:3000/health
```

### 6. nginx and HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/chess-engine-api
sudo ln -s /etc/nginx/sites-available/chess-engine-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d engine.aws-prac-route53.com
```

certbot adds the HTTPS server block and the HTTP → HTTPS redirect, and sets up a
timer that renews the certificate automatically. HTTPS isn't optional here: the
frontend is served over HTTPS, and browsers block calls from an HTTPS page to a
plain `http://` or `ws://` API.

The nginx config also allows 5 requests per second per IP (bursts of 10) and
passes WebSocket upgrades through.

### 7. Check it

```bash
curl -s https://engine.aws-prac-route53.com/health
curl -s https://engine.aws-prac-route53.com/v1 -H 'Content-Type: application/json' \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```

### Updating and logs

```bash
# from your Mac
rsync -av --exclude node_modules -e "ssh -i ~/path/to/key.pem" ./ ubuntu@<elastic-ip>:/opt/chess-engine-api/

# on the instance
cd /opt/chess-engine-api && npm ci --omit=dev && sudo systemctl restart chess-engine-api
journalctl -u chess-engine-api -f
```

## Using it from chess-frontend

[`ai/index.js`](../chess-frontend/client/src/js/gameplay/ai/index.js) already
has a commented-out `postChessApi`. Point its URL at
`https://engine.aws-prac-route53.com/v1` and replace the js-chess-engine call:

```js
export async function playAi(chessInst) {
	const { from, to, promotion } = await postChessApi({ fen: chessInst.fen(), depth: 12 });
	return promotion ? { from, to, promotion } : { from, to };
}
```

`playAi` becomes async, so whatever calls it needs to `await` it. The response
includes the promotion piece, so the js-chess-engine promotion workaround can go.

Stockfish at depth 12 is far stronger than js-chess-engine level 1. To make it
beatable, add a field that sends `setoption name Skill Level value <0-20>`
before the search.

## Configuration

Set these as `Environment=` lines in the systemd unit.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | Port the app listens on. |
| `HOST` | `127.0.0.1` | Address the app listens on. Keep it local so only nginx can reach it. |
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
