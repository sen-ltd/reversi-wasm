// Reversi / Othello engine, bitboard representation, compiled to wasm32.
//
// Board layout: bit `row * 8 + col`, bit 0 = a1 (top-left), bit 63 = h8
// (bottom-right). Two u64s (black, white) track piece placement. A third
// byte tracks whose turn it is. No heap allocation anywhere — the static
// game state and recursive AI stack are all this file needs.

#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(not(test))]
use core::panic::PanicInfo;

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// ---- Board constants -----------------------------------------------------

const NOT_A_FILE: u64 = 0xFEFEFEFEFEFEFEFE; // bits NOT in column 0
const NOT_H_FILE: u64 = 0x7F7F7F7F7F7F7F7F; // bits NOT in column 7

// Standard opening: white at d4/e5, black at d5/e4. Black moves first.
const INIT_WHITE: u64 = (1u64 << 27) | (1u64 << 36);
const INIT_BLACK: u64 = (1u64 << 28) | (1u64 << 35);

// Classic Othello position weights. Corners are golden, X-squares
// (diagonally adjacent to corners) are poison before the corner falls.
#[rustfmt::skip]
const WEIGHTS: [i32; 64] = [
     100, -25,  10,   5,   5,  10, -25, 100,
     -25, -50,  -1,  -1,  -1,  -1, -50, -25,
      10,  -1,   3,   2,   2,   3,  -1,  10,
       5,  -1,   2,   1,   1,   2,  -1,   5,
       5,  -1,   2,   1,   1,   2,  -1,   5,
      10,  -1,   3,   2,   2,   3,  -1,  10,
     -25, -50,  -1,  -1,  -1,  -1, -50, -25,
     100, -25,  10,   5,   5,  10, -25, 100,
];

// ---- Mutable game state --------------------------------------------------

static mut BLACK: u64 = INIT_BLACK;
static mut WHITE: u64 = INIT_WHITE;
// 0 = black to move, 1 = white to move.
static mut TURN: u32 = 0;

// ---- Direction shifts ----------------------------------------------------
//
// Each direction is a self-contained `fn(u64) -> u64`. We mask before (not
// after) each shift to prevent column wraparound; row overflows vanish
// naturally because `>>` and `<<` push bits off the ends.

#[inline(always)]
fn n(x: u64) -> u64 { x >> 8 }

#[inline(always)]
fn s(x: u64) -> u64 { x << 8 }

#[inline(always)]
fn e(x: u64) -> u64 { (x & NOT_H_FILE) << 1 }

#[inline(always)]
fn w(x: u64) -> u64 { (x & NOT_A_FILE) >> 1 }

#[inline(always)]
fn ne(x: u64) -> u64 { (x & NOT_H_FILE) >> 7 }

#[inline(always)]
fn nw(x: u64) -> u64 { (x & NOT_A_FILE) >> 9 }

#[inline(always)]
fn se(x: u64) -> u64 { (x & NOT_H_FILE) << 9 }

#[inline(always)]
fn sw(x: u64) -> u64 { (x & NOT_A_FILE) << 7 }

type Shift = fn(u64) -> u64;
const DIRECTIONS: [Shift; 8] = [n, s, e, w, ne, nw, se, sw];

// ---- Core bitboard primitives -------------------------------------------

/// Legal moves for `me` against `opp` in one direction.
///
/// Start from me, walk the direction skipping opp disks, land on empty.
/// The run can be at most 6 disks long (middle 6 squares of an 8-wide line),
/// so 6 unrolled extensions are enough to reach the far end.
#[inline]
fn legal_moves_dir(me: u64, opp: u64, empty: u64, shift: Shift) -> u64 {
    let mut run = shift(me) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    shift(run) & empty
}

/// Bitboard of all legal move squares for `me`.
#[inline]
fn legal_moves(me: u64, opp: u64) -> u64 {
    let empty = !(me | opp);
    let mut moves = 0u64;
    moves |= legal_moves_dir(me, opp, empty, n);
    moves |= legal_moves_dir(me, opp, empty, s);
    moves |= legal_moves_dir(me, opp, empty, e);
    moves |= legal_moves_dir(me, opp, empty, w);
    moves |= legal_moves_dir(me, opp, empty, ne);
    moves |= legal_moves_dir(me, opp, empty, nw);
    moves |= legal_moves_dir(me, opp, empty, se);
    moves |= legal_moves_dir(me, opp, empty, sw);
    moves
}

/// Opponent disks that flip when `pos` is played in one direction.
///
/// Walk from pos into opp territory; if the run terminates with a `me`
/// disk, the run is the flip mask. If it runs off the board or hits empty,
/// nothing flips in this direction.
#[inline]
fn flips_dir(pos: u64, me: u64, opp: u64, shift: Shift) -> u64 {
    let mut run = shift(pos) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    if shift(run) & me != 0 { run } else { 0 }
}

/// All disks flipped by playing `pos`. pos must be a single-bit bitboard.
#[inline]
fn flips_total(pos: u64, me: u64, opp: u64) -> u64 {
    let mut flips = 0u64;
    for shift in DIRECTIONS {
        flips |= flips_dir(pos, me, opp, shift);
    }
    flips
}

// ---- Evaluation ----------------------------------------------------------

/// Terminal = piece count * big number (decisive). Mid-game = weighted
/// squares + mobility bias. Returned from `me`'s perspective.
fn evaluate(me: u64, opp: u64) -> i32 {
    let total = (me | opp).count_ones() as i32;

    // Terminal: game is over when both sides have no legal move. Score by
    // material times a big factor so the search latches onto actually-won
    // positions over merely-good ones.
    if total >= 64 || (legal_moves(me, opp) | legal_moves(opp, me)) == 0 {
        let diff = me.count_ones() as i32 - opp.count_ones() as i32;
        return diff * 10_000;
    }

    let mut score = 0;
    let mut i = 0;
    while i < 64 {
        let bit = 1u64 << i;
        if me & bit != 0 {
            score += WEIGHTS[i];
        } else if opp & bit != 0 {
            score -= WEIGHTS[i];
        }
        i += 1;
    }

    // Mobility: moves available to me vs opp. Worth ~5 points per move in
    // the opening / mid-game.
    let my_mob = legal_moves(me, opp).count_ones() as i32;
    let op_mob = legal_moves(opp, me).count_ones() as i32;
    score += (my_mob - op_mob) * 5;

    score
}

/// Negamax with alpha-beta pruning. Returns (best_score, best_move_bit).
/// best_move_bit is 0 when the side to move has to pass.
fn negamax(
    me: u64,
    opp: u64,
    depth: u32,
    mut alpha: i32,
    beta: i32,
) -> (i32, u64) {
    if depth == 0 {
        return (evaluate(me, opp), 0);
    }

    let moves = legal_moves(me, opp);
    if moves == 0 {
        // Pass. If opponent also can't move, the position is terminal.
        let opp_moves = legal_moves(opp, me);
        if opp_moves == 0 {
            return (evaluate(me, opp), 0);
        }
        // Otherwise, recurse with colors swapped (same depth reduction).
        let (s, _) = negamax(opp, me, depth - 1, -beta, -alpha);
        return (-s, 0);
    }

    let mut best_score = i32::MIN + 1;
    let mut best_move = 0u64;
    let mut bits = moves;
    while bits != 0 {
        // Lowest set bit: the Brian Kernighan trick isolates it.
        let mv = bits & bits.wrapping_neg();
        bits ^= mv;

        let flips = flips_total(mv, me, opp);
        let new_me = me | mv | flips;
        let new_opp = opp & !flips;
        let (s, _) = negamax(new_opp, new_me, depth - 1, -beta, -alpha);
        let score = -s;

        if score > best_score {
            best_score = score;
            best_move = mv;
        }
        if score > alpha {
            alpha = score;
        }
        if alpha >= beta {
            break;
        }
    }
    (best_score, best_move)
}

/// Convert a single-bit bitboard to its 0-63 position, or 64 if empty.
fn bit_to_pos(b: u64) -> u32 {
    if b == 0 { 64 } else { b.trailing_zeros() }
}

// ---- Exported API --------------------------------------------------------

/// Reset to the starting position with black to move.
#[no_mangle]
pub extern "C" fn reset() {
    unsafe {
        BLACK = INIT_BLACK;
        WHITE = INIT_WHITE;
        TURN = 0;
    }
}

#[no_mangle]
pub extern "C" fn black_discs() -> u64 {
    unsafe { BLACK }
}

#[no_mangle]
pub extern "C" fn white_discs() -> u64 {
    unsafe { WHITE }
}

#[no_mangle]
pub extern "C" fn current_turn() -> u32 {
    unsafe { TURN }
}

/// Count of set bits in `black_discs()`.
#[no_mangle]
pub extern "C" fn black_count() -> u32 {
    unsafe { BLACK.count_ones() }
}

#[no_mangle]
pub extern "C" fn white_count() -> u32 {
    unsafe { WHITE.count_ones() }
}

/// Bitboard of legal moves for the current turn.
#[no_mangle]
pub extern "C" fn legal_moves_bits() -> u64 {
    let (me, opp) = current_boards();
    legal_moves(me, opp)
}

/// 1 if both players are out of moves (game is finished), else 0.
#[no_mangle]
pub extern "C" fn is_game_over() -> u32 {
    let (me, opp) = current_boards();
    if legal_moves(me, opp) == 0 && legal_moves(opp, me) == 0 { 1 } else { 0 }
}

/// Apply a move at position `pos` (0-63). Returns 1 on success, 0 if the
/// move is illegal. pos = 64 means "pass"; pass is only legal when the
/// current player has no other moves.
#[no_mangle]
pub extern "C" fn apply_move(pos: u32) -> u32 {
    let (me, opp) = current_boards();
    let moves = legal_moves(me, opp);

    if pos >= 64 {
        // Pass — only valid if no legal moves.
        if moves != 0 {
            return 0;
        }
        toggle_turn();
        return 1;
    }

    let mv = 1u64 << pos;
    if moves & mv == 0 {
        return 0;
    }
    let flips = flips_total(mv, me, opp);
    let new_me = me | mv | flips;
    let new_opp = opp & !flips;
    unsafe {
        if TURN == 0 {
            BLACK = new_me;
            WHITE = new_opp;
        } else {
            WHITE = new_me;
            BLACK = new_opp;
        }
    }
    toggle_turn();
    1
}

/// Overwrite the game state. Used by the JS host to implement undo by
/// snapshotting `(black, white, turn)` before each move and restoring it
/// on request. Trusts the caller — we don't validate that the triple
/// represents a reachable position.
#[no_mangle]
pub extern "C" fn set_state(black: u64, white: u64, turn: u32) {
    unsafe {
        BLACK = black;
        WHITE = white;
        TURN = turn & 1;
    }
}

/// Ask the AI for the best move at given depth. Returns 0-63 for a move,
/// 64 if the AI must pass.
#[no_mangle]
pub extern "C" fn ai_choose_move(depth: u32) -> u32 {
    let (me, opp) = current_boards();
    if legal_moves(me, opp) == 0 {
        return 64;
    }
    let (_, best) = negamax(me, opp, depth, i32::MIN + 1, i32::MAX - 1);
    bit_to_pos(best)
}

// ---- Internal helpers ----------------------------------------------------

fn current_boards() -> (u64, u64) {
    unsafe {
        if TURN == 0 { (BLACK, WHITE) } else { (WHITE, BLACK) }
    }
}

fn toggle_turn() {
    unsafe {
        TURN = 1 - TURN;
    }
}

// ---- Tests ---------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn bit_pos(row: u32, col: u32) -> u64 {
        1u64 << (row * 8 + col)
    }

    #[test]
    fn init_has_four_center_disks() {
        reset();
        assert_eq!(black_count(), 2);
        assert_eq!(white_count(), 2);
        assert_eq!(current_turn(), 0);
    }

    #[test]
    fn black_opening_has_four_legal_moves() {
        reset();
        let moves = legal_moves_bits();
        assert_eq!(moves.count_ones(), 4);
        // The four openings are d3, c4, f5, e6 — positions 19, 26, 37, 44.
        assert_ne!(moves & bit_pos(2, 3), 0, "d3");
        assert_ne!(moves & bit_pos(3, 2), 0, "c4");
        assert_ne!(moves & bit_pos(4, 5), 0, "f5");
        assert_ne!(moves & bit_pos(5, 4), 0, "e6");
    }

    #[test]
    fn playing_d3_flips_d4() {
        reset();
        // d3 = (row 2, col 3) = bit 19
        let ok = apply_move(19);
        assert_eq!(ok, 1);
        // Black now has d3, d4, d5, e4 (added d3, captured d4 from white).
        assert_eq!(black_count(), 4);
        assert_eq!(white_count(), 1);
        assert_eq!(current_turn(), 1); // white's turn
    }

    #[test]
    fn illegal_move_returns_zero() {
        reset();
        // a1 = (0,0) = bit 0 — no legal first move for black.
        let ok = apply_move(0);
        assert_eq!(ok, 0);
        // State unchanged.
        assert_eq!(black_count(), 2);
        assert_eq!(white_count(), 2);
        assert_eq!(current_turn(), 0);
    }

    #[test]
    fn ai_at_shallow_depth_returns_a_legal_move() {
        reset();
        let pos = ai_choose_move(2);
        assert!(pos < 64, "expected a legal square, got pass");
        let legal = legal_moves_bits();
        assert_ne!(legal & (1u64 << pos), 0, "AI picked an illegal square");
    }

    #[test]
    fn ai_takes_corner_on_diagonal_setup() {
        reset();
        // Construct the smallest possible position where a1 is legal:
        // white at b2, black at c3, black to move. Playing a1 flips b2
        // along the NW direction and completes the diagonal.
        unsafe {
            BLACK = bit_pos(2, 2);
            WHITE = bit_pos(1, 1);
            TURN = 0;
        }
        let moves = legal_moves_bits();
        assert_ne!(moves & 1, 0, "a1 must be legal in this setup");
        let pos = ai_choose_move(3);
        assert_eq!(pos, 0, "AI should play a1");
    }

    #[test]
    fn apply_pass_only_when_forced() {
        reset();
        // At the start both sides have moves — passing must fail.
        assert_eq!(apply_move(64), 0);
    }
}
