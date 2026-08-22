# Séance

A Factorio 2.1 combinator that asks the construction ghosts in its logistic network what
they need, and answers with a shopping list.

Place it anywhere inside a logistic network. It reports the items required to finish
everything waiting to be built in that network, as circuit signals you can wire into a
requester chest, a train station, a display panel, or anything else that reads a signal.

## What it counts

Everything the network's construction robots would consume, scanned across the
construction area of every roboport in the network:

|                                                 | reported as                                       |
| ----------------------------------------------- | ------------------------------------------------- |
| entity ghosts                                   | the items that place them, at the ghost's quality |
| tile ghosts                                     | the items that place them, e.g. concrete          |
| module requests on ghosts and on built entities | the requested modules                             |
| entities marked for upgrade                     | the items that place the **upgrade target**       |
| cliffs marked for deconstruction                | cliff explosives                                  |

Ghosts covered by two overlapping roboports are counted once. The same item in two
qualities stays two separate signals.

## Publishing to a logistic group

Turn on **Publish to logistic group** and the scanner also writes its list into a
force-wide logistic group. A requester chest, buffer chest or space platform hub can then
select that group and request exactly what the network is missing, with nothing wired to
the scanner at all.

The group is named after the logistic network — `Construction Requests for Outpost Foo` —
and follows the network if you rename it. Networks without a name fall back to
`Séance <unit number>`. Open the combinator and type a name over it to pin it: a name you
choose is never moved again.

Two networks can end up with the same name, because splitting a network leaves both
halves carrying it. Only one scanner takes the derived name in that case, decided by the
lowest unit number so it does not change across a reload; the other keeps its fallback
until the name is free again.

## Mod settings

All settings are map settings, under _Settings → Mod settings → Map_.

| setting                           | default | what it does                                                                                        |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| Scanned areas per tick            | 5       | Roboport construction areas scanned per tick. Lower is cheaper and slower.                          |
| Logistics network update interval | 180     | Minimum ticks between passes over the scanners.                                                     |
| Area scan update interval         | 5       | Minimum ticks between area scans.                                                                   |
| Scan result limit                 | 1000    | Ghosts counted per scanner. `0` removes the limit. Lower is cheaper.                                |
| Show hidden items                 | off     | Include items flagged hidden, e.g. LTN input/output.                                                |
| Invert output                     | off     | Emit negative counts, for use as LTN requests.                                                      |
| Round to stacks                   | off     | Round each count up to a full stack (down when inverted).                                           |
| Publish to logistic group         | off     | Also publish the list as a logistic group, as above.                                                |
| Alert on missing items            | off     | Raise a map alert when the network cannot supply what its ghosts want. At most 5 items per scanner. |

## For other mods

```lua
remote.call("seance", "missing_items", unit_number)
--> { { name = "transport-belt", quality = "normal", needed = 2, available = 0 }, ... }

remote.call("seance", "logistic_group", unit_number)
--> "Construction Requests for Outpost Foo"
```

`missing_items` is what the network cannot currently supply of what its ghosts are
asking for, which is also what drives the map alerts.

## Credits

Séance is a fork of [Ghost Scanner 4](https://github.com/Cyberboss/factorio-ghost-scanner-4)
by Cyberboss, which was itself a TypeScript port of
[GhostScanner2](https://github.com/Tiavor/GhostScanner2) by Tiavor, in turn descended from
the original Ghost Scanner. The scanning approach, the settings and most of the behaviour
described above are their work; this fork updated it to Factorio 2.1, fixed a number of
counting bugs, and added the logistic group and alerting features. Thank you to all three
for everything that came before.

Upstream pull requests [#227](https://github.com/Cyberboss/factorio-ghost-scanner-4/pull/227)
by leoric and Symgot, and
[#228](https://github.com/Cyberboss/factorio-ghost-scanner-4/pull/228) by mcurses, were
reviewed while building this; #228's entity guards are incorporated.

The combinator, its recipe and every mod setting kept their internal names through the
rename, so a save can swap Ghost Scanner 4 for Séance and keep the combinators it already
has, along with their settings.

Please open an issue if you have a problem.

## Development

See [DESIGN.md](DESIGN.md) for how the mod works internally.

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
test/run.sh --alerts     # what the network cannot supply of what its ghosts want
test/run.sh --upgrade    # a save written by the previous commit, loaded by this build
test/run.sh --all        # every one of the above
```

`FACTORIO=/path/to/binary` and `TICKS=3000` override the defaults. The scenarios live in
`test/harness/control.lua`; each is a list of steps, one step per scan cycle.
