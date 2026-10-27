---
description: 今の graphhopper の進捗を .graphhopper/HANDOFF.md に書き出し、新しい会話へ引き継ぐ
agent: build
---
`graphhopper_handoff` (action: "write") を呼び、`.graphhopper/HANDOFF.md` に進捗を書き出せ。
出力された path と goal・phase をそのまま表示し、「新しい会話を開いて続きから再開できる」と伝えよ。
新しい会話では案内が出るので `graphhopper_handoff` (action: "load") を呼ぶだけでよい。
