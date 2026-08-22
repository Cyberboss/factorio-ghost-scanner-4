-- Headless acceptance tests for Séance.
--
-- One world is built for every scenario; the scenario picked by the seance-test-scenario
-- setting decides which sequence of steps runs against it. Steps advance one per scan
-- cycle. Note that on_nth_tick fires at tick 0 too, so step 1 is only a warm up: the mod
-- needs a cycle between an action and the assertion about it.
--
-- Runs with no player connected, so anything needing a client (map alerts) is out of
-- scope here.

-- raw counts, before the output shaping settings are applied
local EXPECTED = {
    ["cliff-explosives"] = 1, -- cliff covered by BOTH roboports, must count once
    ["transport-belt"] = 2, -- two ghosts of the same item, must be summed
    ["fast-transport-belt"] = 1, -- upgrade order, reports the target item
    ["assembling-machine-2"] = 1,
    ["speed-module"] = 2, -- item request proxy
    ["concrete"] = 1 -- tile ghost, must be an item signal, not virtual
}

-- same item, other qualities: these must stay separate signals
local EXPECTED_QUALITY = {
    ["transport-belt/rare"] = 1,
    ["fast-inserter/uncommon"] = 1
}

local failures = 0
local checks = 0

local function check(ok, fmt, ...)
    local line = string.format(fmt, ...)
    checks = checks + 1
    if not ok then
        failures = failures + 1
        log("SEANCE   FAIL " .. line)
    else
        log("SEANCE   ok   " .. line)
    end
    return ok
end

local function scenario()
    return settings.global["seance-test-scenario"].value
end

local function publishing()
    return settings.global["ghost-scanner-logistic-group"].value
end

local function scanner()
    return game.surfaces[1].find_entities_filtered{name = "ghost-scanner"}[1]
end

local function group(entity)
    return entity.get_control_behavior().get_section(1).group
end

local function networkAt(pos)
    return game.surfaces[1].find_logistic_network_by_position(pos, game.forces.player)
end

local function roboport(x, y)
    local rp = game.surfaces[1].create_entity{
        name = "roboport", position = {x, y or 0}, force = game.forces.player
    }
    rp.energy = 100000000
    return rp
end

-- What the mod should output for a raw count, once the output shaping settings have had
-- their say. Mirrors the mod deliberately: the raw numbers are asserted by the default
-- run, these two settings only reshape them.
local function shaped(name, count)
    local value = settings.global["ghost-scanner-negative-output"].value and -count or count
    if settings.global["ghost-scanner-round2stack"].value then
        local stack = prototypes.item[name].stack_size
        local round = value < 0 and math.floor or math.ceil
        value = round(value / stack) * stack
    end
    return value
end

local function readSignals()
    local sc = scanner()
    if not sc then
        return nil
    end

    local out = {}
    local cb = sc.get_control_behavior()
    for i = 1, cb.sections_count do
        for _, filter in pairs(cb.get_section(i).filters) do
            if filter.value then
                local key = filter.value.name .. "/" .. (filter.value.quality or "nil")
                out[key] = (out[key] or 0) + filter.min
            end
        end
    end

    return out
end

-- asserts the full expected signal set, with `extra` merged in (raw counts)
local function checkSignals(label, extra)
    local signals = readSignals()
    if not check(signals ~= nil, "%s: scanner exists and has a control behavior", label) then
        return
    end
    if not signals then
        return
    end

    local want = {}
    for name, count in pairs(EXPECTED) do
        want[name .. "/normal"] = shaped(name, count)
    end
    for key, count in pairs(EXPECTED_QUALITY) do
        want[key] = shaped(string.match(key, "^[^/]+"), count)
    end
    for name, count in pairs(extra or {}) do
        want[name .. "/normal"] = shaped(name, count)
    end

    local wrong = {}
    for key, value in pairs(want) do
        if signals[key] ~= value then
            table.insert(wrong, string.format("%s=%s want %s", key, tostring(signals[key]), tostring(value)))
        end
    end
    for key, value in pairs(signals) do
        if want[key] == nil then
            table.insert(wrong, string.format("%s=%d unexpected", key, value))
        end
    end

    local shown = {}
    for key, value in pairs(signals) do
        table.insert(shown, string.format("%s=%s", key, tostring(value)))
    end
    table.sort(shown)
    log(string.format("SEANCE   .... %s: [%s]", label, table.concat(shown, " ")))

    check(#wrong == 0, "%s: signals match (%s)", label,
        #wrong == 0 and "all" or table.concat(wrong, "; "))
end

script.on_init(function()
    local s = game.surfaces[1]
    local f = game.forces.player
    f.research_all_technologies()
    s.request_to_generate_chunks({150, 0}, 12)
    s.force_generate_chunk_requests()
    for _, e in pairs(s.find_entities_filtered{area = {{-80, -80}, {380, 80}}}) do
        if e.type ~= "character" then
            e.destroy()
        end
    end

    -- power, so the roboports actually form a logistic network
    local eei = s.create_entity{name = "electric-energy-interface", position = {-10, 0}, force = f}
    eei.power_production = 10000000
    s.create_entity{name = "substation", position = {-5, 0}, force = f}

    -- two roboports with overlapping construction areas, to exercise dedup
    roboport(0)
    roboport(20)

    storage.chest = s.create_entity{name = "requester-chest", position = {2.5, 2.5}, force = f}
    s.create_entity{name = "ghost-scanner", position = {3, 3}, force = f, raise_built = true}

    -- the things the scanner is supposed to notice
    s.create_entity{name = "entity-ghost", inner_name = "transport-belt", position = {5.5, 5.5}, force = f}
    s.create_entity{name = "entity-ghost", inner_name = "transport-belt", position = {5.5, 6.5}, force = f}
    s.create_entity{name = "entity-ghost", inner_name = "transport-belt", position = {7.5, 6.5}, force = f, quality = "rare"}
    s.create_entity{name = "entity-ghost", inner_name = "fast-inserter", position = {9.5, 6.5}, force = f, quality = "uncommon"}
    s.create_entity{name = "entity-ghost", inner_name = "assembling-machine-2", position = {8.5, 8.5}, force = f}
    s.create_entity{name = "tile-ghost", inner_name = "concrete", position = {2.5, 6.5}, force = f}

    local cliff = s.create_entity{name = "cliff", position = {10, 10}, cliff_orientation = "west-to-east"}
    cliff.order_deconstruction(f)

    local belt = s.create_entity{name = "transport-belt", position = {6.5, 2.5}, force = f}
    belt.order_upgrade{force = f, target = "fast-transport-belt"}

    local am = s.create_entity{name = "assembling-machine-2", position = {12.5, 12.5}, force = f}
    s.create_entity{
        name = "item-request-proxy", target = am, force = f, position = am.position,
        modules = {{id = {name = "speed-module"}, items = {in_inventory = {{inventory = defines.inventory.crafter_modules, stack = 0, count = 2}}}}}
    }

    -- a second network far away, deliberately given the SAME name. A split leaves
    -- exactly this situation: two networks both answering to "Outpost Foo".
    local fareei = s.create_entity{name = "electric-energy-interface", position = {290, 0}, force = f}
    fareei.power_production = 10000000
    s.create_entity{name = "substation", position = {295, 0}, force = f}
    roboport(300)
    storage.far = s.create_entity{name = "ghost-scanner", position = {303, 3}, force = f, raise_built = true}
    s.create_entity{name = "entity-ghost", inner_name = "iron-chest", position = {305.5, 5.5}, force = f}

    networkAt({0, 0}).custom_name = "Outpost Foo"
    networkAt({300, 0}).custom_name = "Outpost Foo"
end)

local scenarios = {}

-- signal correctness, and the settings that reshape the numbers
scenarios.signals = {
    function()
        checkSignals("baseline")
        check(scanner().operable, "scanner can be opened in normal play")
        if not publishing() then
            check(#game.forces.player.get_logistic_groups() == 0,
                "no logistic group is published when the setting is off")
        end
        return "done"
    end
}

-- naming, renaming and the collision between identically named networks
scenarios.groups = {
    function()
        local sc = scanner()
        checkSignals("baseline")
        check(group(sc) == "Construction Requests for Outpost Foo",
            "group derived from the network name (got %q)", group(sc))

        -- the far network answers to the same name. Only one scanner may own it, and it
        -- has to be the same one after every reload, so the lowest unit number wins.
        check(group(storage.far) == "Séance " .. storage.far.unit_number,
            "scanner in an identically named network kept its own group (got %q)", group(storage.far))

        local secs = storage.chest.get_logistic_sections()
        local csec
        for i = 1, secs.sections_count do
            if secs.get_section(i).group == group(sc) then csec = secs.get_section(i) end
        end
        if not csec then csec = secs.add_section(group(sc)) end
        local n = 0
        for _ in pairs(csec.filters) do n = n + 1 end
        check(n > 0, "requester chest joined to the group sees %d filters", n)

        storage.oldGroup = group(sc)
        networkAt({0, 0}).custom_name = "Outpost Bar"
    end,
    function()
        local sc = scanner()
        check(group(sc) == "Construction Requests for Outpost Bar",
            "group followed the network rename (got %q)", group(sc))
        storage.oldGroup = group(sc)
        sc.get_control_behavior().get_section(1).group = "Outpost Foo Requests"
    end,
    function()
        local sc = scanner()
        check(group(sc) == "Outpost Foo Requests", "typed name stuck (got %q)", group(sc))
        check(game.forces.player.get_logistic_group(storage.oldGroup) == nil,
            "the derived group it replaced is gone (%s)", storage.oldGroup)

        local pinned = game.forces.player.get_logistic_group("Outpost Foo Requests")
        local n = 0
        for _ in pairs(pinned and pinned.filters or {}) do n = n + 1 end
        check(n > 0, "pinned group is still fed by the scanner (%d filters)", n)

        -- the far network is still called "Outpost Foo", so now that nothing answers to
        -- the derived name, the scanner that was blocked on it takes it over
        check(group(storage.far) == "Construction Requests for Outpost Foo",
            "the freed name was taken over by the other network's scanner (got %q)", group(storage.far))

        networkAt({0, 0}).custom_name = "Outpost Baz"
    end,
    function()
        check(group(scanner()) == "Outpost Foo Requests",
            "a typed name is not moved by a later network rename (got %q)", group(scanner()))
        return "done"
    end
}

-- what happens to a scanner when its logistic network merges with another and splits again
scenarios.topology = {
    function()
        checkSignals("before the merge")
        check(networkAt({0, 0}).network_id ~= networkAt({300, 0}).network_id,
            "the two networks start out separate")

        -- bridge the gap; roboports link when their logistic areas overlap, ~50 tiles
        storage.bridge = {}
        for x = 60, 260, 40 do
            table.insert(storage.bridge, roboport(x))
        end
    end,
    function()
        check(networkAt({0, 0}).network_id == networkAt({300, 0}).network_id,
            "the networks merged into one")
        -- the far network's ghost is now inside the scanner's own network
        checkSignals("after the merge", {["iron-chest"] = 1})
    end,
    function()
        for _, rp in pairs(storage.bridge) do
            rp.destroy()
        end
    end,
    function()
        check(networkAt({0, 0}).network_id ~= networkAt({300, 0}).network_id,
            "the networks split apart again")
        checkSignals("after the split")
        return "done"
    end
}

-- turning the combinator off, and removal by another mod's script
scenarios.lifecycle = {
    function()
        checkSignals("while enabled")
        scanner().get_control_behavior().enabled = false
    end,
    function()
        local sc = scanner()
        local cb = sc.get_control_behavior()
        local n = 0
        for i = 1, cb.sections_count do
            n = n + cb.get_section(i).filters_count
        end
        check(n == 0, "a disabled scanner publishes nothing (%d filters left)", n)
        cb.enabled = true
    end,
    function()
        checkSignals("after being switched back on")
        storage.far.destroy{raise_destroy = true}
        storage.destroyedName = "Séance " .. storage.farId
    end,
    function()
        -- script_raised_destroy has to be handled like a mined or killed scanner,
        -- otherwise its force wide group outlives it
        local leftover = {}
        for _, g in pairs(game.forces.player.get_logistic_groups()) do
            if g == storage.destroyedName then table.insert(leftover, g) end
        end
        check(#leftover == 0,
            "a scanner destroyed by script takes its group with it (found [%s])",
            table.concat(leftover, ", "))
        return "done"
    end
}

script.on_nth_tick(300, function()
    if storage.finished then
        return
    end

    storage.step = (storage.step or 0) + 1
    if storage.step == 1 then
        storage.farId = storage.far.unit_number
        log(string.format("SEANCE scenario=%s publishing=%s invert=%s stacks=%s",
            scenario(), tostring(publishing()),
            tostring(settings.global["ghost-scanner-negative-output"].value),
            tostring(settings.global["ghost-scanner-round2stack"].value)))
        return
    end

    local steps = scenarios[scenario()]
    local step = steps[storage.step - 1]
    if not step then
        return
    end

    if step() == "done" then
        storage.finished = true
        log(string.format("SEANCE RESULT %s (%d checks, %d failure(s))",
            failures == 0 and "PASS" or "FAIL", checks, failures))
    end
end)
