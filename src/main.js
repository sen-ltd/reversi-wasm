// UI shell for the Rust/WASM Reversi engine. Loads reversi.wasm, renders
// the 8x8 board, routes clicks to the exported apply_move, and either
// hands the next turn to the human or asks the AI for its move.

const WASM_URL = './assets/reversi.wasm';

let engine = null;
let mode = 'ai-white'; // 'hvh' | 'ai-white' | 'ai-black'
let aiDepth = 4;
let aiThinking = false;

async function boot() {
  const res = await fetch(WASM_URL);
  const bytes = await res.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  engine = instance.exports;
  engine.reset();
  render();
  // If the AI is black (plays first), kick off its move.
  maybeTriggerAi();
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  // --- Header ---
  const header = document.createElement('header');
  header.innerHTML = `
    <h1>Reversi</h1>
    <p class="subtitle">RUST → WASM — BITBOARDS + α-β PRUNING</p>
  `;
  app.appendChild(header);

  // --- Status row ---
  const status = document.createElement('section');
  status.className = 'status';
  const black = engine.black_count();
  const white = engine.white_count();
  const turn = engine.current_turn();
  const gameOver = engine.is_game_over() === 1;
  status.innerHTML = `
    <div class="score">
      <span class="chip"><span class="disc-mini black"></span>${black}</span>
      <span class="chip"><span class="disc-mini white"></span>${white}</span>
    </div>
    <div class="turn-label">
      ${
        gameOver
          ? black > white ? '黒の勝ち' : white > black ? '白の勝ち' : '引き分け'
          : turn === 0 ? '黒の番' : '白の番'
      }
    </div>
  `;
  app.appendChild(status);

  // --- Board ---
  const legal = engine.legal_moves_bits();
  const blackBits = engine.black_discs();
  const whiteBits = engine.white_discs();
  const board = document.createElement('div');
  board.className = 'board';
  for (let i = 0; i < 64; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const bit = 1n << BigInt(i);
    const isLegal = !gameOver && !aiThinking && (legal & bit) !== 0n && isHumanTurn();
    if (isLegal) {
      cell.classList.add('legal');
      cell.addEventListener('click', () => playHuman(i));
    }
    if ((blackBits & bit) !== 0n) {
      const d = document.createElement('div');
      d.className = 'disc black';
      cell.appendChild(d);
    } else if ((whiteBits & bit) !== 0n) {
      const d = document.createElement('div');
      d.className = 'disc white';
      cell.appendChild(d);
    }
    board.appendChild(cell);
  }
  app.appendChild(board);

  // --- Message row ---
  const msg = document.createElement('div');
  msg.className = 'message';
  if (aiThinking) {
    msg.textContent = 'AI 思考中…';
  } else if (gameOver) {
    msg.textContent = `最終スコア: 黒 ${black} - 白 ${white}`;
  } else if (legal === 0n) {
    const who = turn === 0 ? '黒' : '白';
    msg.textContent = `${who}はパスします`;
  }
  app.appendChild(msg);

  // --- Controls ---
  const controls = document.createElement('section');
  controls.className = 'controls';

  const passBtn = button('パス', () => {
    if (engine.legal_moves_bits() !== 0n) return;
    engine.apply_move(64);
    render();
    maybeTriggerAi();
  });
  passBtn.disabled = !(legal === 0n && !gameOver && isHumanTurn());
  controls.appendChild(passBtn);

  const resetBtn = button(
    'リセット',
    () => {
      engine.reset();
      aiThinking = false;
      render();
      maybeTriggerAi();
    },
    { primary: true },
  );
  controls.appendChild(resetBtn);

  app.appendChild(controls);

  // --- Mode row ---
  const modeRow = document.createElement('section');
  modeRow.className = 'mode-row';
  modeRow.innerHTML = `
    <label>モード
      <select id="mode">
        <option value="ai-white" ${mode === 'ai-white' ? 'selected' : ''}>人 (黒) vs AI (白)</option>
        <option value="ai-black" ${mode === 'ai-black' ? 'selected' : ''}>AI (黒) vs 人 (白)</option>
        <option value="hvh" ${mode === 'hvh' ? 'selected' : ''}>人 vs 人</option>
      </select>
    </label>
    <label>強さ
      <select id="depth">
        <option value="1" ${aiDepth === 1 ? 'selected' : ''}>弱</option>
        <option value="3" ${aiDepth === 3 ? 'selected' : ''}>中</option>
        <option value="4" ${aiDepth === 4 ? 'selected' : ''}>強</option>
        <option value="5" ${aiDepth === 5 ? 'selected' : ''}>最強</option>
      </select>
    </label>
  `;
  modeRow.querySelector('#mode').addEventListener('change', (e) => {
    mode = e.target.value;
    engine.reset();
    render();
    maybeTriggerAi();
  });
  modeRow.querySelector('#depth').addEventListener('change', (e) => {
    aiDepth = Number(e.target.value);
    render();
  });
  app.appendChild(modeRow);

  const footer = document.createElement('footer');
  footer.innerHTML = `
    WASM ${engine.legal_moves_bits() !== undefined ? '✓' : '✗'} ·
    <a href="https://github.com/sen-ltd/reversi-wasm" target="_blank" rel="noopener">source</a> ·
    <a href="https://sen.ltd/" target="_blank" rel="noopener">SEN 合同会社</a>
  `;
  app.appendChild(footer);
}

function button(label, onClick, opts = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (opts.primary) b.className = 'primary';
  b.addEventListener('click', onClick);
  return b;
}

function isHumanTurn() {
  const turn = engine.current_turn();
  if (mode === 'hvh') return true;
  if (mode === 'ai-white') return turn === 0; // human plays black
  if (mode === 'ai-black') return turn === 1; // human plays white
  return true;
}

function playHuman(pos) {
  if (aiThinking || !isHumanTurn()) return;
  if (engine.apply_move(pos) === 0) return;
  render();
  maybeTriggerAi();
}

function maybeTriggerAi() {
  if (mode === 'hvh') return;
  if (engine.is_game_over() === 1) return;
  if (isHumanTurn()) return;
  aiThinking = true;
  render();
  // Defer to next frame so the "thinking" UI paints before the search
  // hogs the main thread.
  requestAnimationFrame(() => {
    setTimeout(() => {
      const pos = engine.ai_choose_move(aiDepth);
      engine.apply_move(pos);
      aiThinking = false;
      render();
      // The AI might still have to move if the human's forced pass followed.
      maybeTriggerAi();
    }, 120);
  });
}

boot().catch((e) => {
  document.getElementById('app').textContent =
    `Failed to load WASM: ${e.message}`;
});
