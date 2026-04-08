# Proposal: GSUB自動制御グリフ挿入 & NEWLINE仕様

**Status**: Draft
**Target**: v0.4

## 概要

フォント変更のみでCode 2501を完結させるため、OpenType GSUB機能を利用して
START/STOPグリフを自動挿入する仕様、およびNEWLINEグリフの定義を提案する。

## 動機

現行v0.2ではSTART/STOPをPUA文字として手動挿入 or エンコーダ経由で挿入する必要がある。
これではCode 2501の核心コンセプト「フォント変更だけでコード化」が実現できない。

エンコーダを通すならQRコードの細長い版で十分であり、
Code 2501の存在意義は「テキストがそのままコードになる」ことにある。

## 提案1: GSUB caltによるSTART/STOP自動挿入

### 仕組み

OpenType `calt`（Contextual Alternates）機能を利用する。
テキストレンダラ（ブラウザ、OS、アプリ）が自動的に適用するため、
ユーザーはフォントを適用するだけでよい。

### STARTの自動挿入

**原理**: 全文字にSTARTを付けるのをデフォルトとし、前に文字がある場合だけ取り消す。

```opentype
# グリフ定義
# a.code, b.code, ... = Code 2501のCHARグリフ
# a.start, b.start, ... = START + CHARの合成グリフ（ligature）
# @ALL = 全てのCode 2501グリフのクラス

# Lookup 1: 全文字を START付きに置換（デフォルト）
lookup StartDefault {
  lookupflag 0;
  sub a by a.start;
  sub b by b.start;
  sub c by c.start;
  # ... 全対応文字分
} StartDefault;

# Lookup 2: 前にグリフがある場合、START無し版に戻す
lookup StartCancel {
  lookupflag 0;
  sub a.start by a.code;
  sub b.start by b.code;
  sub c.start by c.code;
  # ... 全対応文字分
} StartCancel;

# Lookup 3: 文脈ルール — @ALLの直後にある文字のSTARTを取り消す
lookup ChainCancelStart {
  lookupflag 0;
  sub @ALL a.start' lookup StartCancel;
  sub @ALL b.start' lookup StartCancel;
  sub @ALL c.start' lookup StartCancel;
  # ... 全対応文字分
} ChainCancelStart;
```

**結果**:
```
入力:  H e l l o
       ↓ StartDefault
       H.start e.start l.start l.start o.start
       ↓ ChainCancelStart
       H.start e.code  l.code  l.code  o.code
       ↑START付き  ↑以降はSTART無し
```

### STOPの自動挿入

**原理**: STARTの逆。全文字にSTOPを付けるのをデフォルトとし、後ろに文字がある場合だけ取り消す。

```opentype
# Lookup 4: 全文字を STOP付きに置換
lookup StopDefault {
  lookupflag 0;
  sub a.code by a.stop;
  sub b.code by b.code;
  # 注: STARTの処理後に適用するため、先頭文字はa.startのまま
  # ここでは.code系のみ対象とし、.start系は別ルールで処理
} StopDefault;

# Lookup 5: 後ろにグリフがある場合、STOP無し版に戻す
# (lookahead contextual substitution)
lookup ChainCancelStop {
  lookupflag 0;
  sub a.stop' lookup StopCancel @ALL;
  sub b.stop' lookup StopCancel @ALL;
  # ... 後ろに@ALLが続く場合はSTOPを外す
} ChainCancelStop;
```

**結果**:
```
入力:  H e l l o
       ↓ 全処理後
       H.start e.code l.code l.code o.stop
       ↑START              ↑STOP
```

### 先頭かつ末尾（1文字のみ）の場合

```
入力:  A
       ↓ StartDefault → A.start
       ↓ StopDefault  → A.startstop  (START+STOP合成グリフ)
```

1文字入力の場合はSTART+文字+STOPの合成グリフ `*.startstop` を使用する。

### 実装上の注意

- `calt`は多くのテキストレンダラでデフォルト有効（CSS: `font-feature-settings` 不要）
- ルール数は対応文字数に比例する。ASCII(95文字) + ひらがな + カタカナ + 常用漢字で
  数千ルールになるが、OpenTypeの仕様上は問題ない
- 一部の古いレンダラでは`calt`の複雑なチェーンルールが正しく処理されない可能性がある
  → フォールバック：ユーザーが手動でPUA文字を挿入する従来方式

## 提案2: NEWLINEグリフ

### 定義

改行文字 U+000A (LF) にCode 2501のNEWLINEグリフを割り当てる。

### NEWLINEグリフの構造

```
列0-1  : 同期バー（共通）
列2    : NEWLINEマーカー（行0-7: 全黒, 行8-15: 全白）
列3-10 : 全白（データなし）
列11-12: パリティ（全0）
```

- CHARグリフと同じ13列幅（等幅フォント維持）
- NEWLINEマーカーの上半分黒+下半分白パターンで
  バイト長フラグ（00/01/10/11）やECCマーカー（全黒）と区別可能

### テキストレンダリング上の挙動

NEWLINEグリフは描画後に改行を発生させる。
フォントの実装としては以下の2つの方式がある：

**方式A: グリフ描画 + テキストエンジン任せの改行**
- U+000Aに対してNEWLINEグリフを描画
- 改行自体はテキストエンジンが処理（通常のLF挙動）
- NEWLINEグリフはその行の終端マーカーとして機能

**方式B: 改行をSTOP+STARTに分解**
- 改行位置で現在行のSTOPを挿入し、次行の先頭でSTARTを挿入
- GSUBの改行対応が困難な場合のフォールバック

**推奨**: 方式A。テキストエンジンのLF処理に乗るのが最もシンプル。

### 行間セパレータとの関係

改行時の行間（セパレータパターン4行分）はフォントのline-height設定で確保する。

```
フォントメトリクス:
  ascent  = グリフ16行 + セパレータ上1行 = 17ユニット
  descent = セパレータ下1行 = 1ユニット
  line-gap = 空白2行 = 2ユニット
  合計 = 20ユニット（グリフ16行 + 行間4行）
```

## 提案3: リーダー側部分読みガイドライン

チャンク読みの知性はリーダー側に寄せる方針のため、
以下をリーダー実装の推奨ガイドラインとして仕様に記載する。

### 部分読みモード

- STARTが検出できない場合、リーダーは部分読みモードに遷移する
- 各CHARグリフは自己完結（データ + グリフ内RS ECC）のため単独デコード可能
- グリフの物理座標（左→右、上→下）から読み取り順序を復元する

### フレーム間スティッチング（スクロール表示対応）

- 連続フレーム間で重複するグリフを同期バー + データパターンで照合する
- 新たに出現したグリフを既存の復元テキストに追記する
- START/STOPが出現した時点でテキスト境界を確定する

### ページ跨ぎ

- ページ番号等のメタ情報はテキスト内容として記述する（運用規約）
- リーダーはSTART/STOPの対を1つの文書単位として扱う

## 仕様への影響

| 項目 | 変更内容 |
|---|---|
| CHAR グリフ | 変更なし |
| START グリフ | フォント内で自動挿入（GSUB calt） |
| STOP グリフ | フォント内で自動挿入（GSUB calt） |
| ECC グリフ | 廃止（グリフ内RS ECCで代替） |
| NEWLINE グリフ | 新設（U+000A割り当て） |
| PUA マッピング | U+E000(START), U+E001(STOP)は手動挿入用フォールバックとして維持 |
| ECC Interval | ヘッダから削除（ブロックECC廃止のため） |

## 未決事項

- [ ] GSUB caltルールの対応文字範囲（ASCII only? CJK込み?）
- [ ] テキストレンダラごとのcalt互換性検証
- [ ] NEWLINEグリフの方式A/Bの最終決定
- [ ] ヘッダ領域のフィールド再設計（ECC Interval削除後の再配分）
- [ ] 行間セパレータパターンのフォントメトリクスでの表現検証
