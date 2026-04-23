# reversi-wasm

Rust で書いた Reversi / Othello エンジンを **raw WebAssembly**（wasm-bindgen なし）にコンパイルして遊べるオセロ。盤面はビットボード (u64 × 2)、AI は α-β 剪定 minimax、最終 wasm は **3.7 KB**。

[Live demo](https://sen.ltd/portfolio/reversi-wasm/)

## What it does

- 8 × 8 の盤で、黒 / 白 のオセロ対局
- 人 vs AI (白/黒どちら側でも) / 人 vs 人
- AI の強さは 4 段階（探索深さ 1〜5）
- 合法手はハイライト。パスは自動で促す
- リセットはいつでも
- コア思考ロジックは Rust 製で 250 行程度。すべて wasm に入る

## Stack

- **Rust** (no_std, no heap) — bitboard + α-β minimax
- **Raw WebAssembly** — `WebAssembly.instantiate` から直接 export を呼ぶ。wasm-bindgen は不要
- **Vanilla JS + HTML + CSS** — 外部依存ゼロ

## Getting started

ビルドは Docker 経由（ホストに Rust を入れる必要なし）:

```sh
./build.sh          # → assets/reversi.wasm
npm run serve       # localhost:8080
```

テスト（Rust 側）:

```sh
docker run --rm -v "$PWD/rust:/work" -w /work rust:1.90-alpine cargo test --lib
```

## Project layout

```
rust/
  Cargo.toml        — no_std, cdylib, tight release profile
  src/lib.rs        — bitboards, legal_moves, apply_move, negamax AI
src/
  main.js           — loads wasm, renders board, routes clicks & AI
index.html
style.css
assets/
  reversi.wasm      — built artifact (3.7 KB)
build.sh            — Docker-wrapped cargo build
```

## How it works

### Bitboard

盤面を 2 本の `u64` で持ちます:
- `BLACK` — 黒の石があるマスのビットが立つ
- `WHITE` — 白の同じく

`bit = row * 8 + col`。bit 0 = a1 (左上)、bit 63 = h8 (右下)。

### Legal moves (1 方向)

「自分の石から opp の連続を経て empty に到達する」を bitwise で 1 行に書けます:

```rust
fn legal_moves_dir(me: u64, opp: u64, empty: u64, shift: Shift) -> u64 {
    let mut run = shift(me) & opp;
    run |= shift(run) & opp;  // 最大 6 回（8 幅 - 2 端）展開
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    run |= shift(run) & opp;
    shift(run) & empty
}
```

8 方向それぞれ呼んで OR。これが 3.7 KB の中身の大部分。

### AI

標準的な negamax + α-β。評価関数は古典的なポジション重み表 + 可動数（自分の合法手数 - 相手の合法手数）× 5。終局時は石差 × 10000。

## License

MIT. See `LICENSE`.

<!-- sen-publish:links -->
## Links

- 🌐 Demo: https://sen.ltd/portfolio/reversi-wasm/
- 📝 dev.to: https://dev.to/sendotltd/a-37-kb-othello-engine-bitboards-in-rust-raw-wasm-no-wasm-bindgen-353f
<!-- /sen-publish:links -->
