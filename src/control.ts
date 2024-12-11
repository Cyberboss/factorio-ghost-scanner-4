import {
    BoundingBox,
    ItemStackDefinition,
    LogisticFilter,
    LuaConstantCombinatorControlBehavior,
    LuaEntity,
    LuaEntityPrototype,
    LuaForce,
    LuaLogisticCell,
    MapPosition,
    NthTickEventData,
    OnBuiltEntityEvent,
    OnEntityDiedEvent,
    OnPrePlayerMinedItemEvent,
    OnRobotBuiltEntityEvent,
    OnRobotPreMinedEvent,
    OnTickEvent,
    ScriptRaisedBuiltEvent,
    ScriptRaisedReviveEvent,
    SignalFilter,
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

interface Signal {
    signal: SignalFilter;
}

type GhostsAsSignals = LuaMap<SignalFilter, LogisticFilter>;

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
    scanSignals: LuaMap<UnitNumber, GhostsAsSignals>;
    signalIndexes: LuaMap<UnitNumber, LuaMap<string, SignalFilter>>;
    scanAreas: LuaMap<UnitNumber, ScanArea>;
    foundEntities: LuaMap<UnitNumber, LuaSet<UnitNumber | MapPosition>>;
    updateTimeout: boolean;
    updateIndex: number;
    initMod: boolean;
}

declare const storage: Storage;

const ScannerName = "ghost-scanner";

let scanAreasPerTick = settings.global[AreasPerTickSetting].value as number;
let updateInteval = settings.global[UpdateIntervalSetting].value as number;
let scanAreasDelay = settings.global[ScanAreasDelaySetting].value as number;
let maxResults: number | undefined = settings.global[MaxResultsSetting].value as number;

if (maxResults == 0) {
    maxResults = undefined;
}

let showHidden = settings.global[ShowHiddenSetting].value as boolean;
let invertSign = settings.global[NegativeOutputSetting].value as boolean;
let roundToStack = settings.global[RoundToStackSetting].value as boolean;

script.on_event(defines.events.on_runtime_mod_setting_changed, event => {
    let updateEventHandlers = false;

    switch (event.setting) {
        case UpdateIntervalSetting: {
            updateInteval = settings.global[UpdateIntervalSetting].value as number;
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
    // TODO: Combinator Clearing
    // control_behavior.parameters = nil
};

const UpdateArea = () => {
    if (!storage.scanAreas) {
        return;
    }

    let num = 1;
    for (const [id, cells] of storage.scanAreas) {
        let tempAreas = [];
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
                    const combinator_logistic_section = controlBehavior.get_section(1);

                    if (storage.scanSignals.has(id)) {
                        ClearCombinator(controlBehavior);
                    }

                    break;
                }

                if (j == 0) {
                    CleanUp(id);
                }
            }

            if (tempAreas.length > 0) {
                storage.scanAreas.get(id)!.cells = [...tempAreas];
                break;
            }

            storage.scanAreas.delete(id);
            storage.foundEntities.delete(id);
        }
    }
};

const GetItemsToPlace = (prototype: LuaEntityPrototype) => {
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
const AddSignal = (id: UnitNumber, name: string, count: number) => {
    const signalIndex = storage.signalIndexes.get(id)?.get(name);

    let s: LogisticFilter;
    if (signalIndex && signals!.has(signalIndex)) {
        s = signals!.get(signalIndex)!;
    } else {
        s = {
            value: {
                comparator: "=",
                type: "virtual",
                name
            },
            min: invertSign ? -count : count
        };
    }
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
        foundEntities = new LuaSet<UnitNumber | MapPosition>();
        storage.foundEntities.set(id, foundEntities);
    }

    signals = prev_entry;

    if (!signals) {
        signals = new LuaMap<SignalFilter, LogisticFilter>();
        storage.signalIndexes.set(id, new LuaMap<string, SignalFilter>());
    } else if (!storage.signalIndexes.has(id)) {
        storage.signalIndexes.set(id, new LuaMap<string, SignalFilter>());
    }

    if (!cell.valid) {
        return new LuaMap<SignalFilter, LogisticFilter>();
    }

    const pos = cell.owner.position;
    const r = cell.construction_radius;

    if (r <= 0) {
        let test: any = null;
        test!.asdf = 4;
    }

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
            const upgradePrototype = e.get_upgrade_target()[0];
            if (!foundEntities.has(uid) && upgradePrototype) {
                if (IsInBBox(e.position, searchArea.bounds)) {
                    foundEntities.add(uid);
                    const entityName = upgradePrototype.name;

                    for (const itemStack of storage.lookupItemsToPlaceThis?.get(
                        upgradePrototype.name
                    ) || GetItemsToPlace(upgradePrototype)) {
                        const itemStackCount = itemStack.count!;
                        AddSignal(id, itemStack.name, itemStackCount);
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
            type: "entity-ghost"
        });
        countUniqueEntities = 0;
        for (const e of entities) {
            const uid = e.unit_number!;
            if (!foundEntities.has(uid)) {
                if (IsInBBox(e.position, searchArea.bounds)) {
                    foundEntities.add(uid);
                    for (const itemStack of storage.lookupItemsToPlaceThis?.get(e.ghost_name) ||
                        GetItemsToPlace(e.ghost_prototype as LuaEntityPrototype)) {
                        const itemStackCount = itemStack.count!;
                        AddSignal(id, itemStack.name, itemStackCount);
                        countUniqueEntities -= itemStackCount;
                    }

                    for (const requestItem of e.item_requests) {
                        // TODO: Figure out if add signal needs quality or some shit
                    }
                }
            }
        }
    }
};

const UpdateSensor = (ghostScanner: GhostScanner) => {
    const controlBehavior =
        ghostScanner.entity.get_control_behavior() as LuaConstantCombinatorControlBehavior;
    if (!controlBehavior.enabled) {
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
            ClearCombinator(controlBehavior);
            CleanUp(ghostScanner.id);
            return;
        }

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
        return;
    }

    for (const [_, surface] of game.surfaces) {
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
        if (storage.updateIndex > storage.ghostScanners.length) {
            storage.updateIndex = 0;
            storage.updateTimeout = true;
        } else {
            UpdateSensor(storage.ghostScanners[storage.updateIndex]);
            ++storage.updateIndex;
        }
    }

    UpdateArea();
};

const OnNthTick = (event: NthTickEventData) => {
    storage.updateTimeout = false;
};

function UpdateEventHandlers() {
    script.on_event(defines.events.on_tick, undefined);
    const entityCount = storage.ghostScanners.length;
    if (entityCount > 0) {
        script.on_event(defines.events.on_tick, OnTick);
        script.on_nth_tick(math.floor(updateInteval + 1), OnNthTick);
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
    storage.initMod = false;
    storage.scanSignals = new LuaMap<UnitNumber, GhostsAsSignals>();
    storage.updateTimeout = storage.updateTimeout || false;
    storage.ghostScanners = storage.ghostScanners || [];
    storage.scanAreas = new LuaMap<UnitNumber, ScanArea>();
    storage.updateIndex = storage.updateIndex || 0;
    storage.signalIndexes =
        storage.signalIndexes || new LuaMap<UnitNumber, LuaMap<string, SignalFilter>>();
    storage.foundEntities = storage.foundEntities || new LuaMap<UnitNumber, any>();
    storage.lookupItemsToPlaceThis = new LuaMap<string, ItemStackDefinition[]>();
};

script.on_load(() => {
    InitStorage();
    InitMod();
    InitEvents();
});

script.on_configuration_changed(() => {
    InitStorage();
    InitEvents();
});
