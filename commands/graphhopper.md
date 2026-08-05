---
description: graphhopper ループを goal で開始する
agent: build
---
skill ツールで `graphhopper` をロードし、以下の goal でループを開始せよ。

GOAL: $ARGUMENTS

手順:
1. `graphhopper_goal` (action: "start", title: GOAL) で goal を登録
2. designing フェーズから開始。.graphhopper/plans/<goal-id>.md に設計を書く（source編集はここでは物理ブロックされる）
3. 以降は session.idle ごとに自動で継続注入される。止めるときは /graphhopper-stop
