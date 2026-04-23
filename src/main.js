// UI shell for the Rust/WASM Reversi engine. DOM is built once on boot;
// subsequent state changes only mutate the bits that actually changed,
// so the CSS `flip` animation only runs for newly-placed or newly-
// flipped discs instead of every disc on the board.

const WASM_URL = './assets/reversi.wasm';

let engine = null;
let mode = 'ai-white'; // 'hvh' | 'ai-white' | 'ai-black'
let aiDepth = 4;
let aiThinking = false;

// History stack for undo: each entry is { black, white, turn } as BigInts.
// We push *before* any call to apply_move, so undoing = pop + set_state.
const history = [];

// Long-lived DOM refs. All populated by buildShell() on first boot.
let boardEl = null;
const cellEls = new Array(64);
let scoreBlackEl = null;
let scoreWhiteEl = null;
let turnLabelEl = null;
let msgEl = null;
let passBtn = null;
let undoBtn = null;

async function boot() {
  const res = await fetch(WASM_URL);
  const bytes = await res.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  engine = instance.exports;
  engine.reset();
  buildShell();
  update();
  maybeTriggerAi();
}

function buildShell() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  const header = document.createElement('header');
  header.innerHTML = `
    <h1>Reversi</h1>
    <p class="subtitle">RUST → WASM — BITBOARDS + α-β PRUNING</p>
  `;
  app.appendChild(header);

  const status = document.createElement('section');
  status.className = 'status';
  status.innerHTML = `
    <div class="score">
      <span class="chip"><span class="disc-mini black"></span><span data-score-black>0</span></span>
      <span class="chip"><span class="disc-mini white"></span><span data-score-white>0</span></span>
    </div>
    <div class="turn-label" data-turn-label></div>
  `;
  scoreBlackEl = status.querySelector('[data-score-black]');
  scoreWhiteEl = status.querySelector('[data-score-white]');
  turnLabelEl = status.querySelector('[data-turn-label]');
  app.appendChild(status);

  boardEl = document.createElement('div');
  boardEl.className = 'board';
  for (let i = 0; i < 64; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.pos = String(i);
    cellEls[i] = cell;
    boardEl.appendChild(cell);
  }
  // Event delegation — one listener for all 64 cells, routed by dataset.
  boardEl.addEventListener('click', onBoardClick);
  app.appendChild(boardEl);

  msgEl = document.createElement('div');
  msgEl.className = 'message';
  app.appendChild(msgEl);

  const controls = document.createElement('section');
  controls.className = 'controls';

  passBtn = document.createElement('button');
  passBtn.type = 'button';
  passBtn.textContent = 'パス';
  passBtn.addEventListener('click', onPass);
  controls.appendChild(passBtn);

  undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.textContent = '1 手戻る';
  undoBtn.addEventListener('click', onUndo);
  controls.appendChild(undoBtn);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = 'リセット';
  resetBtn.className = 'primary';
  resetBtn.addEventListener('click', onReset);
  controls.appendChild(resetBtn);

  app.appendChild(controls);

  const modeRow = document.createElement('section');
  modeRow.className = 'mode-row';
  modeRow.innerHTML = `
    <label>モード
      <select data-mode>
        <option value="ai-white">人 (黒) vs AI (白)</option>
        <option value="ai-black">AI (黒) vs 人 (白)</option>
        <option value="hvh">人 vs 人</option>
      </select>
    </label>
    <label>強さ
      <select data-depth>
        <option value="1">弱</option>
        <option value="3">中</option>
        <option value="4" selected>強</option>
        <option value="5">最強</option>
      </select>
    </label>
  `;
  const modeSel = modeRow.querySelector('[data-mode]');
  modeSel.value = mode;
  modeSel.addEventListener('change', (e) => {
    mode = e.target.value;
    onReset();
  });
  modeRow.querySelector('[data-depth]').addEventListener('change', (e) => {
    aiDepth = Number(e.target.value);
  });
  app.appendChild(modeRow);

  const footer = document.createElement('footer');
  footer.innerHTML = `
    WASM ✓ ·
    <a href="https://github.com/sen-ltd/reversi-wasm" target="_blank" rel="noopener">source</a> ·
    <a href="https://sen.ltd/" target="_blank" rel="noopener">SEN 合同会社</a>
  `;
  app.appendChild(footer);
}

function update() {
  const black = engine.black_discs();
  const white = engine.white_discs();
  const turn = engine.current_turn();
  const legal = engine.legal_moves_bits();
  const gameOver = engine.is_game_over() === 1;
  const humansTurn = !gameOver && !aiThinking && isHumanTurn();

  // Score
  scoreBlackEl.textContent = String(engine.black_count());
  scoreWhiteEl.textContent = String(engine.white_count());

  // Turn label / game result
  if (gameOver) {
    const b = Number(engine.black_count());
    const w = Number(engine.white_count());
    turnLabelEl.textContent = b > w ? '黒の勝ち' : w > b ? '白の勝ち' : '引き分け';
  } else {
    turnLabelEl.textContent = turn === 0 ? '黒の番' : '白の番';
  }

  // Cells: only touch what actually changed. The flip animation is tied
  // to the insertion of a new `.disc`, so untouched cells stay still.
  for (let i = 0; i < 64; i++) {
    const bit = 1n << BigInt(i);
    const cell = cellEls[i];
    const isBlack = (black & bit) !== 0n;
    const isWhite = (white & bit) !== 0n;
    const nextColor = isBlack ? 'black' : isWhite ? 'white' : null;

    const existing = cell.firstElementChild;
    const currentColor = existing
      ? existing.classList.contains('black') ? 'black' : 'white'
      : null;

    if (currentColor !== nextColor) {
      if (existing) existing.remove();
      if (nextColor) {
        const d = document.createElement('div');
        d.className = `disc ${nextColor}`;
        cell.appendChild(d);
      }
    }

    // Toggle legal-move hint. Disable clicks with a sentinel class so
    // the CSS doesn't paint a dot during the AI's turn.
    const isLegal = humansTurn && (legal & bit) !== 0n;
    cell.classList.toggle('legal', isLegal);
  }

  // Message line
  if (aiThinking) {
    msgEl.textContent = 'AI 思考中…';
  } else if (gameOver) {
    msgEl.textContent = `最終スコア: 黒 ${engine.black_count()} - 白 ${engine.white_count()}`;
  } else if (legal === 0n) {
    msgEl.textContent = `${turn === 0 ? '黒' : '白'}はパスします`;
  } else {
    msgEl.textContent = '';
  }

  // Controls
  passBtn.disabled = !(legal === 0n && !gameOver && humansTurn);
  undoBtn.disabled = aiThinking || history.length === 0;
}

function onBoardClick(e) {
  const cell = e.target.closest('.cell');
  if (!cell || !cell.classList.contains('legal')) return;
  const pos = Number(cell.dataset.pos);
  playHuman(pos);
}

function onPass() {
  if (engine.legal_moves_bits() !== 0n) return;
  pushHistory();
  engine.apply_move(64);
  update();
  maybeTriggerAi();
}

function onUndo() {
  if (aiThinking) return;
  // In AI mode, undo rewinds past both the AI response and the human's
  // move so control returns to the same "human to play" state as before.
  // In HvH we only pop once.
  do {
    if (history.length === 0) return;
    const prev = history.pop();
    engine.set_state(prev.black, prev.white, prev.turn);
  } while (!isHumanTurn() && history.length > 0);
  update();
}

function onReset() {
  engine.reset();
  history.length = 0;
  aiThinking = false;
  update();
  maybeTriggerAi();
}

function isHumanTurn() {
  const turn = engine.current_turn();
  if (mode === 'hvh') return true;
  if (mode === 'ai-white') return turn === 0;
  if (mode === 'ai-black') return turn === 1;
  return true;
}

function pushHistory() {
  history.push({
    black: engine.black_discs(),
    white: engine.white_discs(),
    turn: engine.current_turn(),
  });
}

function playHuman(pos) {
  if (aiThinking || !isHumanTurn()) return;
  pushHistory();
  if (engine.apply_move(pos) === 0) {
    history.pop(); // rollback the snapshot if the move was illegal
    return;
  }
  update();
  maybeTriggerAi();
}

function maybeTriggerAi() {
  if (mode === 'hvh') return;
  if (engine.is_game_over() === 1) return;
  if (isHumanTurn()) return;
  aiThinking = true;
  update();
  // Yield to the browser so the "thinking" UI paints before the search
  // hogs the main thread.
  requestAnimationFrame(() => {
    setTimeout(() => {
      pushHistory();
      const pos = engine.ai_choose_move(aiDepth);
      engine.apply_move(pos);
      aiThinking = false;
      update();
      maybeTriggerAi();
    }, 120);
  });
}

boot().catch((e) => {
  document.getElementById('app').textContent =
    `Failed to load WASM: ${e.message}`;
});
