#!/bin/zsh
# launchd entry point for the daily activity update. Runs publish-activity.mjs with a Node.js
# installed on this Mac (nvm first, then Homebrew/PATH), never a runtime bundled inside an app.
emulate -L zsh

script=${0:A:h}/../scripts/publish-activity.mjs

# The newest nvm-managed Node 24 (numeric glob sort, so v24.10 beats v24.9); upgrades are picked up automatically.
candidates=($HOME/.nvm/versions/node/v24.*/bin/node(Nn))
if (( $#candidates )); then
  node=$candidates[-1]
elif node=$(command -v node) && (( ${${$($node --version)#v}%%.*} >= 22 )); then
  : # A Homebrew or other PATH install that meets the project's engines requirement.
else
  print -u2 "run-activity: no Node.js 22+ found. Install one with 'nvm install 24' or 'brew install node'."
  exit 1
fi

exec $node $script "$@"
