#!/bin/sh
# キー割当（plugin_action）からポップアップを開く。placement は manifest の popup に従う
exec "${HERDR_BIN_PATH:-herdr}" plugin pane open --plugin graphhopper.board --entrypoint board
