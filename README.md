# factorio-ghost-scanner-4

Originally based on https://github.com/Tiavor/GhostScanner2.

Ported to typescript for (my) ease of development.

Please open an issue if you have a problem.

## Development

You'll need a node 22+ environment setup. VSCode is the recommended IDE.

Run `corepack enable` to ensure you're using the correct yarn version.

Run `yarn` to install dependencies like the typescript-to-lua compiler and typed-factorio definitions.

Run `yarn build` to build the mod `.zip` in the `build/` directory.

Run `yarn install_mod` to build and copy the mod to `~/AppData/Roaming/Factorio/mods`.

### Performance

This is a rough 1-to-1 port of GhostScanner2. In writing it, I've come to realize that there's a big opportunity for performance improvements if, instead of scanning for ghosts/related entities, the control script was reworked to be purely event driven when ghosts are created/built/deleted and scan only when logistic areas are created/updated/deleted.
