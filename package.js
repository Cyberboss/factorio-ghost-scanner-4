import Info from "./public/info.json";

const fs = require("fs");
const archiver = require("archiver");

Info.version;

const packageName = `${Info.name}_${Info.version}`;

const output = fs.createWriteStream(`${packageName}.zip`);

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
