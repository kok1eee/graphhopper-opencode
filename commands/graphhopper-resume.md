---
description: 一時停止した graphhopper ループを再開する（handoff メモがあれば先に復元）
agent: build
---
`.graphhopper/HANDOFF.md` があれば `graphhopper_handoff` (action: "load") を呼んで goal を復元し、
報告された「メモとのズレ」を確認せよ（正は state）。無ければ `graphhopper_goal` (action: "resume") を呼ぶ。
その後 `graphhopper_status` で phase を確認し、そのフェーズの手順を続行する。
