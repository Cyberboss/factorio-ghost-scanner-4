import Info from "./build/info.json" with { type: "json" };

import * as fs from "fs";
import archiver from "archiver";

const packageName = `${Info.name}_${Info.version}`;

const output = fs.createWriteStream(`build/${packageName}.zip`);

const archive = archiver("zip", {
    zlib: { level: 9 } // Sets the compression level.
});

archive.on("warning", function (err) {
    if (err.code === "ENOENT") {
        // log warning
    } else {
        // throw error
        throw err;
    }
});

archive.on("error", function (err) {
    throw err;
});

// pipe archive data to the file
archive.pipe(output);
archive.directory("build/", packageName);
archive.finalize();
