# Design

How Séance works internally, and why it works that way. Written for someone about to
change [src/control.ts](src/control.ts).

## The shape of the problem

The combinator has to answer one question: _what items would finish everything waiting to
be built in this logistic network?_ Two things make that harder than it sounds.

**Scope is not a circuit concept.** The scanner is wired into a circuit network, but what
it reports is scoped by a **logistic** network — the roboports whose construction areas
would actually service those ghosts. The two have nothing to do with each other. The
circuit side is output only.

**Coverage is not the same radius as membership.** A roboport's _logistic_ area (radius 25) decides which network a position belongs to. Its _construction_ area (radius 50)
decides which ghosts its robots will build. The scanner is located by the first and scans
by the second, so a ghost can be inside the construction area of a network it does not
belong to. `find_logistic_network_by_position` answers the membership question;
`find_logistic_networks_by_construction_area` answers the coverage one.

## The scan

`UpdateSensor` resolves the scanner's network and snapshots `network.cells` into
`storage.scanAreas`. `UpdateArea` then works through those cells, and `GetGhostsAsSignals`
turns one cell into signals: a bounding box of `cell.owner.position ± construction_radius`
and five `find_entities_filtered` passes over it, all filtered by force.

| pass          | filter                                               | signal                                              |
| ------------- | ---------------------------------------------------- | --------------------------------------------------- |
| cliffs        | `type: "cliff"` + `is_registered_for_deconstruction` | `cliff_explosive_prototype`                         |
| upgrades      | `to_be_upgraded`                                     | `items_to_place_this` of the upgrade target         |
| entity ghosts | `type: "entity-ghost"`                               | `items_to_place_this` + the ghost's `item_requests` |
| proxies       | `type: "item-request-proxy"`                         | its `item_requests`                                 |
| tile ghosts   | `type: "tile-ghost"`                                 | `items_to_place_this`                               |

Three details do the real work:

**Deduplication across cells.** Roboports overlap, so the same ghost is found repeatedly.
`storage.foundEntities[scannerId]` holds what has already been counted this pass. Keys are
prefixed per kind, because the three kinds identify differently: entities by
`unit_number`, cliffs by `c<x>/<y>`, item request proxies by `p<registration>`. The
prefixes are not decoration — registration ids and unit numbers are both small integers
and used to collide. Cliffs were once keyed by the position _table_, and since a fresh
table comes back on every read, the lookup never matched and cliffs were counted once per
covering roboport.

**Boundaries.** `find_entities_filtered` returns anything whose _collision box_ touches
the area, which would pull in ghosts just outside the roboport's reach. The search uses a
box shrunk by 0.001 for the position-based passes, and re-checks the entity's centre with
`IsInBBox` for the rest.

**Publish only when complete.** Signals accumulate in `storage.scanSignals` across cells.
Only when the last cell of the network is consumed does `UpdateArea` clear the combinator
and assign the filters in one go. A partially scanned network is never written out, which
is what stops the output flickering.

## Aggregating into signals

`AddSignal` accumulates counts into one filter per distinct signal. A signal is identified
by **item and quality together**, so the lookup key is `name/quality`. Both halves matter:
keying on the item alone collapses a rare belt into a normal one, and keying on the
quality alone (which the code did for a while) means nothing ever aggregates and every
ghost pushes its own filter entry. The combinator sums duplicate entries within a section,
so that bug produced correct totals while making the filter list grow without bound.

## Pacing

Everything is throttled, because a scan is proportional to cells × entities and runs
forever whether or not anything changed:

- `on_tick` returns immediately unless `tick % areaScanDelay == 0`.
- Each pass resolves the network for exactly **one** scanner, and scans at most
  `scanAreasPerTick` cells.
- Once every scanner has been visited, `updateTimeout` blocks further work until
  `on_nth_tick(updateInterval + 1)` releases it.

This is the mod's biggest weakness. A static base pays exactly the same cost as one being
actively built. Making it event driven is possible — every mutation has an event, and
`find_logistic_networks_by_construction_area` gives the right attribution primitive — but
three things stop it being purely event driven: there is no event for a robot partially
delivering an item request, no event for a roboport losing power and thereby changing
network membership, and ghosts can be replaced in place. A hybrid, with incremental
updates plus a slow reconciliation pass, is the realistic design.

## Logistic groups

A logistic section that joins a group shares its filters with every other member of that
group, force-wide. Publishing the scanner's section into a group is therefore all it takes
for a requester chest to consume the output directly.

Naming has to survive Factorio's network semantics, which are looser than they look.
Measured on 2.1.14:

| action                   | result                                                    |
| ------------------------ | --------------------------------------------------------- |
| add or remove a roboport | network id and name survive                               |
| join two networks        | one network, **one of the two names is silently dropped** |
| split a network          | two networks, **both carrying the same name**             |

So the derived name (`Construction Requests for <network name>`) can be claimed by two
scanners at once. Only one may hold it, or they would take turns overwriting one shared
filter list. The claim goes to the **lowest unit number**, not to whoever scanned first,
because scanners are not visited in a fixed order and first-come-first-served handed the
name to a different scanner after a reload — silently re-pointing every chest aimed at it.

A name typed on the combinator **pins** the scanner: `storage.pinnedGroups` records it and
derivation stops. A group this mod no longer writes to is deleted, unless another scanner
still publishes into it, because its filters would otherwise freeze at the last scan while
chests kept requesting them.

## Storage and migrations

`storage` holds the scanner registry, the in-progress scan state, the group names and the
pins. Two rules:

**Transient state is rebuilt, not migrated.** `scanSignals`, `scanAreas` and
`proxyRegistrations` are recreated on load; only `ghostScanners`, `logisticGroups`,
`pinnedGroups` and the flags are preserved.

**Do not rely on `on_configuration_changed`.** It only fires when the mod _version_
changes. A save written by a different build of the same version comes back through
`on_load` alone, which may not write `storage`, so every field added since is nil.
`storage.storageVersion` is checked at the top of the tick handler as well, so a missing
field can never reach a scan. Bump `StorageVersion` whenever you add a field.

## Removal

A scanner can go away without any event this mod hears. Mining, robot mining, death and
`script_raised_destroy` are handled; a deleted surface or a bare `entity.destroy()` are
not, and leave a stale record whose next dereference is an unrecoverable
`LuaEntity API call when LuaEntity was invalid`. Both scan paths therefore check `.valid`
first and forget the scanner if it has gone. Anything force-wide the scanner owns — its
logistic group, its alerts — has to be cleaned up while the entity is still readable,
which is why `OnEntityRemoved` does that work before unregistering.

## Testing

Everything is verified against a real Factorio, driven headless: `--create` builds a map
with a scenario mod, `--benchmark` runs it for N ticks, and the scenario asserts on what
the combinator actually output. See [test/run.sh](test/run.sh).

Two things have no coverage and are worth knowing about. **Map alerts** only exist for
connected players, and a benchmark has none — the calculation behind them is exposed
through the `seance` remote interface and tested there, but the rendering is not.
**`maxResults`** is deliberately untested: its accounting is incremented for some passes
and decremented for others, so a test would pin the inconsistency in place rather than
catch it.
