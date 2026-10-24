# メイメイ

League of Legends「ランダムミッド: メイヘム（ARAM Mayhem）」のチャンピオン、オーグメント、ビルドを日本語で調べられる静的サイトです。

## ページ

| URL | 内容 |
| --- | --- |
| `/` | よく選ばれるチャンピオンとオーグメント、集計がまだない新オーグメント |
| `/tier-list/` | 注目度ティア（ピック率・増減・コンボ評価から自動算出。`src/data/builds.yaml` の tier があればそちらを優先）とピック率ランキング |
| `/champions/` | チャンピオン一覧（名前検索、ロール絞り込み） |
| `/champions/<スラッグ>/` | ピック率、おすすめオーグメントとアイテム |
| `/augments/` | オーグメント一覧（名前・効果検索、レアリティ絞り込み） |
| `/augments/<スラッグ>/` | 効果、ピック率、おすすめのチャンピオン |
| `/items/` | ARAM で買える完成アイテムと ID |

## 開発

Node.js 22.12 以上が必要です。

```sh
npm install
npm run dev          # http://localhost:4321
npm run build        # dist/ に静的ファイルを出力
npm run check        # 型チェック
npm run fetch-data   # ゲームデータとピック率を取り直す
```

## データ

`npm run fetch-data`（`scripts/fetch-data.mjs`）が次のデータを取得し、`src/data/*.json` と `public/img/augments/` に保存します。GitHub Actions（`.github/workflows/update-data.yml`）が毎日自動で実行し、変更があればコミットします。

| データ | 取得元 |
| --- | --- |
| チャンピオン、アイテム（日本語） | [Data Dragon](https://developer.riotgames.com/docs/lol#data-dragon) |
| メイヘムのオーグメント（`kiwi.bin.json`）、名前とレアリティ、説明文、アイコン | [CommunityDragon](https://raw.communitydragon.org/) |
| チャンピオンとオーグメントのピック率 | [arammayhem.com のオープンデータ](https://arammayhem.com/data/)（CC BY 4.0。出典表記が必要） |

Riot API（match-v5）はメイヘムの試合データを返さないため使っていません。Riot はメイヘムのオーグメント勝率を公開しないよう開発者に求めているため、勝率は載せていません。

### ティアとおすすめビルドの編集

`src/data/builds.yaml` に書きます。書き方はファイル先頭のコメントを見てください。オーグメントのスラッグは各オーグメントページの URL、アイテム ID は `/items/` で確認できます。存在しないスラッグや ID はビルド時に警告が出て、表示から外れます。

## 公開

Cloudflare Workers（静的アセット）で公開しています。Cloudflare 側の設定はビルドコマンド `npm run build`、デプロイコマンド `npx wrangler deploy` で、`wrangler.jsonc` が `dist/` をそのまま配信します。main が更新されるたびに Cloudflare が自動でビルドします。

## 注意

メイメイは Riot Games の承認を受けたものではなく、Riot Games および League of Legends の制作・運営に公式に関わる人物の見解や意見を反映するものではありません。League of Legends および Riot Games は Riot Games, Inc. の商標または登録商標です。
