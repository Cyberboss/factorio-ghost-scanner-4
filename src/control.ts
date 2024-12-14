import {
    BoundingBox,
    ComparatorString,
    ItemStackDefinition,
    LogisticFilterWrite,
    LuaConstantCombinatorControlBehavior,
    LuaEntity,
    LuaEntityPrototype,
    LuaForce,
    LuaLogisticCell,
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
    uint64,
    UnitNumber
} from "factorio:runtime";

import {
    AreasPerTickSetting,
    MaxResultsSetting,
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
    lookupItemsToPlaceThis: LuaMap<string, ItemStackDefinition[]>;
    ghostScanners: GhostScanner[];
    scanSignals: LuaMap<UnitNumber, LogisticFilterWrite[]>;
    signalIndexes: LuaMap<UnitNumber, LuaMap<string, number>>;
    scanAreas: LuaMap<UnitNumber, ScanArea>;
    foundEntities: LuaMap<
        UnitNumber,
        LuaSet<UnitNumber | MapPosition | LuaMultiReturn<[uint64, uint64, defines.target_type]>>
    >;
    updateTimeout: boolean;
    updateIndex: number;
    initMod: boolean;
}

declare const storage: Storage;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ModLog = (message: string) => {
    // uncomment to debug
    //game.print(message);
    //log(message);
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
            storage.lookupItemsToPlaceThis = new LuaMap<string, ItemStackDefinition[]>();
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
    }

    if (updateEventHandlers) {
        UpdateEventHandlers();
    }
});

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
        RemoveSensor(entity.unit_number!);
    }
};

const CleanUp = (id: UnitNumber) => {
    storage.scanSignals.delete(id);
    storage.signalIndexes.delete(id);
    storage.scanAreas.delete(id);
    storage.foundEntities.delete(id);
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
    if (controlBehavior.sections_count != 0) {
        ModLog("Cleaning scanner");
        for (let i = 1; i <= controlBehavior.sections_count; ++i) {
            controlBehavior.remove_section(1);
        }
    }
};

const UpdateArea = () => {
    if (!storage.scanAreas) {
        ModLog("No scan areas, no area update");
        return;
    }

    let num = 1;
    for (const [id, cells] of storage.scanAreas) {
        ModLog(`Update scanner ${id}`);
        const tempAreas = [];
        if (cells && cells.cells && cells.cells.length > 0) {
            const force = cells.force;
            for (const cell of cells.cells) {
                if (num < scanAreasPerTick) {
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

            for (let j = storage.ghostScanners.length - 1; j >= 0; --j) {
                const ghostScanner = storage.ghostScanners[j];
                if (id == ghostScanner.id) {
                    const controlBehavior =
                        ghostScanner.entity.get_control_behavior() as LuaConstantCombinatorControlBehavior;

                    ClearCombinator(controlBehavior);
                    const signalsForCombinator = storage.scanSignals.get(id);
                    if (signalsForCombinator && signalsForCombinator.length > 0) {
                        ModLog(`Setting filters for scanner ${id}`);
                        const section = controlBehavior.add_section()!;
                        section.filters = signalsForCombinator;
                    } else {
                        ModLog(`No filters for scanner ${id}`);
                    }

                    break;
                }

                if (j == 0) {
                    ModLog(`Error: Did not find scanner with ID ${id}`);
                    CleanUp(id);
                }
            }

            if (tempAreas.length > 0) {
                storage.scanAreas.get(id)!.cells = [...tempAreas];
                break;
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
        const itemsToPlaceFiltered: ItemStackDefinition[] = [];
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
    let signalIndex = indexesForID.get(name);

    let s: LogisticFilterWrite;
    if (signalIndex && signals![signalIndex]) {
        s = signals![signalIndex];
    } else {
        signalIndex = signals!.length;
        indexesForID.set(name, signalIndex);
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
        foundEntities = new LuaSet<
            UnitNumber | MapPosition | LuaMultiReturn<[uint64, uint64, defines.target_type]>
        >();
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
        const uid = e.unit_number || e.position;
        if (
            !foundEntities.has(uid) &&
            e.to_be_deconstructed() &&
            e.is_registered_for_deconstruction(force) &&
            e.prototype.cliff_explosive_prototype
        ) {
            foundEntities.add(uid);
            AddSignal(id, e.prototype.cliff_explosive_prototype, 1);
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
        for (const e of entities) {
            const uid = script.register_on_object_destroyed(e);
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
                    AddSignal(id, itemStack.name, count, itemStack.quality);
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
            ModLog("Combinator has no logi-network!");
            ClearCombinator(controlBehavior);
            CleanUp(ghostScanner.id);
            return;
        }

        ModLog(
            `Adding loginet ID ${logisticNetwork.network_id} from combinator ${ghostScanner.id}`
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
        storage.foundEntities ||
        new LuaMap<
            UnitNumber,
            LuaSet<UnitNumber | MapPosition | LuaMultiReturn<[uint64, uint64, defines.target_type]>>
        >();
    storage.lookupItemsToPlaceThis = new LuaMap<string, ItemStackDefinition[]>();
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
