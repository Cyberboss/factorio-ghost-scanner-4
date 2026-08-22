import {
    BoundingBox,
    ComparatorString,
    ItemToPlace,
    LogisticFilterWrite,
    LuaConstantCombinatorControlBehavior,
    LuaEntity,
    LuaEntityPrototype,
    LuaForce,
    LuaLogisticCell,
    LuaLogisticSection,
    LuaNotificationQueue,
    LuaQualityPrototype,
    LuaTilePrototype,
    MapPosition,
    OnBuiltEntityEvent,
    OnEntityDiedEvent,
    OnPrePlayerMinedItemEvent,
    OnRobotBuiltEntityEvent,
    OnRobotPreMinedEvent,
    OnTickEvent,
    QualityID,
    ScriptRaisedBuiltEvent,
    ScriptRaisedDestroyEvent,
    ScriptRaisedReviveEvent,
    SignalFilter,
    SignalIDType,
    UnitNumber
} from "factorio:runtime";

import {
    AreasPerTickSetting,
    LogisticGroupSetting,
    MaxResultsSetting,
    MissingAlertsSetting,
    NegativeOutputSetting,
    RoundToStackSetting,
    ScanAreasDelaySetting,
    ShowHiddenSetting,
    UpdateIntervalSetting
} from "./setting_names";

type GhostsAsSignals = LogisticFilterWrite[];

interface GhostScanner {
    id: UnitNumber;
    entity: LuaEntity;
}

interface ScanArea {
    cells: LuaLogisticCell[];
    force: LuaForce;
}

// Bumped whenever a field is added here. on_configuration_changed only fires when the
// mod version changes, so a save written by a different build of the SAME version comes
// back with only on_load, which cannot create storage. Anything new would be nil.
const StorageVersion = 2;

interface Storage {
    storageVersion: number;
    lookupItemsToPlaceThis: LuaMap<string, ItemToPlace[]>;
    ghostScanners: GhostScanner[];
    scanSignals: LuaMap<UnitNumber, LogisticFilterWrite[]>;
    signalIndexes: LuaMap<UnitNumber, LuaMap<string, number>>;
    scanAreas: LuaMap<UnitNumber, ScanArea>;
    // entities are keyed by unit number; cliffs and item request proxies have none,
    // so they are keyed by prefixed strings that cannot collide with a unit number
    foundEntities: LuaMap<UnitNumber, LuaSet<UnitNumber | string>>;
    proxyRegistrations: LuaMap<UnitNumber, LuaNotificationQueue>;
    // the logistic group name last applied per scanner, so a name the player typed
    // on the combinator can be told apart from one this mod put there
    logisticGroups: LuaMap<UnitNumber, string>;
    // scanners whose group name the player typed. Those are left alone; every other
    // scanner keeps deriving its name from the logistic network it sits in.
    pinnedGroups: LuaSet<UnitNumber>;
    updateTimeout: boolean;
    updateIndex: number;
    initMod: boolean;
}

declare const storage: Storage;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ModLog = (message: string) => {
    // uncomment to debug
    // game.print(message);
    // log(message);
};

const ScannerName = "ghost-scanner";

let scanAreasPerTick = settings.global[AreasPerTickSetting].value as number;
let updateInterval = settings.global[UpdateIntervalSetting].value as number;
let scanAreasDelay = settings.global[ScanAreasDelaySetting].value as number;
let maxResults: number | undefined = settings.global[MaxResultsSetting].value as number;

if (maxResults == 0) {
    maxResults = undefined;
}

let showHidden = settings.global[ShowHiddenSetting].value as boolean;
let invertSign = settings.global[NegativeOutputSetting].value as boolean;
let roundToStack = settings.global[RoundToStackSetting].value as boolean;
let publishLogisticGroup = settings.global[LogisticGroupSetting].value as boolean;
let alertMissingItems = settings.global[MissingAlertsSetting].value as boolean;
script.on_event(defines.events.on_runtime_mod_setting_changed, event => {
    ModLog("Settings changed");
    let updateEventHandlers = false;

    switch (event.setting) {
        case UpdateIntervalSetting: {
            updateInterval = settings.global[UpdateIntervalSetting].value as number;
            updateEventHandlers = true;
            break;
        }
        case AreasPerTickSetting: {
            scanAreasPerTick = settings.global[AreasPerTickSetting].value as number;
            updateEventHandlers = true;
            break;
        }
        case MaxResultsSetting: {
            maxResults = settings.global[MaxResultsSetting].value as number;

            if (maxResults == 0) {
                maxResults = undefined;
            }

            break;
        }
        case ShowHiddenSetting: {
            showHidden = settings.global[ShowHiddenSetting].value as boolean;
            storage.lookupItemsToPlaceThis = new LuaMap<string, ItemToPlace[]>();
            break;
        }
        case NegativeOutputSetting: {
            invertSign = settings.global[NegativeOutputSetting].value as boolean;
            break;
        }
        case RoundToStackSetting: {
            roundToStack = settings.global[RoundToStackSetting].value as boolean;
            break;
        }
        case ScanAreasDelaySetting: {
            scanAreasDelay = settings.global[ScanAreasDelaySetting].value as number;
            break;
        }
        case LogisticGroupSetting: {
            publishLogisticGroup = settings.global[LogisticGroupSetting].value as boolean;
            if (!publishLogisticGroup) {
                // the groups are force wide, so they outlive the sections that fed them
                for (const scanner of storage.ghostScanners) {
                    if (scanner.entity.valid) {
                        DeleteLogisticGroup(scanner.entity.force, scanner.id);
                    }
                }
            }

            break;
        }
        case MissingAlertsSetting: {
            alertMissingItems = settings.global[MissingAlertsSetting].value as boolean;
            if (!alertMissingItems) {
                for (const scanner of storage.ghostScanners) {
                    if (scanner.entity.valid) {
                        scanner.entity.force.remove_alert({ entity: scanner.entity });
                    }
                }
            }

            break;
        }
    }

    if (updateEventHandlers) {
        UpdateEventHandlers();
    }
});

// Sections that join a logistic group share their filters with every other member of
// that group, force wide, which is what lets a requester chest consume a scanner's
// output directly. The default name is keyed on the scanner's unit number so that it
// is stable for the life of the combinator, but the player can rename the group on the
// combinator and that name is then kept.
const DefaultLogisticGroupName = (id: UnitNumber) => `Séance ${id}`;

// what DefaultLogisticGroupName produced before the mod was renamed
const LegacyLogisticGroupName = (id: UnitNumber) => `Ghost Scanner ${id}`;

const NetworkGroupPrefix = "Construction Requests for ";

// Networks do not hold their name as tightly as they look: joining two swallows one of
// the names, and splitting one leaves BOTH halves carrying it. A derived name is
// therefore only taken when no scanner in another network has a better claim on it,
// otherwise the two would take turns overwriting one shared filter list.
//
// The claim is settled on the lowest unit number rather than on who got there first,
// because scanners are not visited in a fixed order: first come first served would hand
// the name to a different scanner after a reload and silently re-point everything that
// pointed at it.
const NameClaimedElsewhere = (force: LuaForce, id: UnitNumber, networkId: number, name: string) => {
    const group = force.get_logistic_group(name);
    if (!group) {
        return false;
    }

    for (const member of group.members) {
        const owner = member.owner;
        if (!owner.valid || owner.name != ScannerName || owner.unit_number == id) {
            continue;
        }

        const ownerNetwork = owner.surface.find_logistic_network_by_position(
            owner.position,
            owner.force
        );

        // another scanner in the same network is welcome to share, it publishes the
        // very same contents; one in a different network would fight over the group
        if ((!ownerNetwork || ownerNetwork.network_id != networkId) && owner.unit_number! < id) {
            return true;
        }
    }

    return false;
};

const DeriveLogisticGroupName = (entity: LuaEntity, id: UnitNumber) => {
    const fallback = DefaultLogisticGroupName(id);
    const force = entity.force;
    const network = entity.surface.find_logistic_network_by_position(entity.position, force);
    if (!network || !network.custom_name || network.custom_name == "") {
        return fallback;
    }

    const derived = `${NetworkGroupPrefix}${network.custom_name}`;
    if (NameClaimedElsewhere(force, id, network.network_id, derived)) {
        ModLog(`Scanner ${id} cannot claim ${derived}, another network holds it`);
        return fallback;
    }

    return derived;
};

// A group is force wide state that outlives the sections feeding it. One this mod no
// longer writes to is dropped rather than left behind: its filters would freeze at the
// last scan and any chest still pointing at it would silently keep requesting them.
// Another scanner publishing into the same group is the one reason to keep it.
const DropUnusedLogisticGroup = (force: LuaForce, name: string) => {
    const group = force.get_logistic_group(name);
    if (group) {
        for (const member of group.members) {
            const owner = member.owner;
            if (owner.valid && owner.name == ScannerName) {
                ModLog(`Keeping logistic group ${name}, another scanner publishes to it`);
                return;
            }
        }
    }

    force.delete_logistic_group(name);
};

const ApplyLogisticGroup = (ghostScanner: GhostScanner, section: LuaLogisticSection) => {
    const id = ghostScanner.id;
    const force = ghostScanner.entity.force;
    const applied = storage.logisticGroups.get(id);

    if (!publishLogisticGroup) {
        if (applied != undefined) {
            if (section.group == applied) {
                section.group = "";
            }

            storage.logisticGroups.delete(id);
            storage.pinnedGroups.delete(id);
            DropUnusedLogisticGroup(force, applied);
        }

        return;
    }

    const current = section.group;
    if (applied != undefined && current != "" && current != applied) {
        // the player renamed the group on the combinator. That pins it: the network
        // name stops driving it from here on.
        ModLog(`Scanner ${id} logistic group renamed from ${applied} to ${current}`);
        storage.logisticGroups.set(id, current);
        storage.pinnedGroups.add(id);
        DropUnusedLogisticGroup(force, applied);
        return;
    }

    const name = storage.pinnedGroups.has(id)
        ? (applied ?? DefaultLogisticGroupName(id))
        : DeriveLogisticGroupName(ghostScanner.entity, id);

    if (current != name) {
        force.create_logistic_group(name);
        section.group = name;
    }

    if (applied != undefined && applied != name) {
        // the network was renamed underneath us, so the group moved with it
        ModLog(`Scanner ${id} logistic group moved from ${applied} to ${name}`);
        DropUnusedLogisticGroup(force, applied);
    }

    storage.logisticGroups.set(id, name);
};

// Used when the scanner is already gone and its force can no longer be read from it.
// Dropping the name from every force is safe: DropUnusedLogisticGroup keeps any group
// another scanner still publishes into.
const ForgetLogisticGroup = (id: UnitNumber) => {
    const name = storage.logisticGroups.get(id);
    if (name == undefined) {
        return;
    }

    for (const [, force] of game.forces) {
        DropUnusedLogisticGroup(force, name);
    }

    storage.logisticGroups.delete(id);
    storage.pinnedGroups.delete(id);
};

const DeleteLogisticGroup = (force: LuaForce, id: UnitNumber) => {
    force.delete_logistic_group(storage.logisticGroups.get(id) ?? DefaultLogisticGroupName(id));
    storage.logisticGroups.delete(id);
    storage.pinnedGroups.delete(id);
};

const MaxAlertsPerScanner = 5;

interface MissingItem {
    name: string;
    quality: string;
    needed: number;
    available: number;
}

// What the network cannot currently supply of what its ghosts are asking for. Split out
// from the alerting so it can be inspected without a connected player: alerts only exist
// for players, which leaves nothing to assert against on a headless run.
const CollectMissingItems = (ghostScanner: GhostScanner): MissingItem[] => {
    const missing: MissingItem[] = [];
    const entity = ghostScanner.entity;
    if (!entity.valid) {
        return missing;
    }

    const network = entity.surface.find_logistic_network_by_position(entity.position, entity.force);
    if (!network) {
        return missing;
    }

    for (const signal of storage.scanSignals.get(ghostScanner.id) ?? []) {
        const filter = signal.value! as {
            readonly name: string;
            readonly quality?: QualityID;
        };

        // the count is negative when the output is inverted, and the shortfall is the
        // same either way
        const needed = math.abs(signal.min!);
        if (needed == 0) {
            continue;
        }

        const quality = filter.quality ?? "normal";
        const available = network.get_item_count({ name: filter.name, quality });
        if (available < needed) {
            missing.push({
                name: filter.name,
                quality: (quality as LuaQualityPrototype).name ?? (quality as string),
                needed,
                available
            });
        }
    }

    return missing;
};

const AlertMissingItems = (ghostScanner: GhostScanner) => {
    const entity = ghostScanner.entity;
    const force = entity.force;
    force.remove_alert({ entity });

    const network = entity.surface.find_logistic_network_by_position(entity.position, force);
    if (!network) {
        return;
    }

    const networkName = network.custom_name != "" ? network.custom_name : `${network.network_id}`;

    let alerts = 0;
    for (const item of CollectMissingItems(ghostScanner)) {
        if (alerts >= MaxAlertsPerScanner) {
            break;
        }

        force.add_custom_alert(
            entity,
            { type: "item", name: item.name, quality: item.quality },
            ["ghost-scanner.alert-missing", item.name, item.needed - item.available, networkName],
            true
        );
        ++alerts;
    }
};

const OnEntityCreated = (
    event:
        | OnBuiltEntityEvent
        | OnRobotBuiltEntityEvent
        | ScriptRaisedBuiltEvent
        | ScriptRaisedReviveEvent
) => {
    const entity = event.entity;
    if (entity.valid && entity.name == ScannerName) {
        ModLog("Found new ghost scanner");

        storage.ghostScanners.push({
            id: entity.unit_number!,
            entity: entity
        });

        UpdateEventHandlers();
    }
};

const OnEntityRemoved = (
    event:
        | OnPrePlayerMinedItemEvent
        | OnRobotPreMinedEvent
        | OnEntityDiedEvent
        | ScriptRaisedDestroyEvent
) => {
    const entity = event.entity;
    if (entity && entity.valid && entity.name == ScannerName) {
        // the group and any alerts outlive the entity, and both need it to still be
        // valid to be addressed, so they have to go before the sensor is forgotten
        const force = entity.force;
        const id = entity.unit_number!;
        force.remove_alert({ entity });
        DeleteLogisticGroup(force, id);
        RemoveSensor(id);
    }
};

const CleanUp = (id: UnitNumber) => {
    ModLog(`Cleanup ${id}`);
    storage.scanSignals.delete(id);
    storage.signalIndexes.delete(id);
    storage.scanAreas.delete(id);
    storage.foundEntities.delete(id);
    storage.proxyRegistrations.delete(id);
};

const RemoveSensor = (id: UnitNumber) => {
    const index = storage.ghostScanners.findIndex(scanner => scanner.id == id);
    if (index > -1) {
        storage.ghostScanners.splice(index, 1);
    }

    CleanUp(id);
    UpdateEventHandlers();
};

// Only the first section belongs to this mod. The combinator can be opened, so any
// further section is the player's and is left alone.
const ClearCombinator = (controlBehavior: LuaConstantCombinatorControlBehavior) => {
    if (controlBehavior.sections_count == 0) {
        ModLog("Adding scanner section");
        controlBehavior.add_section();
    }

    controlBehavior.get_section(1)!.filters = [];
};

const UpdateArea = () => {
    if (!storage.scanAreas) {
        ModLog("No scan areas, no area update");
        return;
    }

    let num = 1;
    for (const [id, cells] of storage.scanAreas) {
        const tempAreas = [];
        if (cells && cells.cells && cells.cells.length > 0) {
            ModLog(`Update scanner ${id}: ${cells.cells.length} cells`);
            const force = cells.force;
            for (const cell of cells.cells) {
                if (num <= scanAreasPerTick) {
                    if (!storage.scanSignals.has(id)) {
                        storage.signalIndexes.delete(id);
                        storage.scanSignals.set(id, GetGhostsAsSignals(id, cell, force, undefined));
                    } else {
                        storage.scanSignals.set(
                            id,
                            GetGhostsAsSignals(id, cell, force, storage.scanSignals.get(id))
                        );
                    }
                } else {
                    tempAreas.push(cell);
                }

                ++num;
            }

            if (tempAreas.length > 0) {
                storage.scanAreas.get(id)!.cells = [...tempAreas];
                break;
            }

            for (let j = storage.ghostScanners.length - 1; j >= 0; --j) {
                const ghostScanner = storage.ghostScanners[j];
                if (id == ghostScanner.id) {
                    if (!ghostScanner.entity.valid) {
                        ForgetLogisticGroup(id);
                        RemoveSensor(id);
                        break;
                    }

                    const controlBehavior =
                        ghostScanner.entity.get_control_behavior() as LuaConstantCombinatorControlBehavior;
                    if (!controlBehavior) {
                        ModLog(`Error: Scanner ${id} has no control behavior, dropping`);
                        ForgetLogisticGroup(id);
                        RemoveSensor(id);
                        break;
                    }

                    ClearCombinator(controlBehavior);
                    const section = controlBehavior.get_section(1)!;
                    ApplyLogisticGroup(ghostScanner, section);

                    const signalsForCombinator = storage.scanSignals.get(id);
                    if (signalsForCombinator && signalsForCombinator.length > 0) {
                        ModLog(`Setting filters for scanner ${id}`);
                        section.filters = signalsForCombinator;
                    } else {
                        ModLog(`No filters for scanner ${id}`);
                    }

                    if (alertMissingItems) {
                        AlertMissingItems(ghostScanner);
                    }

                    break;
                }

                if (j == 0) {
                    ModLog(`Error: Did not find scanner with ID ${id}`);
                    CleanUp(id);
                }
            }

            storage.scanAreas.delete(id);
            storage.foundEntities.delete(id);
        } else {
            ModLog("Error: Cells check failed");
        }
    }
};

const GetItemsToPlace = (prototype: LuaEntityPrototype | LuaTilePrototype) => {
    if (showHidden) {
        storage.lookupItemsToPlaceThis.set(prototype.name, prototype.items_to_place_this || []);
    } else {
        const itemsToPlaceFiltered: ItemToPlace[] = [];
        if (prototype.items_to_place_this) {
            for (const v of prototype.items_to_place_this) {
                const item = v.name && prototypes.item[v.name];
                if (item && !item.hidden) {
                    itemsToPlaceFiltered.push(v);
                }
            }
        }

        storage.lookupItemsToPlaceThis.set(prototype.name, itemsToPlaceFiltered);
    }

    return storage.lookupItemsToPlaceThis.get(prototype.name)!;
};

let signals: GhostsAsSignals | undefined = undefined;
const AddSignal = (id: UnitNumber, name: string, count: number, quality?: QualityID) => {
    const indexesForID = storage.signalIndexes.get(id)!;

    let qualityName = "";
    if (quality) {
        const prototype_name = (quality as LuaQualityPrototype).name;
        qualityName = prototype_name ?? (quality as string);
    }

    // signals are identified by item and quality, so both have to be part of the
    // lookup key: mixed qualities of one item must stay separate signals, while
    // repeats of the same item and quality have to accumulate into one
    const item_uid = `${name}/${qualityName}`;

    const signalIndex = indexesForID.get(item_uid);

    let s: LogisticFilterWrite;
    if (signalIndex !== undefined && signals![signalIndex]) {
        s = signals![signalIndex];
    } else {
        indexesForID.set(item_uid, signals!.length);
        s = {
            value: {
                comparator: "=",
                type: "item",
                name,
                quality
            },
            min: 0
        };
        signals!.push(s);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any).min = s.min! + (invertSign ? -count : count);
};

const IsInBBox = (pos: MapPosition, area: BoundingBox) => {
    return (
        pos.x >= area.left_top.x &&
        pos.x <= area.right_bottom.x &&
        pos.y >= area.left_top.y &&
        pos.y <= area.right_bottom.y
    );
};

const GetGhostsAsSignals = (
    id: UnitNumber,
    cell: LuaLogisticCell,
    force: LuaForce,
    prev_entry?: GhostsAsSignals
): GhostsAsSignals => {
    let resultLimit = maxResults;

    let foundEntities = storage.foundEntities.get(id);
    if (!foundEntities) {
        foundEntities = new LuaSet<UnitNumber | string>();
        storage.foundEntities.set(id, foundEntities);
    }

    signals = prev_entry;

    if (!signals) {
        signals = [];
        storage.signalIndexes.set(id, new LuaMap<string, number>());
    } else if (!storage.signalIndexes.has(id)) {
        storage.signalIndexes.set(id, new LuaMap<string, number>());
    }

    if (!cell.valid) {
        return [];
    }

    const pos = cell.owner.position;
    const r = cell.construction_radius;

    const bounds: BoundingBox = {
        left_top: {
            x: pos.x - r,
            y: pos.y - r
        },
        right_bottom: {
            x: pos.x + r,
            y: pos.y + r
        }
    };
    const innerBounds: BoundingBox = {
        left_top: {
            x: pos.x - r + 0.001,
            y: pos.y - r + 0.001
        },
        right_bottom: {
            x: pos.x + r - 0.001,
            y: pos.y + r - 0.001
        }
    };

    const searchArea = {
        bounds,
        innerBounds,
        force,
        surface: cell.owner.surface
    };

    let entities = searchArea.surface.find_entities_filtered({
        area: searchArea.innerBounds,
        limit: resultLimit,
        type: "cliff"
    });
    let countUniqueEntities = 0;

    for (const e of entities) {
        const uid = `c${e.position.x}/${e.position.y}`;
        if (
            !foundEntities.has(uid) &&
            e.is_registered_for_deconstruction(force) &&
            e.prototype.cliff_explosive_prototype
        ) {
            foundEntities.add(uid);
            AddSignal(id, e.prototype.cliff_explosive_prototype, 1, "normal"); // have to specify a quality here otherwise only a virtual signal gets set
            ++countUniqueEntities;
        }

        if (maxResults) {
            resultLimit! -= countUniqueEntities;
            countUniqueEntities = 0;
        }
    }

    if (!maxResults || resultLimit! > 0) {
        entities = searchArea.surface.find_entities_filtered({
            area: searchArea.bounds,
            limit: resultLimit,
            to_be_upgraded: true,
            force: searchArea.force
        });

        countUniqueEntities = 0;

        for (const e of entities) {
            const uid = e.unit_number!;
            const upgradeTarget = e.get_upgrade_target();
            const upgradePrototype = upgradeTarget[0];
            if (!foundEntities.has(uid) && upgradePrototype) {
                if (IsInBBox(e.position, searchArea.bounds)) {
                    foundEntities.add(uid);
                    for (const itemStack of storage.lookupItemsToPlaceThis?.get(
                        upgradePrototype.name
                    ) || GetItemsToPlace(upgradePrototype)) {
                        const itemStackCount = itemStack.count!;
                        AddSignal(id, itemStack.name, itemStackCount, upgradeTarget[1]);
                        countUniqueEntities += itemStackCount;
                    }
                }
            }
        }

        if (maxResults) {
            resultLimit! -= countUniqueEntities;
        }
    }

    if (!maxResults || resultLimit! > 0) {
        entities = searchArea.surface.find_entities_filtered({
            area: searchArea.bounds,
            type: "entity-ghost",
            force: searchArea.force,
            limit: resultLimit
        });
        countUniqueEntities = 0;
        for (const e of entities) {
            const uid = e.unit_number!;
            if (!foundEntities.has(uid)) {
                if (IsInBBox(e.position, searchArea.bounds)) {
                    foundEntities.add(uid);
                    for (const itemStack of storage.lookupItemsToPlaceThis?.get(e.ghost_name) ||
                        GetItemsToPlace(e.ghost_prototype)) {
                        const itemStackCount = itemStack.count!;
                        AddSignal(id, itemStack.name, itemStackCount, e.quality);
                        countUniqueEntities -= itemStackCount;
                    }

                    for (const requestItem of e.item_requests) {
                        AddSignal(
                            id,
                            requestItem.name,
                            requestItem.count,
                            prototypes.quality[requestItem.quality]
                        );
                        countUniqueEntities += requestItem.count;
                    }
                }
            }
        }

        if (maxResults) {
            resultLimit! -= countUniqueEntities;
        }
    }

    if (!maxResults || resultLimit! > 0) {
        entities = searchArea.surface.find_entities_filtered({
            area: searchArea.innerBounds,
            limit: resultLimit,
            type: "item-request-proxy",
            force: searchArea.force
        });
        countUniqueEntities = 0;
        // item request proxies have no unit number. register_on_object_destroyed used to
        // be abused for an id, but those registrations are permanent and accumulate in the
        // save; a notification queue hands out the same kind of id and can be dropped with
        // the scan that created it.
        let proxyRegistrations = storage.proxyRegistrations.get(id);
        if (!proxyRegistrations) {
            proxyRegistrations = script.new_notification_queue();
            storage.proxyRegistrations.set(id, proxyRegistrations);
        }

        for (const e of entities) {
            const uid = `p${proxyRegistrations.add(e)}`;
            if (!foundEntities.has(uid)) {
                foundEntities.add(uid);
                for (const requestItem of e.item_requests) {
                    AddSignal(id, requestItem.name, requestItem.count, requestItem.quality);
                    countUniqueEntities -= requestItem.count;
                }
            }
        }

        if (maxResults) {
            resultLimit! -= countUniqueEntities;
        }
    }

    if (!maxResults || resultLimit! > 0) {
        entities = searchArea.surface.find_entities_filtered({
            area: searchArea.innerBounds,
            limit: resultLimit,
            type: "tile-ghost",
            force: searchArea.force
        });
        countUniqueEntities = 0;
        for (const e of entities) {
            const uid = e.unit_number!;
            if (!foundEntities.has(uid)) {
                foundEntities.add(uid);
                for (const itemStack of storage.lookupItemsToPlaceThis?.get(e.ghost_name) ||
                    GetItemsToPlace(e.ghost_prototype)) {
                    const count = itemStack.count!;
                    AddSignal(id, itemStack.name, count, e.quality);
                    countUniqueEntities -= count;
                }
            }
        }

        if (maxResults) {
            resultLimit! -= countUniqueEntities;
        }
    }

    if (roundToStack) {
        const roundFunc = invertSign ? math.floor : math.ceil;

        for (const signal of signals!) {
            const filter = signal.value! as {
                readonly type?: SignalIDType;
                readonly name: string;
                readonly quality?: QualityID;
                readonly comparator?: ComparatorString;
            };
            const prototype = prototypes.item[filter.name];
            const stackSize = prototype.stack_size;
            const count = signal.min!;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (signal as any).min = roundFunc(count / stackSize) * stackSize;
        }
    }

    return signals;
};

const UpdateSensor = (ghostScanner: GhostScanner) => {
    if (!ghostScanner.entity.valid) {
        ModLog(`Scanner ${ghostScanner.id} is gone without an event, forgetting it`);
        ForgetLogisticGroup(ghostScanner.id);
        RemoveSensor(ghostScanner.id);
        return;
    }

    const controlBehavior =
        ghostScanner.entity.get_control_behavior() as LuaConstantCombinatorControlBehavior;
    if (!controlBehavior) {
        ModLog(`Scanner ${ghostScanner.id} has no control behavior, forgetting it`);
        ForgetLogisticGroup(ghostScanner.id);
        RemoveSensor(ghostScanner.id);
        return;
    }

    if (!controlBehavior.enabled) {
        ModLog("Combinator disabled, not updating");
        ClearCombinator(controlBehavior);
        CleanUp(ghostScanner.id);
        return;
    }

    if (!storage.scanAreas.has(ghostScanner.id)) {
        const logisticNetwork = ghostScanner.entity.surface.find_logistic_network_by_position(
            ghostScanner.entity.position,
            ghostScanner.entity.force
        );

        if (!logisticNetwork) {
            ModLog(
                `Combinator ${ghostScanner.id} has no logi-network @${ghostScanner.entity.position.x}/${ghostScanner.entity.position.y}:${ghostScanner.entity.force.name}!`
            );
            ClearCombinator(controlBehavior);
            CleanUp(ghostScanner.id);
            return;
        }

        ModLog(
            `Adding loginet ID ${logisticNetwork.network_id} from combinator ${ghostScanner.id} @${ghostScanner.entity.position.x}/${ghostScanner.entity.position.y}:${ghostScanner.entity.force.name}`
        );

        storage.scanSignals.delete(ghostScanner.id);
        storage.signalIndexes.delete(ghostScanner.id);
        storage.foundEntities.delete(ghostScanner.id);
        storage.scanAreas.set(ghostScanner.id, {
            cells: [...logisticNetwork.cells],
            force: logisticNetwork.force
        });
    }
};

const InitMod = () => {
    if (storage.initMod) {
        ModLog("Skipping mod init");
        return;
    }

    ModLog("Initializing mod for first time");
    for (const [, surface] of game.surfaces) {
        const entities = surface.find_entities_filtered({
            name: ScannerName
        });

        for (const entity of entities) {
            storage.ghostScanners.push({
                id: entity.unit_number!,
                entity: entity
            });
        }
    }

    storage.initMod = true;
};

// Runs from on_init, from on_configuration_changed, and from the first tick after a
// load that skipped both, so a missing field can never reach the scan.
const MigrateStorage = () => {
    if (storage.storageVersion == StorageVersion) {
        return;
    }

    ModLog(`Migrating storage from ${storage.storageVersion ?? 0} to ${StorageVersion}`);
    InitStorage();

    // scanners built while the mod sealed the entity keep operable = false in the save
    for (const [, surface] of game.surfaces) {
        for (const entity of surface.find_entities_filtered({ name: ScannerName })) {
            entity.operable = true;
        }
    }

    // group names used to be generated and nothing else, so any stored name that is not
    // the generated one was typed by the player and has to stay pinned rather than being
    // replaced by a name derived from the network
    for (const [id, name] of storage.logisticGroups) {
        if (name != DefaultLogisticGroupName(id) && name != LegacyLogisticGroupName(id)) {
            storage.pinnedGroups.add(id);
        }
    }

    storage.storageVersion = StorageVersion;
};

const InitEvents = () => {
    script.on_event(defines.events.on_built_entity, OnEntityCreated);
    script.on_event(defines.events.on_robot_built_entity, OnEntityCreated);
    script.on_event(defines.events.script_raised_built, OnEntityCreated);
    script.on_event(defines.events.script_raised_revive, OnEntityCreated);
    UpdateEventHandlers();
};

const OnTick = (event: OnTickEvent) => {
    if (event.tick % scanAreasDelay !== 0) {
        return;
    }

    MigrateStorage();

    if (!storage.updateTimeout) {
        if (storage.updateIndex >= storage.ghostScanners.length) {
            storage.updateIndex = 0;
            storage.updateTimeout = true;
        } else {
            UpdateSensor(storage.ghostScanners[storage.updateIndex]);
            ++storage.updateIndex;
        }
    }

    UpdateArea();
};

const OnNthTick = () => {
    storage.updateTimeout = false;
};

function UpdateEventHandlers() {
    script.on_event(defines.events.on_tick, undefined);
    const entityCount = storage.ghostScanners.length;
    if (entityCount > 0) {
        script.on_event(defines.events.on_tick, OnTick);
        script.on_nth_tick(math.floor(updateInterval + 1), OnNthTick);
        script.on_event(defines.events.on_pre_player_mined_item, OnEntityRemoved);
        script.on_event(defines.events.on_robot_pre_mined, OnEntityRemoved);
        script.on_event(defines.events.on_entity_died, OnEntityRemoved);
        script.on_event(defines.events.script_raised_destroy, OnEntityRemoved);
    } else {
        script.on_event(defines.events.on_pre_player_mined_item, undefined);
        script.on_event(defines.events.on_robot_pre_mined, undefined);
        script.on_event(defines.events.on_entity_died, undefined);
        script.on_event(defines.events.script_raised_destroy, undefined);
    }
}

const InitStorage = () => {
    ModLog("Initializing Storage");
    storage.initMod = storage.initMod || false;
    storage.scanSignals = new LuaMap<UnitNumber, GhostsAsSignals>();
    storage.updateTimeout = storage.updateTimeout || false;
    storage.ghostScanners = storage.ghostScanners || [];
    storage.scanAreas = new LuaMap<UnitNumber, ScanArea>();
    storage.updateIndex = storage.updateIndex || 0;
    storage.signalIndexes =
        storage.signalIndexes || new LuaMap<UnitNumber, LuaMap<string, SignalFilter>>();
    storage.foundEntities =
        storage.foundEntities || new LuaMap<UnitNumber, LuaSet<UnitNumber | string>>();
    storage.proxyRegistrations = new LuaMap<UnitNumber, LuaNotificationQueue>();
    storage.logisticGroups = storage.logisticGroups || new LuaMap<UnitNumber, string>();
    storage.pinnedGroups = storage.pinnedGroups || new LuaSet<UnitNumber>();
    storage.lookupItemsToPlaceThis = new LuaMap<string, ItemToPlace[]>();
};

// Reading a scanner from outside the mod. missing_items is also how the alerting is
// tested: alerts themselves only exist for connected players.
remote.add_interface("seance", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    missing_items: (unitNumber: UnitNumber): MissingItem[] => {
        for (const scanner of storage.ghostScanners) {
            if (scanner.id == unitNumber) {
                return CollectMissingItems(scanner);
            }
        }

        return [];
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logistic_group: (unitNumber: UnitNumber): string | undefined =>
        storage.logisticGroups.get(unitNumber)
});

script.on_load(() => {
    InitEvents();
});

script.on_init(() => {
    ModLog("On Init");
    InitStorage();
    storage.storageVersion = StorageVersion;
    InitMod();
    InitEvents();
});

script.on_configuration_changed(() => {
    ModLog("Config changed");
    InitStorage();
    MigrateStorage();
    InitEvents();
});
