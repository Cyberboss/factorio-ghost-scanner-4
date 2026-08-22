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

interface Storage {
    lookupItemsToPlaceThis: LuaMap<string, ItemToPlace[]>;
    ghostScanners: GhostScanner[];
    scanSignals: LuaMap<UnitNumber, LogisticFilterWrite[]>;
    signalIndexes: LuaMap<UnitNumber, LuaMap<string, number>>;
    scanAreas: LuaMap<UnitNumber, ScanArea>;
    // entities are keyed by unit number; cliffs and item request proxies have none,
    // so they are keyed by prefixed strings that cannot collide with a unit number
    foundEntities: LuaMap<UnitNumber, LuaSet<UnitNumber | string>>;
    proxyRegistrations: LuaMap<UnitNumber, LuaNotificationQueue>;
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
// output directly. The name is keyed on the scanner's unit number so that it stays
// stable for the life of the combinator: a player who selects it on a chest keeps
// pointing at the same scanner even if the network is renamed or renumbered.
const LogisticGroupName = (id: UnitNumber) => `Ghost Scanner ${id}`;

const ApplyLogisticGroup = (force: LuaForce, id: UnitNumber, section: LuaLogisticSection) => {
    const name = LogisticGroupName(id);
    if (publishLogisticGroup) {
        if (section.group != name) {
            force.create_logistic_group(name);
            section.group = name;
        }
    } else if (section.group == name) {
        section.group = "";
    }
};

const DeleteLogisticGroup = (force: LuaForce, id: UnitNumber) => {
    force.delete_logistic_group(LogisticGroupName(id));
};

const MaxAlertsPerScanner = 5;

const AlertMissingItems = (ghostScanner: GhostScanner, signalsForCombinator: GhostsAsSignals) => {
    const entity = ghostScanner.entity;
    const force = entity.force;
    force.remove_alert({ entity });

    const network = entity.surface.find_logistic_network_by_position(entity.position, force);
    if (!network) {
        return;
    }

    const networkName = network.custom_name != "" ? network.custom_name : `${network.network_id}`;

    let alerts = 0;
    for (const signal of signalsForCombinator) {
        if (alerts >= MaxAlertsPerScanner) {
            break;
        }

        const filter = signal.value! as {
            readonly name: string;
            readonly quality?: QualityID;
        };
        const needed = math.abs(signal.min!);
        if (needed == 0) {
            continue;
        }

        const available = network.get_item_count({
            name: filter.name,
            quality: filter.quality ?? "normal"
        });

        if (available < needed) {
            force.add_custom_alert(
                entity,
                { type: "item", name: filter.name, quality: filter.quality },
                ["ghost-scanner.alert-missing", filter.name, needed - available, networkName],
                true
            );
            ++alerts;
        }
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

        entity.operable = false;

        storage.ghostScanners.push({
            id: entity.unit_number!,
            entity: entity
        });

        UpdateEventHandlers();
    }
};

const OnEntityRemoved = (
    event: OnPrePlayerMinedItemEvent | OnRobotPreMinedEvent | OnEntityDiedEvent
) => {
    const entity = event.entity;
    if (entity.name == ScannerName) {
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

const ClearCombinator = (controlBehavior: LuaConstantCombinatorControlBehavior) => {
    if (controlBehavior.sections_count != 1) {
        ModLog("Cleaning scanner");
        for (let i = 1; i <= controlBehavior.sections_count; ++i) {
            controlBehavior.remove_section(1);
        }

        controlBehavior.add_section()!.filters = [];
    } else {
        controlBehavior.get_section(1)!.filters = [];
    }
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
                    const controlBehavior =
                        ghostScanner.entity.get_control_behavior() as LuaConstantCombinatorControlBehavior;

                    ClearCombinator(controlBehavior);
                    const section = controlBehavior.get_section(1)!;
                    ApplyLogisticGroup(ghostScanner.entity.force, id, section);

                    const signalsForCombinator = storage.scanSignals.get(id);
                    if (signalsForCombinator && signalsForCombinator.length > 0) {
                        ModLog(`Setting filters for scanner ${id}`);
                        section.filters = signalsForCombinator;
                    } else {
                        ModLog(`No filters for scanner ${id}`);
                    }

                    if (alertMissingItems) {
                        AlertMissingItems(ghostScanner, signalsForCombinator || []);
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
    const controlBehavior =
        ghostScanner.entity.get_control_behavior() as LuaConstantCombinatorControlBehavior;
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
            entity.operable = false;
            storage.ghostScanners.push({
                id: entity.unit_number!,
                entity: entity
            });
        }
    }

    storage.initMod = true;
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
    } else {
        script.on_event(defines.events.on_pre_player_mined_item, undefined);
        script.on_event(defines.events.on_robot_pre_mined, undefined);
        script.on_event(defines.events.on_entity_died, undefined);
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
    storage.lookupItemsToPlaceThis = new LuaMap<string, ItemToPlace[]>();
};

script.on_load(() => {
    InitEvents();
});

script.on_init(() => {
    ModLog("On Init");
    InitStorage();
    InitMod();
    InitEvents();
});

script.on_configuration_changed(() => {
    ModLog("Config changed");
    InitStorage();
    InitEvents();
});
