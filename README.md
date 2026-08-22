# Séance

A Factorio combinator that asks the construction ghosts in its logistic network what
they need, and answers with a shopping list.

Place it anywhere inside a logistic network. It reports the items required by everything
waiting to be built in that network: entity ghosts, tile ghosts, module requests, upgrade
orders and cliff explosives. Optionally it publishes that list as a logistic group, so a
requester chest or a platform hub can request exactly what the outpost is missing without
a single wire.

Formerly **Ghost Scanner 4**, and before that
[GhostScanner2](https://github.com/Tiavor/GhostScanner2) by Tiavor. The combinator, its
recipe and every mod setting kept their internal names through the rename, so a save can
swap one mod for the other and keep the combinators it already has.

Please open an issue if you have a problem.

## Development

You'll need a node 22+ environment setup. VSCode is the recommended IDE.

Run `corepack enable` to ensure you're using the correct yarn version.

Run `yarn` to install dependencies like the typescript-to-lua compiler and typed-factorio definitions.

Run `yarn build` to build the mod `.zip` in the `build/` directory.

Run `yarn install_mod` to build and copy the mod to `~/AppData/Roaming/Factorio/mods`.
On macOS the mods folder is `~/Library/Application Support/factorio/mods` instead.

### Tests

`test/run.sh` builds the mod, loads it into a throwaway Factorio install of its own and
asserts on what the combinator actually outputs. It never touches your real mods folder
or saves, and it has its own Factorio write directory, so it runs while you are playing.

```
test/run.sh              # signal correctness, mod defaults
test/run.sh --invert     # ... with "Invert output" on
test/run.sh --stacks     # ... with "Round to stacks" on
test/run.sh --slow       # ... with the pacing settings at their extremes
test/run.sh --groups     # logistic group naming, renaming and collisions
test/run.sh --topology   # the network merging with another and splitting again
test/run.sh --lifecycle  # switched off, switched on, destroyed by script
test/run.sh --upgrade    # a save written by the previous commit, loaded by this build
test/run.sh --all        # every one of the above
```

`FACTORIO=/path/to/binary` and `TICKS=3000` override the defaults. The scenarios live in
`test/harness/control.lua`; each is a list of steps, one step per scan cycle.

### Performance

This is a rough 1-to-1 port of GhostScanner2. In writing it, I've come to realize that there's a big opportunity for performance improvements if, instead of scanning for ghosts/related entities, the control script was reworked to be purely event driven when ghosts are created/built/deleted and scan only when logistic areas are created/updated/deleted.
