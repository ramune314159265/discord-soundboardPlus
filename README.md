# Discord Soundboard Activity

Discord の通話で使えるサウンドボード風 Activity。Activity 上のボタンを押すと、ボット経由で通話に音が流れます。

- サーバー: Node.js / discord.js / @discordjs/voice / Hono / ws (JavaScript, ESM)
- クライアント: React / Chakra UI v3 / jotai / @discord/embedded-app-sdk / Vite
- DB・ffmpeg 不要。サウンドは `data/` 配下の JSON + `.ogg` ファイルで保存
- 音声はクライアント側で **48kHz ステレオ Ogg Opus** に変換してアップロード。サーバーは再生時に PCM へ展開し、同時に鳴らす音を合成してから Opus にして流します (下記「同時再生」)

## 仕様との対応

| 仕様 | 実装 |
|---|---|
| ボットがいない → 参加ボタン | `BotGate.jsx` (別の通話にいる場合は「移動」ボタン) |
| ボットがいる → サウンド一覧 + 追加ボタン | `SoundGrid.jsx` / `AddSoundPanel.jsx` |
| 追加時にクライアントで opus 変換 | `client/src/audio/` (下記) |
| 再生中でも重ねて同時再生 (同じ音も可、上限 8) | `server/src/mixer.js` / `bot.js` の `play()` (サーバー権威) |
| ボット在席・再生中を WS で配信、再生中ボタンを緑枠 | `server/src/ws.js` / `SoundGrid.jsx` |
| 左側に再生中の一覧、1つずつ/まとめて停止 | `NowPlayingPanel.jsx` / WS の `stop` `stopAll` |
| サウンドはギルド共有、追加・削除は全員 | ギルドメンバーであれば誰でも可 |
| 音量調整なし / 音声長の制限なし | アップロードサイズ上限のみ (既定 8MB) |
| 通話にボットだけになったら自動退出 | `server/src/bot.js` (下記「自動退出」) |
| 画面右上にギルドのアイコンと名前 | `GuildBadge.jsx` (接続状態の隣) |
| ミニフローティングウィンドウでは「ダブルクリックしてください」表示 | `PipOverlay.jsx` (下記「PiP 表示」) |

## セットアップ

### 1. Discord Developer Portal

1. アプリケーションを作成し、**Application ID** と **Client Secret** (OAuth2) を控える
2. **Bot** を作成してトークンを控える (特権 Intent は不要)
3. **Activities → Settings** で Activities を有効化
4. **Activities → URL Mappings** に `/` → 公開ホスト名 (例: `xxxx.trycloudflare.com`、`https://` なし) を登録
5. **OAuth2** の Redirects に任意のURL (例 `https://127.0.0.1`) を1つ登録 (Activity の認可に必要)
6. ボットを自分のサーバーに招待 (scope: `bot`、権限: View Channels / Connect / Speak)

### 2. エントリーポイントコマンド (Activity の起動に必要)

App Launcher から Activity を起動するには、`PRIMARY_ENTRY_POINT` (type 4) のコマンドが必要です。
Discord は Activities を有効化すると "Launch" を自動作成しますが、コマンドを一括上書きした場合などに無くなることがあります。

- **サーバー起動時に自動で確認・登録します** (無ければ作成、handler が違えば修正、あれば何もしません)
- 手動で実行する場合: `npm run register-commands`
- handler は `DISCORD_LAUNCH_ACTIVITY` (2) です。Discord が Activity を起動してチャンネルにメッセージを投稿するので、
  こちらでインタラクションを処理する必要はありません
- Developer Portal の Activities > Settings で Activities が有効になっている必要があります

### 3. 環境変数

```sh
cp .env.example .env
# DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_BOT_TOKEN / VITE_DISCORD_CLIENT_ID を埋める
```

### 4. 起動 (本番相当: 1プロセス)

```sh
npm install
npm run build   # クライアントをビルド (VITE_DISCORD_CLIENT_ID はこの時に埋め込まれる)
npm start       # http://localhost:3000 で API / WS / 画面をまとめて配信
cloudflared tunnel --url http://localhost:3000   # 出てきたホストを URL Mapping に登録
```

Discord のボイスチャンネルで「アクティビティを開始」→ このアプリを選択します。

### 開発時

```sh
npm run dev:server   # :3000 (Hono + bot)
npm run dev:client   # :5173 (Vite。/api と /ws は :3000 に中継)
cloudflared tunnel --url http://localhost:5173
```

Discord 経由だと Vite の HMR が効かないことがあります。その場合は再ビルド + `npm start` を使ってください。

### 音声の追加 (複数ファイル)

- 「＋ 音声を追加」で音声ファイルを**複数**選べます。選んだファイルごとに「絵文字」と「名前」を入力できます
- ファイル名が `(絵文字)_(名前).(拡張子)` の形 (例: `🎺_ぱふぱふ.mp3`) なら、絵文字と名前を自動入力します。
  それ以外は、絵文字は既定の 🎉、名前は拡張子を除いたファイル名になります
- 選び直すと、それまでの選択は破棄されて置き換わります (追加はされません)
- 1件ずつ変換 → アップロードします。失敗したファイルだけが行にエラー付きで残るので、直して再実行できます

### テスト

```sh
npm test   # サーバー93件 + クライアント75件 (ボットの参加・移動・自動退出は、Discord を模したフェイクで検証)
```

## ディレクトリ

```
server/src
  index.js    起動
  config.js   環境変数
  auth.js     OAuth2 code 交換、トークン → ユーザー/所属ギルド(名前・アイコン含む)確認 (5分キャッシュ)
  routes.js   Hono: /api/token, /api/guilds/:id/sounds, /bot/join, /bot/leave, 静的配信
  entryPoint.js  エントリーポイントコマンドの登録 (冪等)
  web.js      ブラウザ版: /auth/login・/auth/callback・/api/web/session・/api/web/targets
  ws.js       WebSocket (/ws): hello → ready / state / sounds / play
  bot.js      VC 接続・移動・再生・自動退出 (@discordjs/voice)
  mixer.js    同時再生: 複数の音を 20ms ごとに PCM で合成 → Opus パケット化して1本のストリームで流す
  oggOpusSource.js  Ogg Opus を PCM に少しずつ展開する音源 (ffmpeg 不要)
  opusCodec.js      libopus (opusscript の wasm) を直接使うエンコーダー/デコーダー
  store.js    sounds/index.json + sounds/<id>.ogg (サーバーで分けずフラット。所有者・タグ・編集。メモリキャッシュ、直列化、tmp→rename)
  ogg.js      アップロードされた Ogg Opus の検証 (CRC・構造・長さ)
  hub.js      ギルド単位の WS ルーム
client/src
  bootstrap.js  Discord SDK 初期化 → 認証 → WS 接続
  socket.js     WS 再接続 (指数バックオフ) と ping
  state.js      jotai atoms
  audio/        decode → 48kHz → Opus → Ogg
  layout.js     Discord の表示モード定数 (FOCUSED / PIP / GRID)
  webBootstrap.js  ブラウザ版の起動 (ログイン確認 → 通話に入るのを待つ → 接続)
  soundList.js  タグの正規化・集計・AND絞り込み
  components/   BotGate / SoundGrid(タブ) / TagFilter / TagInput / EditSoundPanel / AddSoundPanel / GuildBadge / PipOverlay / Toast
data/sounds/index.json, data/sounds/<soundId>.ogg   (実行時に作成。フラット保存)
```

## サウンドの一覧・タグ・編集

- 保存はサーバー(ギルド)ごとに分けず、`data/sounds/` にフラットに置きます。各サウンドは追加したサーバー(`guildId`)と追加した人(`createdBy`)を持ちます。
  以前の `data/guilds/...` 構成は読みません(移行なし)。
- 一覧は2つのタブです。**このサーバー**(このサーバーで追加されたもの)と **自分が追加**(自分が追加したもの。他のサーバーで追加した分も含む)。
  どちらのタブのサウンドも、今の通話で鳴らせます。他人が他のサーバーで追加したものは鳴らせません。
- **タグ**(1つのサウンドに複数、1つ20文字・10個まで)。追加時にファイルごとに付けられ、一覧の上のタグ絞り込みで選ぶと、選んだタグを**すべて**持つものだけ表示します。
- 「自分が追加」タブを開いて追加すると、サーバーには属さず**自分だけのサウンド**になります (どのサーバーの通話でも自分だけが鳴らせ、他の人には見えません)。
- **編集**: 各ボタンの ✎ から、名前・絵文字・タグを変更できます。編集・削除できるのは、追加した本人か、そのサウンドのあるサーバーのメンバーです。
- 追加・編集・削除は、影響する人(同じサーバー、または追加した本人の別の接続)へリアルタイムに配信されます。

## アクティビティの外(スマホのブラウザなど)から鳴らす

PCで通話に入りながら、スマホのブラウザで音を鳴らせます。

1. `.env` に `PUBLIC_URL` (例 `https://example.com`) を設定し、Developer Portal の **OAuth2 > Redirects** に `<PUBLIC_URL>/auth/callback` を登録します。
2. スマホのブラウザで `PUBLIC_URL` を開き、「Discordでログイン」(scope は identify / guilds のみ)。
3. **ボットのいる通話に自分も入っているサーバー**があれば自動でつながり、一覧から鳴らせます (複数あれば選択)。
   通話に入っていなければ「通話に入るのを待っています」と表示され、入ると自動でつながります。

- 「通話に入っているか」はサーバー側でボットのボイスステートから判定します。つなぐ時と、再生・停止のたびに確認し、通話から抜けた時点で操作できなくなります (5秒ごとの確認で画面も待機に戻ります)。
- 自分は通話に入っているがボットがいないときは、「ボットを通話に呼ぶ」ボタンが出ます。呼べるのは**自分が今いる通話だけ**です (サーバー側で確認)。退出はブラウザからはできません。
- アクセストークンは HttpOnly Cookie (SameSite=Lax、https なら Secure) に入り、有効期限は Discord のトークンと同じ(最大7日)です。

## ボットの参加・移動・自動退出

- **移動**: 別の通話にいるボットを移すときは、接続を作り直さず、既存の接続のまま参加先だけを切り替えます。
  (以前は「退出 → 再参加」だったため、遅れて届く退出通知で新しい接続まで切られ、
  一瞬入ってすぐ抜ける・ボタンが固まる不具合がありました)
- 自分が送った退出に対する通知は無視し、キックなど本当の切断だけを検知して状態に反映します
- 参加の待機中に切断された場合は、20 秒待たずにすぐエラーを返します
- **自動退出**: 通話に**ボット以外の人間が誰もいなくなる**と、猶予のあとで自動退出します。
  猶予の間に誰かが戻ってくれば取り消します。猶予は `.env` の `AUTO_LEAVE_DELAY_MS` (既定 5000、0 で即時)
  - 他のボット (音楽ボットなど) は「人」として数えません。ボット自身だけでなく他のボットだけが残った場合も退出します
  - メンバー情報が取得できていない参加者は、安全のため「人」として数えます (誤って抜けないため)

## PiP 表示

Discord のウェブ版などで Activity がミニフローティングウィンドウ (PiP) になると、そのままでは操作できません。
`ACTIVITY_LAYOUT_MODE_UPDATE` を購読し、PiP のときだけ全面に「操作するにはダブルクリックしてください」を表示します
(通常表示・グリッド表示では出ません)。

## 音声変換の仕組み (`client/src/audio`)

1. `decodeAudioData` でデコードし、`OfflineAudioContext` で 48kHz ステレオに揃える
2. WebCodecs の `AudioEncoder` (opus) が使えればそれでエンコード
3. 使えない環境 (WebView 等) は `opusscript` (libopus の asm.js) に自動フォールバック
4. 自前の Ogg muxer (`oggMuxer.js`) で OpusHead / OpusTags / CRC 付きのページにまとめる

ffmpeg.wasm は使っていません (SharedArrayBuffer が Activity の iframe で使えない可能性が高いため)。

## 認可の考え方

- クライアントが送る `guildId` は信用せず、OAuth2 トークンで Discord から取得した所属ギルドと照合します
- 再生は「WS の hello で申告した通話 = ボットがいる通話」のときだけ受け付けます
- 要望どおり、**ギルドメンバーかどうかだけ**を確認しています (通話に実際にいるかは見ていません)

## 音量の正規化

アップロードするとき、クライアントで音量を揃えます (`client/src/audio/loudness.js`)。
ITU-R BS.1770 の K 特性ラウドネス (ゲート付き統合ラウドネス、LUFS) を測り、**-18 LUFS** になるようにゲインを掛けます。
大きすぎる音は下げ、小さすぎる音は上げます。ピークが -1 dBFS を超える部分は、先読みリミッターで滑らかに抑えます。
- 上げすぎてノイズを持ち上げないよう、上げるのは最大 +24 dB まで。完全な無音はそのままです
- 400ms に満たない短い音は、全体を1つのブロックとして測ります
- **これまでにアップロード済みのサウンドは変わりません** (再アップロードすると揃います)。目標値は `TARGET_LUFS` で変えられます

## 見た目

Chakra UI の標準テーマ (`defaultSystem`) のままです。独自の色指定は入れていません。
ライト/ダークは端末 (OS・ブラウザ) の設定に従い、開いたまま設定を変えても追従します (`client/src/colorMode.js`)。

## 同時再生

サウンドのボタンは、鳴っている途中でも押せます。同じサウンドをもう一度押すと重なって鳴り、鳴っているボタンには緑枠が付きます。
画面の左側 (狭い画面では上) に「再生中」の一覧があり、1つずつ「停止」したり、「すべて停止」したりできます。
一覧は、流し終わるのが後のものが上です。各行に再生位置のバーと残り時間が出ます (サーバーが再生位置と長さを送り、画面が時計で補間して動かします)。
停止は、ボットが今いる通話のメンバーなら誰でもできます (追加・削除と同じ扱い)。

- 仕組み: @wetalabs/mixer と同じ考え方 (各音を PCM に展開 → 20ms ごとに足し合わせ → 1本の出力) を自前で実装しています。
  @wetalabs/mixer は PCM への展開に ffmpeg を使い、`@discordjs/voice` 0.16 に依存するため (こちらは ffmpeg なし・0.19.2)、そのままは使っていません
- 展開と合成は ffmpeg なしで、`opusscript` に入っている libopus (wasm) だけで行います。音は少しずつ展開するので、長い音でもメモリは増えません
- 同時に鳴らせるのは **8音まで** (`server/src/bot.js` の `maxVoices`)。超えた分は無視されます
- 連打などで音量が溢れるときは、音を切り捨てる代わりに、先読みリミッターで超える前から滑らかにゲインを下げ、あとでゆっくり戻します
  (20ms の先読みのぶん出力が遅れます。溢れないときはゲイン 1 のままで、音は変わりません)。
  音の出だしの約 2ms はフェードイン、止めた音は約 5ms でフェードアウトして、クリック音を避けます
- 音が鳴っていない間は何も送りません。最後の音が終わって約0.2秒後にストリームを閉じ、次の音で作り直します
- 再生ボタンを押してから鳴るまでの遅延は、これまでより 40〜60ms ほど増える見込みです (出力を先読みして作るため)
- `opusscript` の JS ラッパーは、複数インスタンスで互いのメモリを上書きして落ちることがあるため使わず、wasm を直接呼ぶ `opusCodec.js` を使っています

## 既知の制約・注意点

- **未検証 (実機が必要)**: Discord 上での Activity 起動、モバイルでのファイル選択、実際のボット音声再生、PiP 表示。
  同時再生は、本物の `@discordjs/voice` のプレイヤーに流して Opus パケットとして取り出せること、ffmpeg の展開結果と一致することまでは検証済みです (Discord への送信は未検証)
- ギルドアイコンは `cdn.discordapp.com` から直接読み込みます。Activity 側の制限で読み込めない場合は、
  自動的にサーバー名の頭文字の丸に切り替わります
- モバイルの Activity では `<input type="file">` が動かない可能性があります。その場合の代替 (PC からのみ追加する等) をご検討ください
- 保存先が永続でない環境では、再デプロイで `data/` が消えます (要望により許容)
- 同じサーバー内で複数の通話から同時にアクティビティを開いても、ボットは1つの通話にしか入れません。
  別の通話にいる場合は「移動」ボタンになります
- 再生遅延は 100〜300ms 程度が目安です
