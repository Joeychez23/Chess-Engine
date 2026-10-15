/*
 *  server.js  --  chess-api.com compatible Stockfish API
 *	Chess Engine API
 *
 */

/* ---------------------------------------------------------------- */
// Global
/* ---------------------------------------------------------------- */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');
const { parseInfo, toResponse } = require('./format.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // only nginx should reach the app
const STOCKFISH = process.env.STOCKFISH_PATH || '/usr/local/bin/stockfish';
const ENGINES = Number(process.env.ENGINES) || os.cpus().length;
const HASH_MB = Number(process.env.HASH_MB) || 64;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*';

const MAX_DEPTH = 20;
const MAX_TIME_MS = 5000;
const MAX_VARIANTS = 5;
const MAX_QUEUE = 50;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo));

try {
	fs.accessSync(STOCKFISH, fs.constants.X_OK);
} catch {
	console.error(`Stockfish not found at ${STOCKFISH}. Build it (see README) or set STOCKFISH_PATH.`);
	process.exit(1);
}

/* ---------------------------------------------------------------- */
// Engine
/* ---------------------------------------------------------------- */
/**
 * @description one Stockfish process, spoken to over UCI (stdin/stdout).
 * Runs one search at a time; restarts itself if Stockfish dies.
 */
class Engine {
	constructor() {
		this.start();
	}

	start() {
		this.startedAt = Date.now();
		this.onLine = null;
		this.fail = null;
		this.proc = spawn(STOCKFISH);
		this.proc.stdin.on('error', () => { }); // writes to a dead process; the exit handler deals with it

		let buf = '';
		this.proc.stdout.on('data', (chunk) => {
			buf += chunk;
			const lines = buf.split('\n');
			buf = lines.pop();
			lines.forEach((line) => this.onLine?.(line.trim()));
		});

		this.proc.on('exit', (code, signal) => {
			this.fail?.(new Error('Engine stopped mid-search, try again.'));
			if (Date.now() - this.startedAt < 2000) {
				console.error(`Stockfish exited right after starting (${code ?? signal}). Was it built for this CPU (ARCH)?`);
				process.exit(1); // systemd restarts the service
			}
			console.error(`Stockfish exited (${code ?? signal}), restarting`);
			this.start();
		});

		this.send('uci');
		this.send('setoption name Threads value 1');
		this.send(`setoption name Hash value ${HASH_MB}`);
	}

	send(cmd) {
		this.proc.stdin.write(cmd + '\n');
	}

	/**
	 * @description searches one position
	 * @param  {[object]}   opts   [{ fen, depth, movetime, variants, searchmoves }]
	 * @param  {[function]} onInfo [called with every parsed info line]
	 * @return {[Promise]} the deepest line per variant, best first
	 */
	search({ fen, depth, movetime, variants, searchmoves }, onInfo) {
		return new Promise((resolve, reject) => {
			const lines = {};
			this.fail = reject;
			this.onLine = (line) => {
				if (line.startsWith('info') && line.includes(' pv ') && !line.includes('bound')) {
					const info = parseInfo(line);
					lines[info.multipv] = info;
					onInfo(info);
				} else if (line.startsWith('bestmove')) {
					this.onLine = this.fail = null;
					resolve(Object.values(lines).sort((a, b) => a.multipv - b.multipv));
				}
			};
			this.send('ucinewgame');
			this.send(`setoption name MultiPV value ${variants}`);
			this.send(`position fen ${fen}`);
			this.send(`go depth ${depth} movetime ${movetime}${searchmoves ? ` searchmoves ${searchmoves}` : ''}`);
		});
	}
}

/* ---------------------------------------------------------------- */
// Pool
/* ---------------------------------------------------------------- */
// One single-threaded engine per vCPU; extra requests wait their turn

const idle = Array.from({ length: ENGINES }, () => new Engine());
const waiting = [];
const acquire = () => idle.pop() ?? new Promise((resolve) => waiting.push(resolve));
const release = (engine) => (waiting.length ? waiting.shift()(engine) : idle.push(engine));

/* ---------------------------------------------------------------- */
// Analyse
/* ---------------------------------------------------------------- */
/**
 * @description validates a chess-api.com style request and runs it
 * @param  {[object]}   body     [{ fen, depth, variants, maxThinkingTime, searchmoves }]
 * @param  {[function]} onUpdate [called with a 'move' response as the search deepens]
 * @return {[object|array]} 'bestmove' response (array when variants > 1), or an 'info' error
 */
async function analyse(body, onUpdate = () => { }) {
	if (typeof body?.fen !== 'string') return { type: 'info', text: 'Missing fen.' };
	let fen;
	try {
		fen = new Chess(body.fen).fen(); // rebuilt by chess.js so only a valid FEN reaches Stockfish
	} catch (err) {
		return { type: 'info', text: err.message };
	}
	if (waiting.length >= MAX_QUEUE) return { type: 'info', text: 'Server busy, try again shortly.' };

	const opts = {
		fen,
		depth: clamp(body.depth ?? 12, 1, MAX_DEPTH),
		movetime: clamp(body.maxThinkingTime ?? 1000, 10, MAX_TIME_MS),
		variants: clamp(body.variants ?? 1, 1, MAX_VARIANTS),
		searchmoves: String(body.searchmoves ?? '').split(/\s+/)
			.filter((m) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)).join(' '),
	};

	const engine = await acquire();
	try {
		const lines = await engine.search(opts, (info) => {
			try {
				onUpdate(toResponse(fen, info, 'move'));
			} catch { } // skip a partial line rather than crash the stream
		});
		if (!lines.length) return { type: 'info', text: 'No legal moves (game over).' };
		const out = lines.map((line) => toResponse(fen, line, 'bestmove'));
		return opts.variants === 1 ? out[0] : out;
	} catch (err) {
		return { type: 'info', text: err.message };
	} finally {
		release(engine);
	}
}

/* ---------------------------------------------------------------- */
// HTTP
/* ---------------------------------------------------------------- */

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (req, res) => {
	res.json({ ok: true, engines: ENGINES, idle: idle.length, waiting: waiting.length });
});

app.post('/v1', async (req, res) => {
	res.json(await analyse(req.body));
});

app.use((err, req, res, next) => {
	res.status(400).json({ type: 'info', text: 'Invalid JSON.' });
});

/* ---------------------------------------------------------------- */
// WebSocket
/* ---------------------------------------------------------------- */
// Same request body as POST; streams 'move' messages, then 'bestmove'

const server = app.listen(PORT, HOST, () => {
	console.log(`Chess Engine API on http://${HOST}:${PORT} with ${ENGINES} Stockfish engine(s)`);
});

const wss = new WebSocketServer({
	server,
	path: '/v1',
	verifyClient: ({ origin }) => ALLOWED_ORIGINS === '*' || ALLOWED_ORIGINS.includes(origin),
});

wss.on('connection', (ws) => {
	ws.on('message', async (raw) => {
		let body;
		try {
			body = JSON.parse(raw);
		} catch { }
		if (typeof body !== 'object' || body === null) {
			return ws.send(JSON.stringify({ type: 'info', text: 'Invalid JSON.' }));
		}
		const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ ...msg, taskId: body.taskId }));
		[].concat(await analyse(body, send)).forEach(send);
	});
});
