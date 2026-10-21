/*
 *  format.js  --  Stockfish output -> chess-api.com response
 *	Chess Engine API
 *
 */

/* ---------------------------------------------------------------- */
// Global
/* ---------------------------------------------------------------- */

const { Chess } = require('chess.js');

/* ---------------------------------------------------------------- */
// Parse
/* ---------------------------------------------------------------- */
/**
 * @description reads one UCI info line,
 * e.g. "info depth 12 seldepth 18 multipv 1 score cp -1162 nodes 91234 pv b7b8q c6b6"
 * @param  {[string]} line [raw line from Stockfish]
 * @return {[object]} { depth, multipv, cp, mate, pv }
 */
function parseInfo(line) {
	const tokens = line.split(' ');
	const val = (key) => (tokens.includes(key) ? tokens[tokens.indexOf(key) + 1] : null);
	return {
		depth: Number(val('depth')),
		multipv: Number(val('multipv') ?? 1),
		cp: val('cp') === null ? null : Number(val('cp')),
		mate: val('mate') === null ? null : Number(val('mate')),
		pv: tokens.slice(tokens.indexOf('pv') + 1),
	};
}

/* ---------------------------------------------------------------- */
// Format
/* ---------------------------------------------------------------- */
/**
 * @description builds a chess-api.com shaped response from one parsed line
 * @param  {[string]} fen  [position that was searched]
 * @param  {[object]} info [output of parseInfo]
 * @param  {[string]} type ['move' while searching, 'bestmove' when done]
 * @return {[object]} response body
 */
function toResponse(fen, info, type) {
	const chess = new Chess(fen);
	const turn = chess.turn();
	const sign = turn === 'w' ? 1 : -1; // Stockfish scores from the side to move; chess-api is always from White
	const cp = info.cp === null ? null : info.cp * sign;
	const mate = info.mate === null ? null : info.mate * sign;
	const uci = info.pv[0];
	const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

	const scored = cp !== null || mate !== null; // a skill level's weaker pick comes without a score
	const evaluation = !scored ? null : mate !== null ? Math.sign(mate) * 100 : cp / 100;
	const winChance = !scored ? null
		: mate !== null ? (mate > 0 ? 100 : 0)
			: 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1); // Lichess formula
	const leader = !scored ? 'Picked by skill level'
		: evaluation > 0.5 ? 'White is winning'
			: evaluation < -0.5 ? 'Black is winning'
				: 'The game is balanced';
	const score = !scored ? '?' : mate !== null ? `mate in ${Math.abs(mate)}` : evaluation;

	return {
		type,
		text: `Move ${move.from} → ${move.to} (${move.san}): [${score}]. ${leader}. Depth ${info.depth}.`,
		eval: evaluation,
		centipawns: cp === null ? null : String(cp),
		mate,
		winChance,
		depth: info.depth,
		move: uci,
		lan: move.lan,
		san: move.san,
		from: move.from,
		to: move.to,
		turn,
		color: move.color,
		piece: move.piece,
		captured: move.captured,
		promotion: move.promotion,
		flags: move.flags,
		isCapture: /[ce]/.test(move.flags),
		isCastling: /[kq]/.test(move.flags),
		isPromotion: move.flags.includes('p'),
		continuationArr: info.pv,
		fen,
	};
}

module.exports = { parseInfo, toResponse };
