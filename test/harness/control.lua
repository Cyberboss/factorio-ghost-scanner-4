-- Headless acceptance test for Ghost Scanner 4.
--
-- Builds a known layout, lets the mod scan it, and compares the combinator output
-- against an expected signal set. Runs with no player connected, so anything that
-- needs a client (map alerts) is out of scope here.

local EXPECTED = {
    ["cliff-explosives/normal"] = 1, -- cliff covered by BOTH roboports, must count once
    ["transport-belt/normal"] = 2, -- two ghosts of the same item, must be summed
    ["transport-belt/rare"] = 1, -- same item, different quality, must stay separate
    ["fast-inserter/uncommon"] = 1,
    ["fast-transport-belt/normal"] = 1, -- upgrade order, reports the target item
    ["assembling-machine-2/normal"] = 1,
    ["speed-module/normal"] = 2, -- item request proxy
    ["concrete/normal"] = 1 -- tile ghost, must be an item signal, not virtual
}

local failures = 0

local function check(ok, fmt, ...)
    local line = string.format(fmt, ...)
    if not ok then
        failures = failures + 1
        log("GS4TEST   FAIL " .. line)
    else
        log("GS4TEST   ok   " .. line)
    end
end

local function scanner()
    return game.surfaces[1].find_entities_filtered{name = "ghost-scanner"}[1]
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

local function group(entity)
    return entity.get_control_behavior().get_section(1).group
end

local function networkAt(pos)
    return game.surfaces[1].find_logistic_network_by_position(pos, game.forces.player)
end

script.on_init(function()
    local s = game.surfaces[1]
    local f = game.forces.player
    f.research_all_technologies()
    for _, e in pairs(s.find_entities_filtered{area = {{-60, -60}, {60, 60}}}) do
        if e.type ~= "character" then
            e.destroy()
        end
    end

    -- power, so the roboports actually form a logistic network
    local eei = s.create_entity{name = "electric-energy-interface", position = {-10, 0}, force = f}
    eei.power_production = 10000000
    s.create_entity{name = "substation", position = {-5, 0}, force = f}

    -- two roboports with overlapping construction areas, to exercise dedup
    for _, pos in pairs({{0, 0}, {20, 0}}) do
        local rp = s.create_entity{name = "roboport", position = pos, force = f}
        rp.energy = 100000000
    end

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

    -- a second network far away, named the same as the first. A split leaves exactly
    -- this situation: two networks both answering to "Outpost Foo".
    s.request_to_generate_chunks({300, 0}, 4)
    s.force_generate_chunk_requests()
    local fareei = s.create_entity{name = "electric-energy-interface", position = {290, 0}, force = f}
    fareei.power_production = 10000000
    s.create_entity{name = "substation", position = {295, 0}, force = f}
    local far = s.create_entity{name = "roboport", position = {300, 0}, force = f}
    far.energy = 100000000
    storage.far = s.create_entity{name = "ghost-scanner", position = {303, 3}, force = f, raise_built = true}
    s.create_entity{name = "entity-ghost", inner_name = "iron-chest", position = {305.5, 5.5}, force = f}

    networkAt({0, 0}).custom_name = "Outpost Foo"
    networkAt({300, 0}).custom_name = "Outpost Foo"

    local am = s.create_entity{name = "assembling-machine-2", position = {12.5, 12.5}, force = f}
    s.create_entity{
        name = "item-request-proxy", target = am, force = f, position = am.position,
        modules = {{id = {name = "speed-module"}, items = {in_inventory = {{inventory = defines.inventory.crafter_modules, stack = 0, count = 2}}}}}
    }
end)

-- give the mod a few scan cycles, then assert
-- One step per scan cycle. Note that on_nth_tick fires at tick 0 as well, so the first
-- step is only a warm up: the mod needs a cycle between an action and its assertion.
script.on_nth_tick(300, function()
    if storage.killed then
        return
    end

    storage.step = (storage.step or 0) + 1
    local groupsOn = settings.global["ghost-scanner-logistic-group"].value
    local sc = scanner()

    if storage.step == 1 then
        log(string.format("GS4TEST logistic group setting = %s", tostring(groupsOn)))
        return
    end

    if storage.step == 2 then
        local signals = readSignals()
        check(signals ~= nil, "scanner exists and has a control behavior")
        if signals then
            for key, want in pairs(EXPECTED) do
                check(signals[key] == want, "%s = %s (expected %s)", key, tostring(signals[key]), tostring(want))
            end
            for key, got in pairs(signals) do
                if not EXPECTED[key] then
                    check(false, "unexpected signal %s = %d", key, got)
                end
            end
        end

        check(sc.operable, "scanner can be opened in normal play")

        if not groupsOn then
            check(#game.forces.player.get_logistic_groups() == 0,
                "no logistic group is published when the setting is off")
            sc.die()
            storage.far.die()
            storage.killed = true
            return
        end

        -- the name comes from the logistic network the scanner sits in
        check(group(sc) == "Construction Requests for Outpost Foo",
            "group derived from the network name (got %q)", group(sc))

        -- the far network answers to the same name. Only one scanner may own it, and it
        -- has to be the same one after every reload, so the lowest unit number wins.
        check(group(storage.far) == "Ghost Scanner " .. storage.far.unit_number,
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

    elseif storage.step == 3 then
        check(group(sc) == "Construction Requests for Outpost Bar",
            "group followed the network rename (got %q)", group(sc))

        -- pin it by hand, the way a player would in the combinator GUI
        storage.oldGroup = group(sc)
        sc.get_control_behavior().get_section(1).group = "Outpost Foo Requests"

    elseif storage.step == 4 then
        check(group(sc) == "Outpost Foo Requests", "typed name stuck (got %q)", group(sc))
        check(game.forces.player.get_logistic_group(storage.oldGroup) == nil,
            "the derived group it replaced is gone (%s)", storage.oldGroup)

        local pinned = game.forces.player.get_logistic_group("Outpost Foo Requests")
        local n = 0
        for _ in pairs(pinned and pinned.filters or {}) do n = n + 1 end
        check(n > 0, "pinned group is still fed by the scanner (%d filters)", n)

        -- the far network is still called "Outpost Foo". Once the first scanner stopped
        -- answering to that name, the one that was blocked on it takes it over.
        check(group(storage.far) == "Construction Requests for Outpost Foo",
            "the freed name was taken over by the other network's scanner (got %q)",
            group(storage.far))

        networkAt({0, 0}).custom_name = "Outpost Baz"

    elseif storage.step == 5 then
        check(group(sc) == "Outpost Foo Requests",
            "a typed name is not moved by a later network rename (got %q)", group(sc))
        sc.die()
        storage.far.die()
        storage.killed = true
    end
end)

script.on_nth_tick(60, function()
    if not storage.killed or storage.reported then
        return
    end
    storage.reported = true

    local leftover = {}
    for _, g in pairs(game.forces.player.get_logistic_groups()) do
        table.insert(leftover, g)
    end
    check(#leftover == 0, "no logistic group left after the scanners died (found [%s])",
        table.concat(leftover, ", "))

    log(string.format("GS4TEST RESULT %s (%d failure(s))", failures == 0 and "PASS" or "FAIL", failures))
end)
